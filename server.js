const express = require("express");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const util = require("util");
const { execFile } = require("child_process");
const { requestContextMiddleware, sendError, asyncRoute } = require("./src/lib/response");
const { createApiError, ERROR_CODES } = require("./src/lib/errors");
const { schemas, validateBody, validateParams, validateQuery } = require("./src/lib/validators");
const { createTaskStore } = require("./src/state/task-store");
const { createTaskService } = require("./src/services/task.service");
const { createUsageAllRunner } = require("./src/services/usage.service");
const { createVerifyAllRunner } = require("./src/services/verification.service");
const { createLogAnalyzer } = require("./src/services/log-analyzer.service");
const { registerTaskRoutes } = require("./src/routes/tasks.routes");

const execFileAsync = util.promisify(execFile);

const ROOT_DIR = process.env.APP_ROOT || __dirname;
const AUTH_DIR = process.env.AUTH_DIR || path.join(ROOT_DIR, "auths");
const LOCAL_CONFIG_PATH = process.env.LOCAL_CONFIG_PATH || path.join(ROOT_DIR, "config.yaml");
const ACTIVE_CONFIG_PATH =
  process.env.ACTIVE_CONFIG_PATH || "/Users/liuxiaoyu/cliproxy-kit/config.yaml";
const DEFAULT_SERVICE_LOG_PATH = path.join(process.env.HOME || "", "Services", "logs", "cliproxy", "cliproxyapi.log");
const LOCAL_LOG_PATH =
  process.env.LOCAL_LOG_PATH ||
  (fsSync.existsSync(DEFAULT_SERVICE_LOG_PATH) ? DEFAULT_SERVICE_LOG_PATH : path.join(ROOT_DIR, "cliproxyapi.log"));
const SYNC_SCRIPT_PATH = process.env.SYNC_SCRIPT_PATH || path.join(ROOT_DIR, "sync_codex_auths.sh");
const CLIPROXY_BASE_URL = process.env.CLIPROXY_BASE_URL || "http://127.0.0.1:8317";
const CLIPROXY_SERVICE_NAME = process.env.CLIPROXY_SERVICE_NAME || "cliproxyapi";
const SERVICE_MANAGER = String(process.env.SERVICE_MANAGER || "launchctl").toLowerCase();
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8328);
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || "/Users/liuxiaoyu/.openclaw/openclaw.json";
const OPENCLAW_GATEWAY_LABEL = process.env.OPENCLAW_GATEWAY_LABEL || "ai.openclaw.gateway";
const OPENCLAW_NODE_LABEL = process.env.OPENCLAW_NODE_LABEL || "ai.openclaw.node";
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
const ACCOUNT_USAGE_CACHE_PATH =
  process.env.ACCOUNT_USAGE_CACHE_PATH || path.join(DATA_DIR, "account-usage-cache.json");
const USAGE_CACHE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.USAGE_CACHE_TTL_MS || 6 * 60 * 60 * 1000)
);

function envFlag(name, defaultValue = true) {
  const raw = process.env[name];
  if (typeof raw === "undefined" || raw === null || raw === "") {
    return Boolean(defaultValue);
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return Boolean(defaultValue);
}

function resolveProxyPort() {
  const fromEnv = Number(process.env.CLIPROXY_PORT || "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  try {
    const url = new URL(CLIPROXY_BASE_URL);
    const fromUrl = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    if (Number.isInteger(fromUrl) && fromUrl > 0) {
      return fromUrl;
    }
  } catch {
    // Keep fallback below.
  }
  return 8317;
}

const CLIPROXY_PORT = resolveProxyPort();
const CODEX_OAUTH_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_ENDPOINT = process.env.CODEX_TOKEN_ENDPOINT || "https://auth.openai.com/oauth/token";
const CODEX_USAGE_ENDPOINT = process.env.CODEX_USAGE_ENDPOINT || "https://chatgpt.com/backend-api/wham/usage";
const TASK_MODE_ENABLED = envFlag("TASK_MODE_ENABLED", true);
const RESPONSE_V2_ENABLED = envFlag("RESPONSE_V2_ENABLED", true);
const LOG_INCREMENTAL_ENABLED = envFlag("LOG_INCREMENTAL_ENABLED", true);
const SCHEMA_VALIDATION_ENABLED = envFlag("SCHEMA_VALIDATION_ENABLED", true);
const TASK_CONCURRENCY = Math.max(1, Math.min(Number(process.env.TASK_CONCURRENCY || 1), 2));
const LOG_CACHE_LINES = Math.max(100, Math.min(Number(process.env.LOG_CACHE_LINES || 500), 2000));

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(requestContextMiddleware());
app.use(express.static(path.join(ROOT_DIR, "web")));

const verificationWindows = [];

async function runCommand(command, args, timeoutMs = 120000) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env
  });
  return { stdout, stderr };
}

function redactYamlSecrets(yamlText) {
  const lines = yamlText.split("\n");
  let inApiKeysBlock = false;

  return lines
    .map((line) => {
      if (/^\s*api-keys:\s*$/.test(line)) {
        inApiKeysBlock = true;
        return line;
      }

      if (inApiKeysBlock) {
        if (/^\s*-\s*/.test(line)) {
          return line.replace(/-\s*.+$/, '- "<redacted>"');
        }
        if (/^\s*$/.test(line)) {
          return line;
        }
        if (!/^\s+/.test(line)) {
          inApiKeysBlock = false;
        }
      }

      return line
        .replace(/(access_token\s*:\s*).+/i, '$1"<redacted>"')
        .replace(/(refresh_token\s*:\s*).+/i, '$1"<redacted>"')
        .replace(/(id_token\s*:\s*).+/i, '$1"<redacted>"');
    })
    .join("\n");
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeFileSegment(value, fallback = "account") {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function formatIsoOffset(dateLike) {
  const value = new Date(dateLike);
  if (Number.isNaN(value.getTime())) {
    return "";
  }
  return value.toISOString().replace(".000Z", "+00:00");
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    throw new Error("invalid JWT token");
  }

  const payload = parts[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4 || 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(json);
}

function extractCodexAccountIdFromAccessToken(accessToken) {
  try {
    const payload = decodeJwtPayload(accessToken);
    const authData = payload?.["https://api.openai.com/auth"];
    const accountId = String(authData?.chatgpt_account_id || "").trim();
    return accountId || "";
  } catch {
    return "";
  }
}

function isJwtLikelyExpired(accessToken) {
  try {
    const payload = decodeJwtPayload(accessToken);
    const exp = Number(payload?.exp || 0);
    if (!Number.isFinite(exp) || exp <= 0) {
      return true;
    }
    return exp < Math.floor(Date.now() / 1000) + 60;
  } catch {
    return true;
  }
}

function parseFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value) {
  const n = parseFiniteNumber(value);
  if (n === null) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeWindowMinutes(windowSeconds) {
  const seconds = parseFiniteNumber(windowSeconds);
  if (seconds === null || seconds <= 0) {
    return null;
  }
  return Math.ceil(seconds / 60);
}

function normalizeResetEpoch(window) {
  const resetAt = parseFiniteNumber(window?.reset_at);
  if (resetAt !== null && resetAt > 0) {
    return Math.floor(resetAt);
  }
  const resetAfterSeconds = parseFiniteNumber(window?.reset_after_seconds);
  if (resetAfterSeconds === null || resetAfterSeconds < 0) {
    return null;
  }
  return Math.floor(Date.now() / 1000 + resetAfterSeconds);
}

function normalizeUsageWindow(window) {
  if (!window || typeof window !== "object") {
    return null;
  }

  const usedPercent = clampPercent(window.used_percent);
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const resetAt = normalizeResetEpoch(window);

  return {
    usedPercent,
    remainingPercent,
    windowMinutes: normalizeWindowMinutes(window.limit_window_seconds),
    resetAt,
    resetAtIso: resetAt ? new Date(resetAt * 1000).toISOString() : ""
  };
}

function summarizeCodexUsage(usage) {
  const primary = usage?.primaryWindow;
  const secondary = usage?.secondaryWindow;
  const parts = [];

  if (primary) {
    parts.push(
      `主窗口剩余 ${primary.remainingPercent ?? "-"}% / 已用 ${primary.usedPercent ?? "-"}% / 重置 ${primary.resetAtIso || "-"}`
    );
  } else {
    parts.push("主窗口: -");
  }

  if (secondary) {
    parts.push(
      `周窗口剩余 ${secondary.remainingPercent ?? "-"}% / 已用 ${secondary.usedPercent ?? "-"}% / 重置 ${secondary.resetAtIso || "-"}`
    );
  } else {
    parts.push("周窗口: -");
  }

  return parts.join(" | ");
}

function shouldForceCodexTokenRefresh(httpStatus, detail) {
  const normalized = String(detail || "").toLowerCase();
  return (
    Number(httpStatus) === 401 ||
    normalized.includes("token_invalidated") ||
    normalized.includes("your authentication token has been invalidated") ||
    normalized.includes("401 unauthorized")
  );
}

async function refreshCodexTokens(refreshToken) {
  const normalized = String(refreshToken || "").trim();
  if (!normalized) {
    throw new Error("missing refresh_token");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: normalized,
    client_id: CODEX_OAUTH_CLIENT_ID
  });

  const response = await fetch(CODEX_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  const rawText = await response.text();
  const payload = safeJsonParse(rawText);

  if (!response.ok) {
    const message = payload?.error_description || payload?.error || `token refresh failed: ${response.status}`;
    const error = new Error(String(message));
    error.httpStatus = response.status;
    throw error;
  }

  const accessToken = String(payload?.access_token || "").trim();
  const idToken = String(payload?.id_token || "").trim();
  const nextRefreshToken = String(payload?.refresh_token || normalized).trim();
  if (!accessToken || !idToken) {
    throw new Error("token refresh payload missing access_token or id_token");
  }

  return {
    accessToken,
    idToken,
    refreshToken: nextRefreshToken
  };
}

async function fetchCodexUsageOnce(accessToken, accountId = "") {
  const normalizedToken = String(accessToken || "").trim();
  if (!normalizedToken) {
    throw new Error("missing access_token");
  }

  const headers = {
    Authorization: `Bearer ${normalizedToken}`,
    Accept: "application/json"
  };
  const normalizedAccountId = String(accountId || "").trim();
  if (normalizedAccountId) {
    headers["ChatGPT-Account-Id"] = normalizedAccountId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(CODEX_USAGE_ENDPOINT, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    const rawText = await response.text();
    const payload = safeJsonParse(rawText);

    if (!response.ok) {
      const detailCode =
        payload?.detail?.code ||
        payload?.error?.code ||
        payload?.code ||
        "";
      const detailMessage =
        payload?.detail?.message ||
        payload?.error?.message ||
        payload?.message ||
        rawText.slice(0, 260);
      const message = String(detailCode ? `${detailMessage} [error_code:${detailCode}]` : detailMessage).trim();
      const error = new Error(message || `usage endpoint responded ${response.status}`);
      error.httpStatus = response.status;
      error.detail = message;
      throw error;
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("usage endpoint did not return valid JSON");
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeCodexUsagePayload(payload) {
  const rateLimit = payload?.rate_limit || {};
  const primaryWindow = normalizeUsageWindow(rateLimit?.primary_window);
  const secondaryWindow = normalizeUsageWindow(rateLimit?.secondary_window);
  return {
    planType: String(payload?.plan_type || "").trim(),
    primaryWindow,
    secondaryWindow,
    fiveHourRemainingPercent: primaryWindow?.remainingPercent ?? null,
    weeklyRemainingPercent: secondaryWindow?.remainingPercent ?? null,
    fiveHourUsedPercent: primaryWindow?.usedPercent ?? null,
    weeklyUsedPercent: secondaryWindow?.usedPercent ?? null
  };
}

function extractAccessTokenPayload(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) {
    throw new Error("missing token payload");
  }

  const directJwt = trimmed.match(/^["']?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["']?$/);
  if (directJwt) {
    return { accessToken: directJwt[1] };
  }

  const parsed = safeJsonParse(trimmed);
  if (parsed && typeof parsed === "object") {
    return {
      accessToken: String(parsed.accessToken || parsed.access_token || parsed.token || "").trim(),
      refreshToken: String(parsed.refreshToken || parsed.refresh_token || "").trim(),
      idToken: String(parsed.idToken || parsed.id_token || "").trim(),
      email: String(parsed.email || "").trim(),
      accountId: String(parsed.accountId || parsed.account_id || "").trim(),
      expired: String(parsed.expired || "").trim()
    };
  }

  const patterns = {
    accessToken: /"(?:accessToken|access_token|token)"\s*:\s*"([^"]+)"/,
    refreshToken: /"(?:refreshToken|refresh_token)"\s*:\s*"([^"]+)"/,
    idToken: /"(?:idToken|id_token)"\s*:\s*"([^"]+)"/,
    email: /"email"\s*:\s*"([^"]+)"/,
    accountId: /"(?:accountId|account_id)"\s*:\s*"([^"]+)"/,
    expired: /"expired"\s*:\s*"([^"]+)"/
  };

  const result = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = trimmed.match(pattern);
    if (match) {
      result[key] = match[1].trim();
    }
  }
  return result;
}

async function loadAuthAccountRecords() {
  let files = [];
  try {
    files = await fs.readdir(AUTH_DIR);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((name) => name.endsWith(".json")).sort();
  const records = [];

  for (const fileName of jsonFiles) {
    const absolutePath = path.join(AUTH_DIR, fileName);
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      const parsed = JSON.parse(raw);
      records.push({ fileName, absolutePath, parsed, raw });
    } catch {
      // Ignore unreadable files here; loadAuthAccounts already surfaces them for UI.
    }
  }

  return records;
}

async function loadAuthRecordByFile(fileName) {
  const target = resolveAuthFilePath(fileName);
  const raw = await fs.readFile(target.absolutePath, "utf8");
  return {
    fileName: target.fileName,
    absolutePath: target.absolutePath,
    parsed: JSON.parse(raw)
  };
}

function resolveAuthFilePath(fileName) {
  const safeName = path.basename(String(fileName || "").trim());
  if (!safeName || safeName === "." || safeName === ".." || !safeName.endsWith(".json")) {
    throw new Error("invalid auth file name");
  }
  return {
    fileName: safeName,
    absolutePath: path.join(AUTH_DIR, safeName)
  };
}

async function buildUniqueAuthFilePath(baseFileName) {
  await fs.mkdir(AUTH_DIR, { recursive: true });
  const ext = ".json";
  const stem = baseFileName.endsWith(ext) ? baseFileName.slice(0, -ext.length) : baseFileName;

  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = `${stem}${suffix}${ext}`;
    const absolutePath = path.join(AUTH_DIR, candidate);
    try {
      await fs.access(absolutePath);
    } catch {
      return { fileName: candidate, absolutePath };
    }
  }

  throw new Error("unable to allocate unique auth file name");
}

async function getDashboardApiKey() {
  const configText = await readTextIfExists(LOCAL_CONFIG_PATH);
  const matched = configText.match(/api-keys:\s*\n\s*-\s*["']?([^"'\n]+)["']?/m);
  return matched ? matched[1].trim() : "";
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
}

function createEmptyUsageCache() {
  return {
    version: 1,
    updatedAt: "",
    entries: {}
  };
}

function normalizeUsageCache(raw) {
  if (!raw || typeof raw !== "object") {
    return createEmptyUsageCache();
  }
  return {
    version: 1,
    updatedAt: String(raw.updatedAt || ""),
    entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {}
  };
}

async function readUsageCache() {
  try {
    const raw = await fs.readFile(ACCOUNT_USAGE_CACHE_PATH, "utf8");
    const parsed = safeJsonParse(raw);
    return normalizeUsageCache(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return createEmptyUsageCache();
    }
    return createEmptyUsageCache();
  }
}

async function writeUsageCache(cache) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ACCOUNT_USAGE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function buildUsageCacheEntry(result) {
  const usage = result?.usage || null;
  const primary = usage?.primaryWindow || null;
  const secondary = usage?.secondaryWindow || null;
  return {
    file: String(result?.file || ""),
    checkedAt: String(result?.checkedAt || new Date().toISOString()),
    ok: Boolean(result?.ok),
    status: String(result?.status || ""),
    label: String(result?.label || ""),
    detail: String(result?.detail || ""),
    refreshedToken: Boolean(result?.refreshedToken),
    refreshReason: String(result?.refreshReason || ""),
    usage: usage
      ? {
          ...usage,
          fiveHourRemainingPercent: primary?.remainingPercent ?? null,
          weeklyRemainingPercent: secondary?.remainingPercent ?? null,
          fiveHourUsedPercent: primary?.usedPercent ?? null,
          weeklyUsedPercent: secondary?.usedPercent ?? null
        }
      : null
  };
}

async function persistUsageResult(fileName, result) {
  const safeFileName = String(fileName || "").trim();
  if (!safeFileName) {
    return result;
  }

  const cache = await readUsageCache();
  cache.entries[safeFileName] = buildUsageCacheEntry(result);
  cache.updatedAt = new Date().toISOString();
  await writeUsageCache(cache);
  return result;
}

function toBackfilledUsage(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const checkedAt = String(entry.checkedAt || "");
  const checkedAtMs = Date.parse(checkedAt);
  const stale = !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > USAGE_CACHE_TTL_MS;
  const usage = entry.usage || null;
  const fiveHourRemainingPercent = clampPercent(
    usage?.fiveHourRemainingPercent ??
      usage?.primaryWindow?.remainingPercent ??
      null
  );
  const weeklyRemainingPercent = clampPercent(
    usage?.weeklyRemainingPercent ??
      usage?.secondaryWindow?.remainingPercent ??
      null
  );

  return {
    checkedAt,
    ok: Boolean(entry.ok),
    status: String(entry.status || ""),
    label: String(entry.label || ""),
    detail: String(entry.detail || ""),
    stale,
    usage: usage
      ? {
          ...usage,
          fiveHourRemainingPercent,
          weeklyRemainingPercent
        }
      : null,
    fiveHourRemainingPercent,
    weeklyRemainingPercent
  };
}

function resolveOpenClawProxySelection(config) {
  const selected = String(config?.agents?.defaults?.model || "").trim();
  const [provider, modelId] = selected.split("/", 2);
  if (!provider || !modelId) {
    return {
      provider: "openai-proxy",
      modelId: "",
      fullId: ""
    };
  }
  return {
    provider,
    modelId,
    fullId: `${provider}/${modelId}`
  };
}

async function getOpenClawProxySelection() {
  const config = await readJsonIfExists(OPENCLAW_CONFIG_PATH);
  return resolveOpenClawProxySelection(config || {});
}

async function restartOpenClawServices() {
  if (SERVICE_MANAGER !== "launchctl") {
    return {
      manager: SERVICE_MANAGER,
      restarted: false,
      skipped: true
    };
  }

  const domain = `gui/${process.getuid()}`;
  const labels = [OPENCLAW_NODE_LABEL, OPENCLAW_GATEWAY_LABEL];
  const results = [];

  for (const label of labels) {
    try {
      const { stdout, stderr } = await runCommand("launchctl", ["kickstart", "-k", `${domain}/${label}`], 20000);
      results.push({
        label,
        ok: true,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim()
      });
    } catch (error) {
      results.push({
        label,
        ok: false,
        error: String(error.message || error)
      });
    }
  }

  return {
    manager: SERVICE_MANAGER,
    restarted: results.some((item) => item.ok),
    results
  };
}

async function setOpenClawProxyModel(modelId, options = {}) {
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedModelId) {
    throw new Error("modelId is required");
  }

  const availableModels = await fetchProxyModels();
  if (!availableModels.includes(normalizedModelId)) {
    throw new Error(`model not available from proxy: ${normalizedModelId}`);
  }

  const config = await readJsonIfExists(OPENCLAW_CONFIG_PATH);
  if (!config) {
    throw new Error(`openclaw config not found: ${OPENCLAW_CONFIG_PATH}`);
  }

  const current = resolveOpenClawProxySelection(config);
  const provider =
    current.provider === "openai-proxy" || current.provider === "cliproxyapi"
      ? current.provider
      : "openai-proxy";
  const fullId = `${provider}/${normalizedModelId}`;

  config.meta = {
    ...(config.meta || {}),
    lastTouchedAt: new Date().toISOString()
  };
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = fullId;
  config.agents.defaults.models = config.agents.defaults.models || {};
  config.agents.defaults.models[fullId] = config.agents.defaults.models[fullId] || {};

  await fs.writeFile(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const shouldRestart = Boolean(options.restart);
  const restart = shouldRestart
    ? await restartOpenClawServices()
    : {
        manager: SERVICE_MANAGER,
        restarted: false,
        skipped: true
      };
  return {
    provider,
    modelId: normalizedModelId,
    fullId,
    restartRequested: shouldRestart,
    restart
  };
}

async function fetchProxyModels() {
  const apiKey = await getDashboardApiKey();
  if (!apiKey) {
    throw new Error("api key not found in local config.yaml");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${CLIPROXY_BASE_URL}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`/v1/models responded ${response.status}`);
    }

    const json = await response.json();
    const models = Array.isArray(json.data) ? json.data : [];
    return models.map((entry) => entry.id).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

async function getPreferredVerificationModel(authType = "") {
  const [availableModels, openclawSelection] = await Promise.all([
    fetchProxyModels(),
    getOpenClawProxySelection().catch(() => ({
      provider: "openai-proxy",
      modelId: "",
      fullId: ""
    }))
  ]);

  const normalizedAuthType = String(authType || "").trim().toLowerCase();
  const isGemini = normalizedAuthType === "gemini";
  const preferred = isGemini
    ? [
        String(openclawSelection?.modelId || "").trim(),
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-3-pro-preview",
        availableModels.find((item) => /^gemini-/i.test(String(item || ""))) || ""
      ].filter(Boolean)
    : [
        String(openclawSelection?.modelId || "").trim(),
        "gpt-5.4",
        "gpt-5.3-codex",
        "gpt-5.1-codex",
        availableModels[0] || ""
      ].filter(Boolean);

  const modelId = preferred.find((item) => availableModels.includes(item));
  if (!modelId) {
    throw new Error(`no proxy model available for ${isGemini ? "gemini" : "codex"} account verification`);
  }
  return modelId;
}

async function getServiceStatus() {
  if (SERVICE_MANAGER === "launchctl") {
    try {
      const label = "com.liuxiaoyu.cliproxyapi";
      const { stdout } = await runCommand("launchctl", ["list", label], 20000);
      const pidMatch = String(stdout || "").match(/"PID"\s*=\s*(\d+)/);
      const pid = pidMatch ? pidMatch[1] : null;
      const status = pid ? "running" : "stopped";
      return { name: label, status, raw: pid ? `PID ${pid}` : "not running" };
    } catch (error) {
      // launchctl list <label> exits non-zero if not loaded
      return { name: "cliproxyapi", status: "stopped", raw: String(error.message || error) };
    }
  }

  if (SERVICE_MANAGER === "systemd") {
    try {
      const { stdout } = await runCommand(
        "systemctl",
        ["is-active", CLIPROXY_SERVICE_NAME],
        20000
      );
      const status = String(stdout || "").trim() || "unknown";
      return {
        name: CLIPROXY_SERVICE_NAME,
        status,
        raw: status
      };
    } catch (error) {
      return {
        name: CLIPROXY_SERVICE_NAME,
        status: "error",
        raw: String(error.message || error)
      };
    }
  }

  try {
    const { stdout } = await runCommand("brew", ["services", "list"], 20000);
    const lines = stdout.split("\n");
    const target = lines.find((line) => line.trim().startsWith(CLIPROXY_SERVICE_NAME));

    if (!target) {
      return { name: CLIPROXY_SERVICE_NAME, status: "unknown", raw: "" };
    }

    const parts = target.trim().split(/\s+/);
    return {
      name: parts[0] || CLIPROXY_SERVICE_NAME,
      status: parts[1] || "unknown",
      raw: target
    };
  } catch (error) {
    return {
      name: CLIPROXY_SERVICE_NAME,
      status: "error",
      raw: String(error.message || error)
    };
  }
}

async function isProxyPortListening() {
  try {
    const { stdout } = await runCommand("lsof", [
      "-nP",
      `-iTCP:${CLIPROXY_PORT}`,
      "-sTCP:LISTEN"
    ]);
    return stdout.includes("LISTEN");
  } catch {
    return false;
  }
}

function compactAccountId(raw) {
  if (!raw || typeof raw !== "string") {
    return "";
  }
  if (raw.length <= 10) {
    return raw;
  }
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

async function loadAuthAccounts() {
  let files = [];
  try {
    files = await fs.readdir(AUTH_DIR);
  } catch {
    return [];
  }

  const accounts = [];
  const jsonFiles = files.filter((name) => name.endsWith(".json")).sort();

  for (const fileName of jsonFiles) {
    const absolutePath = path.join(AUTH_DIR, fileName);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(absolutePath, "utf8"),
        fs.stat(absolutePath)
      ]);
      const parsed = JSON.parse(raw);
      const isGemini = String(parsed.type || "").trim().toLowerCase() === "gemini";
      const rawAccountId = String(parsed.account_id || parsed.project_id || "").trim();
      const disabledMarker = String(
        parsed.disabled_by || parsed.disabledBy || parsed.disabled_source || parsed.disabledSource || ""
      )
        .trim()
        .toLowerCase();
      const isManagedDisabled =
        Boolean(parsed.disabled) &&
        ["dashboard", "manual", "user"].includes(disabledMarker);
      accounts.push({
        file: fileName,
        email: parsed.email || "",
        type: parsed.type || "",
        accountId: compactAccountId(rawAccountId),
        rawAccountId,
        lastRefresh: parsed.last_refresh || "",
        hasAccessToken: Boolean(parsed.access_token || (isGemini && parsed.token)),
        hasRefreshToken: Boolean(parsed.refresh_token),
        hasIdToken: Boolean(parsed.id_token),
        disabled: isManagedDisabled,
        disabledRaw: Boolean(parsed.disabled),
        disabledSource: disabledMarker || "",
        updatedAt: stat.mtime.toISOString()
      });
    } catch (error) {
      accounts.push({
        file: fileName,
        error: String(error.message || error),
        email: "",
        type: "",
        accountId: "",
        lastRefresh: "",
        hasAccessToken: false,
        hasRefreshToken: false,
        hasIdToken: false,
        disabled: false,
        updatedAt: ""
      });
    }
  }

  return accounts;
}

async function importAuthAccount(rawInput, options = {}) {
  const payload = extractAccessTokenPayload(rawInput);
  if (!payload.accessToken) {
    throw new Error("missing accessToken in payload");
  }

  const jwtPayload = decodeJwtPayload(payload.accessToken);
  const profile = jwtPayload["https://api.openai.com/profile"] || {};
  const auth = jwtPayload["https://api.openai.com/auth"] || {};

  const accountId = payload.accountId || auth.chatgpt_account_id || "";
  const email = payload.email || profile.email || "";
  const expired =
    payload.expired ||
    (jwtPayload.exp ? formatIsoOffset(new Date(Number(jwtPayload.exp) * 1000)) : "");

  if (!accountId) {
    throw new Error("token payload is missing chatgpt_account_id");
  }

  const records = await loadAuthAccountRecords();
  const sameAccountRecords = records.filter((entry) => entry.parsed.account_id === accountId);
  const sameEmailRecords = email ? records.filter((entry) => entry.parsed.email === email) : [];
  const sibling =
    sameAccountRecords.find((entry) => entry.parsed.refresh_token || entry.parsed.id_token) ||
    sameEmailRecords.find((entry) => entry.parsed.refresh_token || entry.parsed.id_token) ||
    null;

  const targetFile = String(options.targetFile || "").trim();
  const replaceLatest = String(options.mode || "").toLowerCase() === "replace-latest";
  const replaceTarget =
    targetFile
      ? await loadAuthRecordByFile(targetFile)
      : sameAccountRecords[0] ||
        sameEmailRecords[0] ||
        null;

  let fileName;
  let absolutePath;
  let replacedExisting = false;
  if ((replaceLatest || targetFile) && replaceTarget) {
    fileName = replaceTarget.fileName;
    absolutePath = replaceTarget.absolutePath;
    replacedExisting = true;
  } else {
    const fileSeed = `codex-${sanitizeFileSegment(accountId.slice(0, 8), "import")}-${sanitizeFileSegment(email, "account")}`;
    const target = await buildUniqueAuthFilePath(fileSeed);
    fileName = target.fileName;
    absolutePath = target.absolutePath;
  }

  const document = {
    access_token: payload.accessToken,
    account_id: accountId,
    email,
    expired,
    type: "codex",
    disabled: false,
    last_refresh: formatIsoOffset(new Date())
  };

  const refreshToken = payload.refreshToken || sibling?.parsed?.refresh_token || "";
  const idToken = payload.idToken || sibling?.parsed?.id_token || "";
  if (refreshToken) {
    document.refresh_token = refreshToken;
  }
  if (idToken) {
    document.id_token = idToken;
  }

  await fs.writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await fs.chmod(absolutePath, 0o600);

  return {
    fileName,
    absolutePath,
    accountId,
    email,
    expired,
    targetedFile: targetFile || "",
    replacedExisting,
    inheritedRefreshToken: Boolean(!payload.refreshToken && sibling?.parsed?.refresh_token),
    inheritedIdToken: Boolean(!payload.idToken && sibling?.parsed?.id_token),
    matchingAccountCount: sameAccountRecords.length + (replacedExisting ? 0 : 1),
    duplicateFiles: sameAccountRecords.map((entry) => entry.fileName)
  };
}

async function setAccountDisabled(fileName, disabled) {
  const target = resolveAuthFilePath(fileName);
  const raw = await fs.readFile(target.absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  const nextDisabled = Boolean(disabled);
  parsed.disabled = nextDisabled;
  if (nextDisabled) {
    parsed.disabled_by = "dashboard";
    parsed.disabled_at = new Date().toISOString();
  } else {
    delete parsed.disabled_by;
    delete parsed.disabledBy;
    delete parsed.disabled_source;
    delete parsed.disabledSource;
    delete parsed.disabled_at;
  }
  parsed.last_refresh = formatIsoOffset(new Date());
  await fs.writeFile(target.absolutePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await fs.chmod(target.absolutePath, 0o600);
  return target.fileName;
}

async function writeAuthRecord(record, parsed) {
  await fs.writeFile(record.absolutePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await fs.chmod(record.absolutePath, 0o600);
}

function rememberVerificationWindow(window) {
  verificationWindows.push(window);
  const cutoff = Date.now() - 30 * 60 * 1000;
  while (verificationWindows.length && verificationWindows[0].endMs < cutoff) {
    verificationWindows.shift();
  }
}

function getRecentVerificationWindows() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  return verificationWindows.filter((item) => item.endMs >= cutoff);
}

let verificationQueue = Promise.resolve();

function withVerificationLock(task) {
  const run = verificationQueue.then(task, task);
  verificationQueue = run.catch(() => {});
  return run;
}

async function verifyAuthThroughProxy(fileName, modelId) {
  const records = await loadAuthAccountRecords();
  const target = records.find((item) => item.fileName === fileName);
  if (!target) {
    throw new Error(`auth file not found: ${fileName}`);
  }

  const apiKey = await getDashboardApiKey();
  if (!apiKey) {
    throw new Error("api key not found in local config.yaml");
  }

  const originalTexts = {};
  for (const record of records) {
    originalTexts[record.fileName] = record.raw;
  }
  const startedAt = Date.now();

  try {
    for (const record of records) {
      const parsed = { ...(record.parsed || {}) };
      parsed.disabled = record.fileName !== fileName;
      // eslint-disable-next-line no-await-in-loop
      await writeAuthRecord(record, parsed);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`${CLIPROXY_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            {
              role: "user",
              content: "Reply with exactly OK."
            }
          ],
          temperature: 0,
          max_tokens: 8
        }),
        signal: controller.signal
      });

      const rawText = await response.text();
      let detail = rawText.slice(0, 280).trim();
      let content = "";

      try {
        const json = JSON.parse(rawText);
        const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
        if (typeof choice?.message?.content === "string") {
          content = choice.message.content.trim();
        } else if (Array.isArray(choice?.message?.content)) {
          content = choice.message.content
            .map((item) => (typeof item?.text === "string" ? item.text : ""))
            .join("")
            .trim();
        }
        detail = String(
          json?.error?.message ||
            json?.message ||
            content ||
            detail
        ).trim();
      } catch {
        // Keep plain text.
      }

      const okReply = /\bok\b/i.test(content || detail);
      return {
        httpStatus: response.status,
        ok: response.ok && okReply,
        label: response.ok && okReply ? "模型返回OK" : response.ok ? "模型已返回" : `上游${response.status}`,
        detail: response.ok
          ? `model=${modelId} reply=${content || detail || "-"}`
          : detail || `proxy responded ${response.status}`,
        responseText: content || detail || ""
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    for (const record of records) {
      const raw = originalTexts[record.fileName];
      if (typeof raw === "string") {
        // eslint-disable-next-line no-await-in-loop
        await fs.writeFile(record.absolutePath, raw, "utf8");
        // eslint-disable-next-line no-await-in-loop
        await fs.chmod(record.absolutePath, 0o600);
      }
    }
    rememberVerificationWindow({
      source: "account-verify",
      fileName,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      startMs: startedAt,
      endMs: Date.now()
    });
  }
}

function classifyProxyVerificationFailure(proxyResult, recentRuntime) {
  const detail = String(proxyResult?.detail || "").trim();
  const httpStatus = Number(proxyResult?.httpStatus || 0);

  if (httpStatus === 429 || /cooling down|rate limit/i.test(detail)) {
    return {
      status: "cooling-down",
      label: "冷却中",
      detail: detail || "该账号当前处于冷却窗口"
    };
  }

  if (httpStatus === 401 || /invalidated|sign in again|unauthorized/i.test(detail)) {
    return {
      status: "invalidated",
      label: "Token失效",
      detail: detail || "该账号认证已失效"
    };
  }

  if (/auth_unavailable|no auth available/i.test(detail)) {
    return {
      status: recentRuntime?.status || "auth-unavailable",
      label: recentRuntime?.label || "账号不可用",
      detail: recentRuntime?.detail || detail
    };
  }

  if (httpStatus === 500) {
    return {
      status: "upstream-500",
      label: "上游500",
      detail: detail || "该账号验证时返回 500"
    };
  }

  if (httpStatus === 502 || httpStatus === 503) {
    return {
      status: "proxy-error",
      label: "代理异常",
      detail: detail || `验证时返回 ${httpStatus}`
    };
  }

  return {
    status: recentRuntime?.status || "proxy-check-failed",
    label: proxyResult?.label || recentRuntime?.label || "验证失败",
    detail: detail || recentRuntime?.detail || "账号验证未通过"
  };
}

async function deleteAccountFile(fileName) {
  const target = resolveAuthFilePath(fileName);
  try {
    await fs.unlink(target.absolutePath);
    return {
      fileName: target.fileName,
      removed: true,
      gone: false
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        fileName: target.fileName,
        removed: false,
        gone: true
      };
    }
    throw error;
  }
}

const CLEANUP_REMOVABLE_STATUS_SET = new Set(["invalidated", "token-expired", "refresh-failed"]);
const CLEANUP_PROTECTED_STATUS_SET = new Set(["cooling-down", "rate-limited", "rate-limit"]);

function normalizeCleanupStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function classifyCleanupStatus(usageEntry, runtimeEntry) {
  const usageStatus = normalizeCleanupStatus(usageEntry?.status);
  const usageDetail = String(usageEntry?.detail || "").toLowerCase();
  if (usageStatus && CLEANUP_PROTECTED_STATUS_SET.has(usageStatus)) {
    return {
      action: "protected",
      status: usageStatus,
      source: "usage-cache"
    };
  }
  if (usageStatus && CLEANUP_REMOVABLE_STATUS_SET.has(usageStatus)) {
    return {
      action: "candidate",
      status: usageStatus,
      source: "usage-cache"
    };
  }
  if (usageStatus === "usage-query-failed") {
    if (/invalidated|token_invalidated|unauthorized|401/.test(usageDetail)) {
      return {
        action: "candidate",
        status: "invalidated",
        source: "usage-cache"
      };
    }
    if (/rate limit|429|cooling down/.test(usageDetail)) {
      return {
        action: "protected",
        status: "rate-limited",
        source: "usage-cache"
      };
    }
  }

  const runtimeStatus = normalizeCleanupStatus(runtimeEntry?.status);
  if (runtimeStatus === "rate-limited" || runtimeStatus === "cooling-down" || runtimeStatus === "rate-limit") {
    return {
      action: "protected",
      status: runtimeStatus,
      source: "logs"
    };
  }
  if (runtimeStatus === "invalidated") {
    return {
      action: "candidate",
      status: runtimeStatus,
      source: "logs"
    };
  }

  return {
    action: "skip",
    status: usageStatus || runtimeStatus || "unknown",
    source: usageStatus ? "usage-cache" : runtimeStatus ? "logs" : "none"
  };
}

function parseLogTimestamp(line) {
  const match = String(line || "").match(/^\[([0-9-]{10} [0-9:]{8})\]/);
  return match ? match[1] : "";
}

function parseLogRequestId(line) {
  const match = String(line || "").match(/^\[[^\]]+\]\s+\[([^\]]+)\]/);
  if (!match || match[1] === "--------") {
    return "";
  }
  return match[1];
}

function parseLogAuthHit(line) {
  const text = String(line || "");
  const patterns = [
    /^\[([^\]]+)\].*\[AUTH-HIT\]\s+OAuth provider=([^\s]+)\s+auth_file=([^\s]+)\s+for model\s+([^\s]+)/,
    /^\[([^\]]+)\].*Use OAuth provider=([^\s]+)\s+auth_file=([^\s]+)\s+for model\s+([^\s]+)/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    return {
      time: match[1],
      provider: match[2],
      authFile: match[3],
      model: match[4]
    };
  }

  return null;
}

function buildRecentRuntimeMap(logText) {
  const lines = String(logText || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const requestToAuthFile = {};
  const runtimeByFile = {};

  for (const line of lines) {
    const authHit = parseLogAuthHit(line);
    const requestId = parseLogRequestId(line);

    if (authHit && requestId) {
      requestToAuthFile[requestId] = authHit.authFile;
      const current = runtimeByFile[authHit.authFile] || {};
      runtimeByFile[authHit.authFile] = {
        ...current,
        lastHitTime: authHit.time,
        lastModel: authHit.model
      };
      continue;
    }

    if (!requestId || !requestToAuthFile[requestId]) {
      continue;
    }

    const authFile = requestToAuthFile[requestId];
    const timeText = parseLogTimestamp(line) || "-";
    const current = runtimeByFile[authFile] || {};

    if (/request error, error status:\s*401/i.test(line) || /token has been invalidated/i.test(line)) {
      runtimeByFile[authFile] = {
        ...current,
        status: "invalidated",
        label: "Token失效",
        detail: `${timeText} 401 认证失效`
      };
      continue;
    }

    const responseMatch = line.match(/\[(warn |error|info )\].*?\b(200|401|429|500|502|503)\b.*POST\s+\"(\/v1\/responses|\/v1\/chat\/completions)\"/);
    if (!responseMatch) {
      continue;
    }

    const statusCode = Number(responseMatch[2]);
    if (statusCode === 200) {
      runtimeByFile[authFile] = {
        ...current,
        status: "valid",
        label: "最近成功",
        detail: `${timeText} 200 请求成功`
      };
      continue;
    }

    if (statusCode === 401) {
      runtimeByFile[authFile] = {
        ...current,
        status: "unauthorized",
        label: "认证失败",
        detail: `${timeText} 401 未授权`
      };
      continue;
    }

    if (statusCode === 429) {
      runtimeByFile[authFile] = {
        ...current,
        status: "rate-limited",
        label: "请求限流",
        detail: `${timeText} 429 触发限流`
      };
      continue;
    }

    if (statusCode === 500) {
      runtimeByFile[authFile] = {
        ...current,
        status: "upstream-500",
        label: "上游500",
        detail: `${timeText} 500 上游请求失败`
      };
      continue;
    }

    if (statusCode === 502 || statusCode === 503) {
      runtimeByFile[authFile] = {
        ...current,
        status: "proxy-error",
        label: "代理异常",
        detail: `${timeText} ${statusCode} 代理异常`
      };
    }
  }

  return runtimeByFile;
}

async function verifyAuthAccountFile(fileName) {
  return withVerificationLock(async () => {
    const record = await loadAuthRecordByFile(fileName);
    const parsed = record.parsed || {};
    const authType = String(parsed.type || "").trim().toLowerCase();
    const accessToken = String(parsed.access_token || "").trim();
    const geminiToken = String(parsed.token || "").trim();
    const disabled = Boolean(parsed.disabled);
    const now = new Date();
    let tokenPayload = null;
    let expiredAt = String(parsed.expired || "").trim();

    if (accessToken) {
      try {
        tokenPayload = decodeJwtPayload(accessToken);
        if (!expiredAt && tokenPayload.exp) {
          expiredAt = formatIsoOffset(new Date(Number(tokenPayload.exp) * 1000));
        }
      } catch {
        tokenPayload = null;
      }
    }

    const expiredDate = expiredAt ? new Date(expiredAt) : null;
    const locallyExpired =
      expiredDate instanceof Date &&
      !Number.isNaN(expiredDate.getTime()) &&
      expiredDate.getTime() <= now.getTime();
    const recentRuntime = buildRecentRuntimeMap(await readLogTail(600))[record.fileName] || null;

    if (!accessToken && !geminiToken) {
      return {
        file: record.fileName,
        email: parsed.email || "",
        accountId: parsed.account_id || parsed.project_id || "",
        checkedAt: now.toISOString(),
        disabled,
        expiredAt,
        locallyExpired,
        ok: false,
        status: "missing-token",
        label: authType === "gemini" ? "缺少 Gemini token" : "缺少 access_token",
        detail: authType === "gemini" ? "认证文件缺少 Gemini token，无法验证" : "认证文件缺少 access_token，无法验证",
        recentRuntime
      };
    }

    const modelId = await getPreferredVerificationModel(authType);

    try {
      const proxyResult = await verifyAuthThroughProxy(record.fileName, modelId);
      const failure = proxyResult.ok
        ? null
        : classifyProxyVerificationFailure(proxyResult, recentRuntime);
      return {
        file: record.fileName,
        email: parsed.email || "",
        accountId: parsed.account_id || parsed.project_id || "",
        checkedAt: now.toISOString(),
        disabled,
        expiredAt,
        locallyExpired,
        modelId,
        ok: proxyResult.ok,
        status: proxyResult.ok ? "valid" : failure?.status || "proxy-check-failed",
        label: proxyResult.ok ? proxyResult.label : failure?.label || proxyResult.label,
        detail: proxyResult.ok ? proxyResult.detail : failure?.detail || proxyResult.detail,
        httpStatus: proxyResult.httpStatus,
        recentRuntime
      };
    } catch (error) {
      return {
        file: record.fileName,
        email: parsed.email || "",
        accountId: parsed.account_id || "",
        checkedAt: now.toISOString(),
        disabled,
        expiredAt,
        locallyExpired,
        modelId,
        ok: recentRuntime?.status === "valid",
        status: recentRuntime?.status || "request-failed",
        label: recentRuntime?.label || "验证失败",
        detail: recentRuntime?.detail || String(error.message || error),
        recentRuntime,
        proxyCheckError: String(error.message || error)
      };
    }
  });
}

async function queryCodexUsageByFile(fileName) {
  return withVerificationLock(async () => {
    const record = await loadAuthRecordByFile(fileName);
    const parsed = record.parsed || {};
    const checkedAt = new Date().toISOString();
    const authType = String(parsed.type || "codex").trim().toLowerCase();
    const finalize = async (result) => {
      const usage = result?.usage || null;
      const primary = usage?.primaryWindow || null;
      const secondary = usage?.secondaryWindow || null;
      const normalized = {
        ...result,
        fiveHourRemainingPercent: clampPercent(
          result?.fiveHourRemainingPercent ??
            usage?.fiveHourRemainingPercent ??
            primary?.remainingPercent ??
            null
        ),
        weeklyRemainingPercent: clampPercent(
          result?.weeklyRemainingPercent ??
            usage?.weeklyRemainingPercent ??
            secondary?.remainingPercent ??
            null
        )
      };
      await persistUsageResult(record.fileName, normalized);
      return normalized;
    };

    if (authType === "gemini") {
      return finalize({
        file: record.fileName,
        email: parsed.email || "",
        accountId: parsed.project_id || "",
        checkedAt,
        ok: false,
        status: "unsupported-type",
        label: "不支持",
        detail: "Gemini 账号不支持 Codex 用量查询"
      });
    }

    let accessToken = String(parsed.access_token || "").trim();
    let refreshToken = String(parsed.refresh_token || "").trim();
    let accountId = String(parsed.account_id || "").trim() || extractCodexAccountIdFromAccessToken(accessToken);
    let refreshedToken = false;
    let refreshReason = "";

    if (!accessToken) {
      return finalize({
        file: record.fileName,
        email: parsed.email || "",
        accountId,
        checkedAt,
        ok: false,
        status: "missing-token",
        label: "缺少 access_token",
        detail: "认证文件缺少 access_token，无法查询用量"
      });
    }

    const persistRefreshedTokens = async (tokens, reason) => {
      accessToken = String(tokens.accessToken || "").trim();
      refreshToken = String(tokens.refreshToken || refreshToken).trim();
      parsed.access_token = accessToken;
      parsed.id_token = String(tokens.idToken || parsed.id_token || "").trim();
      parsed.refresh_token = refreshToken;
      parsed.last_refresh = formatIsoOffset(new Date());
      const fromToken = extractCodexAccountIdFromAccessToken(accessToken);
      if (fromToken) {
        parsed.account_id = fromToken;
      }
      accountId = String(parsed.account_id || accountId || "").trim() || fromToken;
      await writeAuthRecord(record, parsed);
      refreshedToken = true;
      refreshReason = reason;
    };

    if (isJwtLikelyExpired(accessToken)) {
      if (!refreshToken) {
        return finalize({
          file: record.fileName,
          email: parsed.email || "",
          accountId,
          checkedAt,
          ok: false,
          status: "token-expired",
          label: "Token 已过期",
          detail: "access_token 已过期，且缺少 refresh_token"
        });
      }
      try {
        const refreshed = await refreshCodexTokens(refreshToken);
        await persistRefreshedTokens(refreshed, "token-expired");
      } catch (error) {
        return finalize({
          file: record.fileName,
          email: parsed.email || "",
          accountId,
          checkedAt,
          ok: false,
          status: "refresh-failed",
          label: "刷新失败",
          detail: String(error.message || error)
        });
      }
    }

    try {
      let payload;
      try {
        payload = await fetchCodexUsageOnce(accessToken, accountId);
      } catch (error) {
        if (shouldForceCodexTokenRefresh(error.httpStatus, error.detail || error.message) && refreshToken) {
          const refreshed = await refreshCodexTokens(refreshToken);
          await persistRefreshedTokens(refreshed, "usage-401");
          payload = await fetchCodexUsageOnce(accessToken, accountId);
        } else {
          throw error;
        }
      }

      const usage = normalizeCodexUsagePayload(payload);
      return finalize({
        file: record.fileName,
        email: parsed.email || "",
        accountId: String(parsed.account_id || accountId || "").trim(),
        checkedAt,
        ok: true,
        status: "usage-ok",
        label: "用量已更新",
        detail: summarizeCodexUsage(usage),
        refreshedToken,
        refreshReason,
        usage
      });
    } catch (error) {
      return finalize({
        file: record.fileName,
        email: parsed.email || "",
        accountId: String(parsed.account_id || accountId || "").trim(),
        checkedAt,
        ok: false,
        status: "usage-query-failed",
        label: "查询失败",
        detail: String(error.message || error),
        refreshedToken,
        refreshReason
      });
    }
  });
}

async function readLogTailLegacy(lines = 180) {
  try {
    const { stdout } = await runCommand("tail", ["-n", String(lines), LOCAL_LOG_PATH], 10000);
    return stdout;
  } catch (error) {
    return `failed to read log: ${error.message || error}`;
  }
}

const logAnalyzer = createLogAnalyzer({
  enabled: LOG_INCREMENTAL_ENABLED,
  logPath: LOCAL_LOG_PATH,
  cacheSize: LOG_CACHE_LINES,
  legacyReadTail: readLogTailLegacy
});

async function readLogTail(lines = 180, options = {}) {
  return logAnalyzer.getLogs({
    lines,
    alertsOnly: Boolean(options.alertsOnly)
  });
}

async function collectHealthSnapshot() {
  const [service, listening, accounts] = await Promise.all([
    getServiceStatus(),
    isProxyPortListening(),
    loadAuthAccounts()
  ]);

  let modelIds = [];
  let modelsError = "";
  try {
    modelIds = await fetchProxyModels();
  } catch (error) {
    modelsError = String(error.message || error);
  }

  return {
    now: new Date().toISOString(),
    proxy: {
      baseUrl: CLIPROXY_BASE_URL,
      port: CLIPROXY_PORT
    },
    service,
    listening,
    models: {
      count: modelIds.length,
      ids: modelIds,
      error: modelsError
    },
    accounts: {
      count: accounts.length
    }
  };
}

const taskStore = createTaskStore(500);
const taskService = createTaskService({
  store: taskStore,
  concurrency: TASK_CONCURRENCY,
  handlers: {
    "usage-all": createUsageAllRunner({
      loadAuthAccounts,
      queryCodexUsageByFile
    }),
    "verify-all": createVerifyAllRunner({
      loadAuthAccounts,
      verifyAuthAccountFile
    })
  }
});

app.get(
  "/api/health",
  asyncRoute(async () => {
    return collectHealthSnapshot();
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.get(
  "/api/accounts",
  asyncRoute(async () => {
    const [accounts, usageCache] = await Promise.all([loadAuthAccounts(), readUsageCache()]);
    const nowMs = Date.now();
    const enriched = accounts.map((item) => {
      const fileName = String(item?.file || "");
      const cached = fileName ? usageCache.entries?.[fileName] : null;
      const usage = toBackfilledUsage(cached, nowMs);
      return usage
        ? {
            ...item,
            usage
          }
        : item;
    });
    return {
      count: enriched.length,
      accounts: enriched
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/cleanup-invalid",
  validateBody(schemas.cleanupInvalidBodySchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async (req) => {
    const mode = String(req.body?.mode || "dry-run").trim().toLowerCase() === "apply" ? "apply" : "dry-run";
    const [accounts, usageCache, recentLogText] = await Promise.all([
      loadAuthAccounts(),
      readUsageCache(),
      readLogTail(800)
    ]);
    const runtimeByFile = buildRecentRuntimeMap(recentLogText);
    const scanned = [];
    const candidates = [];
    const protectedItems = [];
    const skipped = [];
    const removed = [];
    const failed = [];

    for (const account of accounts) {
      const fileName = String(account?.file || "");
      if (!fileName || account?.error) {
        continue;
      }
      const usageEntry = usageCache.entries?.[fileName] || null;
      const runtimeEntry = runtimeByFile[fileName] || null;
      const classification = classifyCleanupStatus(usageEntry, runtimeEntry);
      const item = {
        file: fileName,
        email: String(account?.email || ""),
        status: classification.status,
        source: classification.source,
        usageStatus: String(usageEntry?.status || ""),
        runtimeStatus: String(runtimeEntry?.status || "")
      };
      scanned.push(item);

      if (classification.action === "candidate") {
        candidates.push(item);
      } else if (classification.action === "protected") {
        protectedItems.push(item);
      } else {
        skipped.push(item);
      }
    }

    if (mode === "apply") {
      for (const item of candidates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await deleteAccountFile(item.file);
          removed.push({
            ...item,
            removed: Boolean(result?.removed),
            gone: Boolean(result?.gone)
          });
          delete usageCache.entries[item.file];
        } catch (error) {
          failed.push({
            ...item,
            error: String(error.message || error)
          });
        }
      }
      usageCache.updatedAt = new Date().toISOString();
      await writeUsageCache(usageCache);
    }

    const refreshed = mode === "apply" ? await loadAuthAccounts() : accounts;
    return {
      mode,
      scannedCount: scanned.length,
      candidateCount: candidates.length,
      protectedCount: protectedItems.length,
      skippedCount: skipped.length,
      removedCount: removed.length,
      failedCount: failed.length,
      scanned,
      candidates,
      protected: protectedItems,
      skipped,
      removed,
      failed,
      count: refreshed.length,
      accounts: refreshed
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/verify-all",
  validateBody(schemas.verifyAllBodySchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async () => {
    const accounts = await loadAuthAccounts();
    const targetFiles = accounts
      .filter((item) => item?.file && !item.error && !item.disabled)
      .map((item) => item.file);
    const verifications = [];

    for (const fileName of targetFiles) {
      // eslint-disable-next-line no-await-in-loop
      verifications.push(await verifyAuthAccountFile(fileName));
    }

    return {
      count: verifications.length,
      verifications
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/usage-all",
  validateBody(schemas.verifyAllBodySchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async () => {
    const accounts = await loadAuthAccounts();
    const targetFiles = accounts
      .filter((item) => item?.file && !item.error && !item.disabled)
      .map((item) => item.file);

    const usages = [];
    for (const fileName of targetFiles) {
      // eslint-disable-next-line no-await-in-loop
      usages.push(await queryCodexUsageByFile(fileName));
    }

    return {
      count: usages.length,
      usages
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.get(
  "/api/models",
  asyncRoute(async () => {
    const [ids, selection] = await Promise.all([
      fetchProxyModels(),
      getOpenClawProxySelection().catch(() => ({
        provider: "openai-proxy",
        modelId: "",
        fullId: ""
      }))
    ]);
    return {
      count: ids.length,
      ids,
      selected: selection
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/models/select",
  asyncRoute(async (req) => {
    const modelId = String(req.body?.modelId || "").trim();
    if (!modelId) {
      throw createApiError(ERROR_CODES.INVALID_INPUT, "modelId is required", { status: 400 });
    }
    const restart = Boolean(req.body?.restart);
    const selected = await setOpenClawProxyModel(modelId, { restart });
    const ids = await fetchProxyModels();
    return {
      count: ids.length,
      ids,
      selected
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.get(
  "/api/config",
  asyncRoute(async () => {
    const [localConfig, activeConfig] = await Promise.all([
      readTextIfExists(LOCAL_CONFIG_PATH),
      readTextIfExists(ACTIVE_CONFIG_PATH)
    ]);

    return {
      localPath: LOCAL_CONFIG_PATH,
      activePath: ACTIVE_CONFIG_PATH,
      localConfig: redactYamlSecrets(localConfig),
      activeConfig: redactYamlSecrets(activeConfig)
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.get(
  "/api/logs",
  asyncRoute(async (req) => {
    const raw = String(req.query.lines || "180");
    const lines = Math.max(20, Math.min(Number(raw) || 180, 800));
    const [text, alertsText] = await Promise.all([
      readLogTail(lines, { alertsOnly: false }),
      readLogTail(lines, { alertsOnly: true })
    ]);
    return {
      lines,
      logPath: LOCAL_LOG_PATH,
      text,
      alertsText,
      suppressedAuthHits: getRecentVerificationWindows()
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/actions/sync",
  asyncRoute(async () => {
    const { stdout, stderr } = await runCommand("bash", [SYNC_SCRIPT_PATH], 120000);
    const health = await collectHealthSnapshot();
    return {
      stdout,
      stderr,
      health
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/import",
  validateBody(schemas.importAccountBodySchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async (req) => {
    const rawInput = String(req.body?.raw || req.body?.token || req.body?.payload || "");
    const mode = String(req.body?.mode || "append");
    const targetFile = String(req.body?.targetFile || "");
    const imported = await importAuthAccount(rawInput, { mode, targetFile });
    const accounts = await loadAuthAccounts();
    return {
      imported,
      count: accounts.length,
      accounts
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/:file/verify",
  validateParams(schemas.verifyFileParamsSchema, SCHEMA_VALIDATION_ENABLED),
  validateBody(schemas.verifyAllBodySchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async (req) => {
    const fileName = String(req.params.file || "");
    const verification = await verifyAuthAccountFile(fileName);
    return {
      verification
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/:file/usage",
  validateParams(schemas.verifyFileParamsSchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async (req) => {
    const fileName = String(req.params.file || "");
    const usage = await queryCodexUsageByFile(fileName);
    return {
      usage
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/accounts/:file/toggle-disabled",
  validateParams(schemas.verifyFileParamsSchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async (req) => {
    const fileName = String(req.params.file || "");
    const disabled = Boolean(req.body?.disabled);
    await setAccountDisabled(fileName, disabled);
    const accounts = await loadAuthAccounts();
    return {
      file: fileName,
      disabled,
      count: accounts.length,
      accounts
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.delete(
  "/api/accounts/:file",
  validateParams(schemas.verifyFileParamsSchema, SCHEMA_VALIDATION_ENABLED),
  asyncRoute(async (req) => {
    const fileName = String(req.params.file || "");
    const removed = await deleteAccountFile(fileName);
    const accounts = await loadAuthAccounts();
    return {
      removed: removed.fileName,
      gone: removed.gone,
      count: accounts.length,
      accounts
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

app.post(
  "/api/actions/service",
  asyncRoute(async (req) => {
    const action = String(req.body?.action || "").trim().toLowerCase();
    if (!["start", "stop", "restart"].includes(action)) {
      throw createApiError(ERROR_CODES.INVALID_INPUT, "action must be one of start|stop|restart", { status: 400 });
    }

    const label = "com.liuxiaoyu.cliproxyapi";
    const plistPath = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
    let cmd;
    if (SERVICE_MANAGER === "launchctl") {
      if (action === "stop") {
        cmd = { command: "launchctl", args: ["unload", plistPath] };
      } else if (action === "start") {
        cmd = { command: "launchctl", args: ["load", plistPath] };
      } else {
        try {
          await runCommand("launchctl", ["unload", plistPath], 10000);
        } catch {
          // Ignore unload failure during restart.
        }
        cmd = { command: "launchctl", args: ["load", plistPath] };
      }
    } else if (SERVICE_MANAGER === "systemd") {
      cmd = { command: "systemctl", args: [action, CLIPROXY_SERVICE_NAME] };
    } else {
      cmd = { command: "brew", args: ["services", action, CLIPROXY_SERVICE_NAME] };
    }

    const { stdout, stderr } = await runCommand(cmd.command, cmd.args, 120000);
    const health = await collectHealthSnapshot();
    return {
      action,
      manager: SERVICE_MANAGER,
      service: CLIPROXY_SERVICE_NAME,
      stdout,
      stderr,
      health
    };
  }, { v2Enabled: RESPONSE_V2_ENABLED })
);

registerTaskRoutes(app, {
  taskModeEnabled: TASK_MODE_ENABLED,
  taskService,
  asyncRoute,
  validateBody,
  validateParams,
  validateQuery,
  schemas,
  v2Enabled: RESPONSE_V2_ENABLED,
  schemaValidationEnabled: SCHEMA_VALIDATION_ENABLED
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  sendError(req, res, error, { v2Enabled: RESPONSE_V2_ENABLED });
});

app.use("/api/*", (req, res) => {
  sendError(
    req,
    res,
    createApiError(ERROR_CODES.INVALID_INPUT, `unknown api route: ${req.originalUrl}`, {
      status: 404,
      details: {
        route: req.originalUrl
      }
    }),
    { v2Enabled: RESPONSE_V2_ENABLED }
  );
});

app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "web", "index.html"));
});

const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
app.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.log(`Dashboard running at http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
});

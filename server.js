const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const util = require("util");
const { execFile } = require("child_process");

const execFileAsync = util.promisify(execFile);

const ROOT_DIR = process.env.APP_ROOT || __dirname;
const AUTH_DIR = process.env.AUTH_DIR || path.join(ROOT_DIR, "auths");
const LOCAL_CONFIG_PATH = process.env.LOCAL_CONFIG_PATH || path.join(ROOT_DIR, "config.yaml");
const ACTIVE_CONFIG_PATH =
  process.env.ACTIVE_CONFIG_PATH || "/Users/liuxiaoyu/cliproxy-kit/config.yaml";
const LOCAL_LOG_PATH = process.env.LOCAL_LOG_PATH || path.join(ROOT_DIR, "cliproxyapi.log");
const SYNC_SCRIPT_PATH = process.env.SYNC_SCRIPT_PATH || path.join(ROOT_DIR, "sync_codex_auths.sh");
const CLIPROXY_BASE_URL = process.env.CLIPROXY_BASE_URL || "http://127.0.0.1:8317";
const CLIPROXY_SERVICE_NAME = process.env.CLIPROXY_SERVICE_NAME || "cliproxyapi";
const SERVICE_MANAGER = String(process.env.SERVICE_MANAGER || "launchctl").toLowerCase();
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8328);
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || "/Users/liuxiaoyu/.openclaw/openclaw.json";
const OPENCLAW_GATEWAY_LABEL = process.env.OPENCLAW_GATEWAY_LABEL || "ai.openclaw.gateway";
const OPENCLAW_NODE_LABEL = process.env.OPENCLAW_NODE_LABEL || "ai.openclaw.node";

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

const app = express();
app.use(express.json({ limit: "200kb" }));
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

function extractGeminiTokenPayload(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) {
    throw new Error("missing gemini token payload");
  }

  const directToken = trimmed.match(/^["']?([A-Za-z0-9._-]{20,})["']?$/);
  if (directToken) {
    return { token: directToken[1] };
  }

  const parsed = safeJsonParse(trimmed);
  if (parsed && typeof parsed === "object") {
    return {
      token: String(parsed.accessToken || parsed.access_token || parsed.token || "").trim(),
      email: String(parsed.email || "").trim(),
      projectId: String(parsed.projectId || parsed.project_id || "").trim()
    };
  }

  const patterns = {
    token: /"(?:accessToken|access_token|token)"\s*:\s*"([^"]+)"/,
    email: /"email"\s*:\s*"([^"]+)"/,
    projectId: /"(?:projectId|project_id)"\s*:\s*"([^"]+)"/
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

async function getDashboardManagementKey() {
  return getDashboardApiKey();
}

async function callCliproxyManagement(endpoint, options = {}) {
  const managementKey = await getDashboardManagementKey();
  if (!managementKey) {
    throw new Error("management key not found in local config.yaml");
  }

  const url = new URL(endpoint, `${CLIPROXY_BASE_URL}/`);
  const query = options.query || {};
  for (const [key, value] of Object.entries(query)) {
    const normalized = String(value ?? "").trim();
    if (normalized) {
      url.searchParams.set(key, normalized);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    const rawText = await response.text();
    const payload = safeJsonParse(rawText);

    if (!response.ok) {
      const message =
        payload?.error ||
        payload?.message ||
        `${endpoint} responded ${response.status}`;
      throw new Error(message);
    }

    if (payload && typeof payload === "object") {
      return payload;
    }
    return { ok: true, raw: rawText };
  } finally {
    clearTimeout(timer);
  }
}

async function startGeminiOAuthSession(projectId = "") {
  return callCliproxyManagement("/v0/management/gemini-cli-auth-url", {
    query: {
      is_webui: "true",
      ...(projectId ? { project_id: projectId } : {})
    }
  });
}

async function submitGeminiOAuthCallback({ redirectURL = "", state = "", code = "", errorText = "", projectId = "" } = {}) {
  const normalizedRedirectURL = String(redirectURL || "").trim();
  const normalizedState = String(state || "").trim();
  const normalizedCode = String(code || "").trim();
  const normalizedError = String(errorText || "").trim();
  const normalizedProjectId = String(projectId || "").trim();

  try {
    const payload = await callCliproxyManagement("/v0/management/oauth-callback", {
      method: "POST",
      body: {
        provider: "gemini",
        redirect_url: normalizedRedirectURL,
        state: normalizedState,
        code: normalizedCode,
        error: normalizedError
      }
    });
    return {
      ...payload,
      recovered: false,
      state: normalizedState
    };
  } catch (error) {
    const message = String(error.message || error);
    const canRecover =
      (normalizedRedirectURL || normalizedCode) &&
      /unknown or expired state|not pending|timed out/i.test(message);

    if (!canRecover) {
      throw error;
    }

    const freshSession = await startGeminiOAuthSession(normalizedProjectId);
    const recoveredState = String(freshSession?.state || "").trim();
    if (!recoveredState) {
      throw new Error(`callback recovery failed: ${message}`);
    }

    const payload = await callCliproxyManagement("/v0/management/oauth-callback", {
      method: "POST",
      body: {
        provider: "gemini",
        redirect_url: normalizedRedirectURL,
        state: recoveredState,
        code: normalizedCode,
        error: normalizedError
      }
    });
    return {
      ...payload,
      recovered: true,
      state: recoveredState,
      previousState: normalizedState,
      authURL: String(freshSession?.url || "").trim()
    };
  }
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
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
        disabled: Boolean(parsed.disabled),
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

async function importGeminiToken(rawInput, options = {}) {
  const payload = extractGeminiTokenPayload(rawInput);
  const token = String(payload.token || "").trim();
  if (!token) {
    throw new Error("missing Gemini access token");
  }

  const requestedProjectId = String(options.projectId || payload.projectId || "").trim();
  const requestedEmail = String(payload.email || "").trim();
  const records = await loadAuthAccountRecords();
  const geminiRecords = records.filter((entry) => String(entry.parsed?.type || "").trim() === "gemini");

  const targetFile = String(options.targetFile || "").trim();
  const replaceTarget =
    targetFile
      ? await loadAuthRecordByFile(targetFile)
      : geminiRecords.find((entry) => requestedProjectId && entry.parsed?.project_id === requestedProjectId) ||
        geminiRecords.find((entry) => requestedEmail && entry.parsed?.email === requestedEmail) ||
        geminiRecords[0] ||
        null;

  let fileName;
  let absolutePath;
  let replacedExisting = false;
  if (replaceTarget) {
    fileName = replaceTarget.fileName;
    absolutePath = replaceTarget.absolutePath;
    replacedExisting = true;
  } else {
    const fileSeed = `gemini-${sanitizeFileSegment(requestedEmail || requestedProjectId || "manual-token", "manual-token")}`;
    const target = await buildUniqueAuthFilePath(fileSeed);
    fileName = target.fileName;
    absolutePath = target.absolutePath;
  }

  const projectId = requestedProjectId || String(replaceTarget?.parsed?.project_id || "").trim();
  const email = requestedEmail || String(replaceTarget?.parsed?.email || "").trim();

  const document = {
    auto: false,
    checked: true,
    disabled: false,
    token,
    type: "gemini"
  };
  if (email) {
    document.email = email;
  }
  if (projectId) {
    document.project_id = projectId;
  }

  await fs.writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await fs.chmod(absolutePath, 0o600);

  return {
    fileName,
    absolutePath,
    email,
    projectId,
    targetedFile: targetFile || "",
    replacedExisting,
    inheritedProjectId: Boolean(!requestedProjectId && replaceTarget?.parsed?.project_id),
    inheritedEmail: Boolean(!requestedEmail && replaceTarget?.parsed?.email)
  };
}

async function setAccountDisabled(fileName, disabled) {
  const target = resolveAuthFilePath(fileName);
  const raw = await fs.readFile(target.absolutePath, "utf8");
  const parsed = JSON.parse(raw);
  parsed.disabled = Boolean(disabled);
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
  const match = String(line).match(
    /^\[([^\]]+)\].*\[AUTH-HIT\]\s+OAuth provider=([^\s]+)\s+auth_file=([^\s]+)\s+for model\s+([^\s]+)/
  );
  if (!match) {
    return null;
  }
  return {
    time: match[1],
    provider: match[2],
    authFile: match[3],
    model: match[4]
  };
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

async function readLogTail(lines = 180) {
  try {
    const { stdout } = await runCommand("tail", ["-n", String(lines), LOCAL_LOG_PATH], 10000);
    return stdout;
  } catch (error) {
    return `failed to read log: ${error.message || error}`;
  }
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

app.get("/api/health", async (req, res) => {
  try {
    const snapshot = await collectHealthSnapshot();
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = await loadAuthAccounts();
    res.json({
      count: accounts.length,
      accounts
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/accounts/verify-all", async (req, res) => {
  try {
    const accounts = await loadAuthAccounts();
    const targetFiles = accounts
      .filter((item) => item?.file && !item.error && !item.disabled)
      .map((item) => item.file);
    const verifications = [];

    for (const fileName of targetFiles) {
      // Run sequentially so the test is 1:1 per auth file and easier to reason about.
      // This also avoids a verification burst that would distort recent log-based diagnosis.
      // eslint-disable-next-line no-await-in-loop
      verifications.push(await verifyAuthAccountFile(fileName));
    }

    res.json({
      ok: true,
      count: verifications.length,
      verifications
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/models", async (req, res) => {
  try {
    const [ids, selection] = await Promise.all([
      fetchProxyModels(),
      getOpenClawProxySelection().catch(() => ({
        provider: "openai-proxy",
        modelId: "",
        fullId: ""
      }))
    ]);
    res.json({
      count: ids.length,
      ids,
      selected: selection
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/models/select", async (req, res) => {
  try {
    const modelId = String(req.body?.modelId || "");
    const restart = Boolean(req.body?.restart);
    const selected = await setOpenClawProxyModel(modelId, { restart });
    const ids = await fetchProxyModels();
    res.json({
      ok: true,
      count: ids.length,
      ids,
      selected
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/config", async (req, res) => {
  try {
    const [localConfig, activeConfig] = await Promise.all([
      readTextIfExists(LOCAL_CONFIG_PATH),
      readTextIfExists(ACTIVE_CONFIG_PATH)
    ]);

    res.json({
      localPath: LOCAL_CONFIG_PATH,
      activePath: ACTIVE_CONFIG_PATH,
      localConfig: redactYamlSecrets(localConfig),
      activeConfig: redactYamlSecrets(activeConfig)
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/logs", async (req, res) => {
  try {
    const raw = String(req.query.lines || "180");
    const lines = Math.max(20, Math.min(Number(raw) || 180, 800));
    const text = await readLogTail(lines);
    res.json({
      lines,
      logPath: LOCAL_LOG_PATH,
      text,
      suppressedAuthHits: getRecentVerificationWindows()
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/actions/sync", async (req, res) => {
  try {
    const { stdout, stderr } = await runCommand("bash", [SYNC_SCRIPT_PATH], 120000);
    const health = await collectHealthSnapshot();
    res.json({
      ok: true,
      stdout,
      stderr,
      health
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.post("/api/accounts/import", async (req, res) => {
  try {
    const rawInput = String(req.body?.raw || req.body?.token || req.body?.payload || "");
    const mode = String(req.body?.mode || "append");
    const targetFile = String(req.body?.targetFile || "");
    const imported = await importAuthAccount(rawInput, { mode, targetFile });
    const accounts = await loadAuthAccounts();
    res.json({
      ok: true,
      imported,
      count: accounts.length,
      accounts
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.get("/api/gemini-cli/oauth/start", async (req, res) => {
  try {
    const projectId = String(req.query.projectId || "").trim();
    const payload = await startGeminiOAuthSession(projectId);
    res.json({
      ok: true,
      projectId,
      ...payload
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.get("/api/gemini-cli/oauth/status", async (req, res) => {
  try {
    const state = String(req.query.state || "").trim();
    if (!state) {
      res.status(400).json({ ok: false, error: "state is required" });
      return;
    }

    const payload = await callCliproxyManagement("/v0/management/get-auth-status", {
      query: { state }
    });
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.post("/api/gemini-cli/oauth/callback", async (req, res) => {
  try {
    const redirectURL = String(req.body?.redirectURL || req.body?.redirect_url || "").trim();
    const state = String(req.body?.state || "").trim();
    const code = String(req.body?.code || "").trim();
    const errorText = String(req.body?.error || "").trim();
    const projectId = String(req.body?.projectId || req.body?.project_id || "").trim();

    const payload = await submitGeminiOAuthCallback({
      redirectURL,
      state,
      code,
      errorText,
      projectId
    });
    res.json({
      ok: true,
      ...payload
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.post("/api/gemini-cli/token", async (req, res) => {
  try {
    const rawInput = String(req.body?.raw || req.body?.token || req.body?.payload || "").trim();
    const projectId = String(req.body?.projectId || req.body?.project_id || "").trim();
    const targetFile = String(req.body?.targetFile || "").trim();
    const imported = await importGeminiToken(rawInput, { projectId, targetFile });
    const accounts = await loadAuthAccounts();
    res.json({
      ok: true,
      imported,
      count: accounts.length,
      accounts
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.post("/api/accounts/:file/verify", async (req, res) => {
  try {
    const fileName = String(req.params.file || "");
    const verification = await verifyAuthAccountFile(fileName);
    res.json({
      ok: true,
      verification
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.post("/api/accounts/:file/toggle-disabled", async (req, res) => {
  try {
    const fileName = String(req.params.file || "");
    const disabled = Boolean(req.body?.disabled);
    await setAccountDisabled(fileName, disabled);
    const accounts = await loadAuthAccounts();
    res.json({
      ok: true,
      file: fileName,
      disabled,
      count: accounts.length,
      accounts
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.delete("/api/accounts/:file", async (req, res) => {
  try {
    const fileName = String(req.params.file || "");
    const removed = await deleteAccountFile(fileName);
    const accounts = await loadAuthAccounts();
    res.json({
      ok: true,
      removed: removed.fileName,
      gone: removed.gone,
      count: accounts.length,
      accounts
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.post("/api/actions/service", async (req, res) => {
  try {
    const action = String(req.body?.action || "").trim().toLowerCase();
    if (!["start", "stop", "restart"].includes(action)) {
      res.status(400).json({ error: "action must be one of start|stop|restart" });
      return;
    }

    const label = "com.liuxiaoyu.cliproxyapi";
    const plistPath = process.env.HOME + "/Library/LaunchAgents/" + label + ".plist";
    let cmd;
    if (SERVICE_MANAGER === "launchctl") {
      if (action === "stop") {
        cmd = { command: "launchctl", args: ["unload", plistPath] };
      } else if (action === "start") {
        cmd = { command: "launchctl", args: ["load", plistPath] };
      } else {
        // restart = unload + load
        try { await runCommand("launchctl", ["unload", plistPath], 10000); } catch (_) {}
        cmd = { command: "launchctl", args: ["load", plistPath] };
      }
    } else if (SERVICE_MANAGER === "systemd") {
      cmd = { command: "systemctl", args: [action, CLIPROXY_SERVICE_NAME] };
    } else {
      cmd = { command: "brew", args: ["services", action, CLIPROXY_SERVICE_NAME] };
    }

    const { stdout, stderr } = await runCommand(cmd.command, cmd.args, 120000);
    const health = await collectHealthSnapshot();
    res.json({
      ok: true,
      action,
      manager: SERVICE_MANAGER,
      service: CLIPROXY_SERVICE_NAME,
      stdout,
      stderr,
      health
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "web", "index.html"));
});

const DASHBOARD_HOST = process.env.DASHBOARD_HOST || "0.0.0.0";
app.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.log(`Dashboard running at http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
});

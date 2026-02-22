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
  process.env.ACTIVE_CONFIG_PATH || "/opt/homebrew/etc/cliproxyapi.conf";
const LOCAL_LOG_PATH = process.env.LOCAL_LOG_PATH || path.join(ROOT_DIR, "cliproxyapi.log");
const SYNC_SCRIPT_PATH = process.env.SYNC_SCRIPT_PATH || path.join(ROOT_DIR, "sync_codex_auths.sh");
const CLIPROXY_BASE_URL = process.env.CLIPROXY_BASE_URL || "http://127.0.0.1:8317";
const CLIPROXY_SERVICE_NAME = process.env.CLIPROXY_SERVICE_NAME || "cliproxyapi";
const SERVICE_MANAGER = String(process.env.SERVICE_MANAGER || "brew").toLowerCase();
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8328);

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

async function getDashboardApiKey() {
  const configText = await readTextIfExists(LOCAL_CONFIG_PATH);
  const matched = configText.match(/api-keys:\s*\n\s*-\s*["']?([^"'\n]+)["']?/m);
  return matched ? matched[1].trim() : "";
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

async function getServiceStatus() {
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

  const jsonFiles = files.filter((name) => name.endsWith(".json")).sort();
  const accounts = [];

  for (const fileName of jsonFiles) {
    const absolutePath = path.join(AUTH_DIR, fileName);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(absolutePath, "utf8"),
        fs.stat(absolutePath)
      ]);
      const parsed = JSON.parse(raw);
      accounts.push({
        file: fileName,
        email: parsed.email || "",
        type: parsed.type || "",
        accountId: compactAccountId(parsed.account_id || ""),
        lastRefresh: parsed.last_refresh || "",
        hasAccessToken: Boolean(parsed.access_token),
        hasRefreshToken: Boolean(parsed.refresh_token),
        hasIdToken: Boolean(parsed.id_token),
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
        updatedAt: ""
      });
    }
  }

  return accounts;
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

app.get("/api/models", async (req, res) => {
  try {
    const ids = await fetchProxyModels();
    res.json({
      count: ids.length,
      ids
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
      text
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

app.post("/api/actions/service", async (req, res) => {
  try {
    const action = String(req.body?.action || "").trim().toLowerCase();
    if (!["start", "stop", "restart"].includes(action)) {
      res.status(400).json({ error: "action must be one of start|stop|restart" });
      return;
    }

    const cmd =
      SERVICE_MANAGER === "systemd"
        ? { command: "systemctl", args: [action, CLIPROXY_SERVICE_NAME] }
        : { command: "brew", args: ["services", action, CLIPROXY_SERVICE_NAME] };

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

app.listen(DASHBOARD_PORT, "127.0.0.1", () => {
  console.log(`Dashboard running at http://127.0.0.1:${DASHBOARD_PORT}`);
});

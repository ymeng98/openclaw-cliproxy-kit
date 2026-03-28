const fs = require("fs/promises");
const { createLogOffsetStore } = require("../state/log-offset-store");

function defaultAlertMatcher(line) {
  const text = String(line || "");
  if (!text) {
    return false;
  }
  if (/\[(warn|error)\s*\]/i.test(text)) {
    return true;
  }
  if (/timeout|i\/o timeout|context deadline exceeded|rate limit|too many requests/i.test(text)) {
    return true;
  }
  if (/gin_logger\.go:\d+\].*\b(401|429|500|502|503)\b/.test(text)) {
    return true;
  }
  if (/\b(401|429|500|502|503)\b/.test(text) && /POST\s+\"(\/v1\/responses|\/v1\/chat\/completions)\"/.test(text)) {
    return true;
  }
  return false;
}

function appendBounded(target, value, maxItems) {
  target.push(value);
  const overflow = target.length - maxItems;
  if (overflow > 0) {
    target.splice(0, overflow);
  }
}

async function readRange(filePath, start, end) {
  const begin = Math.max(0, Number(start || 0));
  const finish = Math.max(begin, Number(end || 0));
  const length = Math.max(0, finish - begin);
  if (length <= 0) {
    return "";
  }

  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, begin);
    return buffer.slice(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function createLogAnalyzer(options = {}) {
  const enabled = Boolean(options.enabled);
  const logPath = String(options.logPath || "");
  const cacheSize = Math.max(100, Number(options.cacheSize || 500));
  const initialReadBytes = Math.max(64 * 1024, Number(options.initialReadBytes || 512 * 1024));
  const maxReadBytesPerCycle = Math.max(64 * 1024, Number(options.maxReadBytesPerCycle || 2 * 1024 * 1024));
  const legacyReadTail = options.legacyReadTail;
  const alertMatcher = typeof options.alertMatcher === "function" ? options.alertMatcher : defaultAlertMatcher;
  const store = options.store || createLogOffsetStore();

  async function refreshState() {
    if (!enabled) {
      return;
    }

    let stat;
    try {
      stat = await fs.stat(logPath);
    } catch {
      store.reset(logPath);
      return;
    }

    const state = store.get(logPath);
    const size = Number(stat.size || 0);
    const inode = Number(stat.ino || 0);

    const rotatedOrTruncated =
      state.initialized && (size < Number(state.offset || 0) || (inode && state.inode && inode !== state.inode));

    if (!state.initialized || rotatedOrTruncated) {
      state.initialized = true;
      state.inode = inode;
      state.partialLine = "";
      state.recentLines = [];
      state.recentAlertLines = [];
      state.offset = Math.max(0, size - initialReadBytes);
    }

    state.inode = inode;

    if (size <= Number(state.offset || 0)) {
      return;
    }

    let start = Number(state.offset || 0);
    const unread = size - start;
    if (unread > maxReadBytesPerCycle) {
      start = size - maxReadBytesPerCycle;
    }

    const chunk = await readRange(logPath, start, size);
    state.offset = size;

    const combined = `${state.partialLine || ""}${chunk}`;
    const segments = combined.split(/\r?\n/);
    state.partialLine = segments.pop() || "";

    for (const segment of segments) {
      const line = String(segment || "").trimEnd();
      if (!line) {
        continue;
      }
      appendBounded(state.recentLines, line, cacheSize);
      if (alertMatcher(line)) {
        appendBounded(state.recentAlertLines, line, cacheSize);
      }
    }
  }

  async function getLogs(options = {}) {
    const lines = Math.max(20, Math.min(Number(options.lines || 180), 800));
    const alertsOnly = Boolean(options.alertsOnly);

    if (!enabled) {
      if (typeof legacyReadTail === "function") {
        return legacyReadTail(lines);
      }
      return "";
    }

    await refreshState();
    const state = store.get(logPath);
    const source = alertsOnly ? state.recentAlertLines : state.recentLines;
    return source.slice(-lines).join("\n");
  }

  return {
    getLogs,
    refreshState,
    getState: () => store.get(logPath)
  };
}

module.exports = {
  createLogAnalyzer,
  defaultAlertMatcher
};

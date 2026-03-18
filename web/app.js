const $ = (id) => document.getElementById(id);

const nodes = {
  serviceChip: $("service-chip"),
  metricService: $("metric-service"),
  metricPort: $("metric-port"),
  metricModels: $("metric-models"),
  metricAuths: $("metric-auths"),
  healthHint: $("health-hint"),
  output: $("ops-output"),
  hitState: $("hit-state"),
  hitTime: $("hit-time"),
  hitProvider: $("hit-provider"),
  hitModel: $("hit-model"),
  hitEmail: $("hit-email"),
  hitAuthFile: $("hit-auth-file"),
  historyState: $("history-state"),
  hitHistoryList: $("hit-history-list"),
  invalidAccountsState: $("invalid-accounts-state"),
  invalidAccountsList: $("invalid-accounts-list"),
  verifyAllAccounts: $("btn-verify-all-accounts"),
  accounts: $("accounts-grid"),
  importInput: $("account-import-input"),
  importReplace: $("account-import-replace"),
  importTarget: $("account-import-target"),
  importTargetFile: $("account-import-target-file"),
  importClearTarget: $("btn-import-clear-target"),
  models: $("models-grid"),
  modelsHint: $("models-hint"),
  modelsRestart: $("models-restart-openclaw"),
  modelStatePill: $("model-state-pill"),
  modelConfigDefault: $("model-config-default"),
  modelLastHit: $("model-last-hit"),
  localConfig: $("local-config"),
  activeConfig: $("active-config"),
  toast: $("toast")
};

const HEARTBEAT_INTERVAL_MS = 12000;
const HEARTBEAT_INTERVAL_HIDDEN_MS = 45000;
const ALERT_WINDOW_MS = 10 * 60 * 1000;

const heartbeatState = {
  timerId: null,
  inFlight: false,
  consecutiveFailures: 0,
  toastShown: false
};

const viewState = {
  renderedLogText: "",
  latestAuthHit: null,
  recentAuthHits: [],
  accounts: [],
  accountEmailByFile: {},
  accountRuntimeByFile: {},
  accountVerificationByFile: {},
  accountGroupCountByKey: {},
  importTargetFile: "",
  localSuppressedAuthHitWindows: [],
  selectedModel: {
    fullId: "",
    modelId: ""
  },
  suppressedAuthHitWindows: []
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error || payload.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

function setOutput(text) {
  nodes.output.textContent = text || "";
}

function showToast(message, isError = false) {
  nodes.toast.textContent = message;
  nodes.toast.style.borderColor = isError ? "rgba(255,94,94,0.66)" : "rgba(97,224,200,0.55)";
  nodes.toast.classList.add("show");
  setTimeout(() => nodes.toast.classList.remove("show"), 2100);
}

function classifyServiceChip(health) {
  const serviceState = String(health?.service?.status || "").toLowerCase();
  const listening = Boolean(health?.listening);
  const hasModels = Number(health?.models?.count || 0) > 0;
  const serviceReady = ["started", "running", "active"].includes(serviceState);

  if (serviceReady && listening && hasModels) {
    return { text: "ONLINE", className: "status-chip ok" };
  }
  if (serviceReady) {
    return { text: "DEGRADED", className: "status-chip warn" };
  }
  return { text: "OFFLINE", className: "status-chip bad" };
}

function renderHealth(health) {
  const serviceState = health?.service?.status || "unknown";
  const listening = health?.listening ? "YES" : "NO";
  const modelCount = Number(health?.models?.count || 0);
  const authCount = Number(health?.accounts?.count || 0);
  const checkedAt = health?.now ? new Date(health.now).toLocaleString() : "-";
  const suffix = health?.models?.error ? ` | 模型检查失败: ${health.models.error}` : "";

  nodes.metricService.textContent = serviceState;
  nodes.metricPort.textContent = listening;
  nodes.metricModels.textContent = String(modelCount);
  nodes.metricAuths.textContent = String(authCount);
  nodes.healthHint.textContent = `最近检查：${checkedAt}${suffix}`;

  const chip = classifyServiceChip(health);
  nodes.serviceChip.textContent = chip.text;
  nodes.serviceChip.className = chip.className;
}

function tokenPill(label, ok) {
  const cls = ok ? "token-pill ok" : "token-pill no";
  return `<span class="${cls}">${label}:${ok ? "Y" : "N"}</span>`;
}

function getAccountVerification(fileName) {
  return viewState.accountVerificationByFile[fileName] || null;
}

function getRuntimeStatus(fileName) {
  return viewState.accountRuntimeByFile[fileName] || null;
}

function describeAccountIssue(acc) {
  const runtime = getRuntimeStatus(acc.file);
  const verification = getAccountVerification(acc.file);

  if (verification?.status === "invalidated") {
    return {
      severity: "bad",
      title: "Token失效",
      detail: verification.detail || "验证接口已确认该账号需要重新登录"
    };
  }

  if (verification?.status === "unauthorized") {
    return {
      severity: "bad",
      title: "认证失败",
      detail: verification.detail || "验证接口返回 401，建议重新登录"
    };
  }

  if (verification?.status === "missing-token") {
    return {
      severity: "bad",
      title: "缺少凭证",
      detail: verification.detail || "当前文件没有 access_token"
    };
  }

  if (verification?.locallyExpired) {
    return {
      severity: "warnish",
      title: "本地已过期",
      detail: `expired: ${verification.expiredAt || "-"}`
    };
  }

  if (runtime?.label === "Token失效" || runtime?.label === "认证失败") {
    return {
      severity: "bad",
      title: runtime.label,
      detail: runtime.lastOutcome || runtime.suggestion || "日志显示该文件最近认证失败"
    };
  }

  return null;
}

function renderImportTarget() {
  const fileName = String(viewState.importTargetFile || "");
  if (!nodes.importTarget || !nodes.importTargetFile) {
    return;
  }
  nodes.importTarget.classList.toggle("is-hidden", !fileName);
  nodes.importTargetFile.textContent = fileName || "-";
}

function renderAccountCard(acc) {
  const runtime = getRuntimeStatus(acc.file);
  const verification = getAccountVerification(acc.file);
  const issue = describeAccountIssue(acc);
  const runtimeBadge = runtime
    ? `<span class="state-pill ${runtime.tone}">${runtime.label}</span>`
    : `<span class="state-pill idle">未诊断</span>`;
  const verificationBadge = verification
    ? `<span class="state-pill ${verification.ok ? "active" : issue?.severity || "idle"}">${verification.label || "已验证"}</span>`
    : "";
  const runtimeNote = runtime
    ? `
      <div class="account-runtime">
        <div>最近命中: ${runtime.lastHitTime || "-"}</div>
        <div>最近结果: ${runtime.lastOutcome || "-"}</div>
        <div>建议: ${runtime.suggestion || "-"}</div>
      </div>
    `
    : `
      <div class="account-runtime">
        <div>最近命中: -</div>
        <div>最近结果: 暂无近期开销</div>
        <div>建议: 等待该文件参与轮询后再判断</div>
      </div>
    `;
  const verifyNote = verification
    ? `
      <div class="account-runtime">
        <div>验证时间: ${verification.checkedAt ? new Date(verification.checkedAt).toLocaleString() : "-"}</div>
        <div>验证结果: ${verification.detail || verification.label || "-"}</div>
      </div>
    `
    : "";

  if (acc.error) {
    return `
      <article class="account-card">
        <div class="account-top">
          <div>
            <div class="account-file">${acc.file || "unknown"}</div>
            <div class="account-mail">解析失败</div>
          </div>
        </div>
        <div class="account-meta"><div>${acc.error}</div></div>
      </article>
    `;
  }

  return `
    <article class="account-card">
      <div class="account-top">
        <div>
          <div class="account-file">${acc.file}</div>
          <div class="account-mail">${acc.email || "无邮箱字段"}</div>
        </div>
        <div class="account-side">
          <div class="account-file">${acc.type || "-"}</div>
          ${acc.disabled ? `<span class="state-pill disabled">已禁用</span>` : `<span class="state-pill active">启用中</span>`}
          ${runtimeBadge}
          ${verificationBadge}
        </div>
      </div>
      <div class="account-meta">
        <div>account: ${acc.accountId || "-"}</div>
        <div>refresh: ${acc.lastRefresh || "-"}</div>
        <div>updated: ${acc.updatedAt ? new Date(acc.updatedAt).toLocaleString() : "-"}</div>
      </div>
      ${runtimeNote}
      ${verifyNote}
      <div>
        ${tokenPill("access", acc.hasAccessToken)}
        ${tokenPill("refresh", acc.hasRefreshToken)}
        ${tokenPill("id", acc.hasIdToken)}
      </div>
      <div class="account-actions">
        <button class="btn btn-mini" data-action="verify-account" data-file="${acc.file}">验证</button>
        <button class="btn btn-mini" data-action="prepare-reauth" data-file="${acc.file}">替换凭证</button>
        <button class="btn btn-mini" data-action="toggle-disabled" data-file="${acc.file}" data-disabled="${acc.disabled ? "false" : "true"}">${acc.disabled ? "启用" : "禁用"}</button>
        <button class="btn btn-mini btn-danger" data-action="delete-account" data-file="${acc.file}">删除</button>
      </div>
    </article>
  `;
}

function accountGroupKey(acc) {
  return String(acc?.rawAccountId || acc?.accountId || acc?.email || acc?.file || "");
}

function renderAccounts(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  viewState.accounts = accounts;
  viewState.accountEmailByFile = Object.fromEntries(
    accounts
      .filter((acc) => acc?.file)
      .map((acc) => [acc.file, acc.email || ""])
  );
  viewState.accountGroupCountByKey = accounts.reduce((acc, item) => {
    const key = String(item?.rawAccountId || item?.accountId || item?.email || item?.file || "");
    if (!key) {
      return acc;
    }
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  if (viewState.latestAuthHit) {
    renderLatestAuthHit(viewState.latestAuthHit);
  }
  if (viewState.recentAuthHits.length) {
    renderHitHistory(viewState.recentAuthHits);
  }
  renderInvalidAccounts();
  if (!accounts.length) {
    nodes.accounts.innerHTML = `<div class="account-card">未发现认证文件。</div>`;
    return;
  }

  const grouped = new Map();
  for (const acc of accounts) {
    const key = accountGroupKey(acc);
    const bucket = grouped.get(key) || [];
    bucket.push(acc);
    grouped.set(key, bucket);
  }

  nodes.accounts.innerHTML = Array.from(grouped.values())
    .map((group) => {
      if (group.length === 1) {
        return renderAccountCard(group[0]);
      }

      const sample = group[0];
      const emails = [...new Set(group.map((item) => item.email).filter(Boolean))];
      const hasDisabled = group.some((item) => item.disabled);
      const latestUpdated = group
        .map((item) => item.updatedAt)
        .filter(Boolean)
        .sort()
        .reverse()[0];
      const latestHitFile = String(viewState.latestAuthHit?.authFile || "");
      const shouldOpen = group.some((item) => item.file === latestHitFile);

      return `
        <details class="account-group" ${shouldOpen ? "open" : ""}>
          <summary class="account-group-summary">
            <div class="account-group-head">
              <div>
                <div class="account-group-title">同账号组 ${group.length}</div>
                <div class="account-group-subtitle">${emails.join(" / ") || sample.accountId || "同一账号"}</div>
              </div>
              <div class="account-group-badges">
                <span class="state-pill ${hasDisabled ? "disabled" : "active"}">${hasDisabled ? "含禁用项" : "全部启用"}</span>
                <span class="state-pill warnish">${sample.accountId || "同账号"}</span>
              </div>
            </div>
            <div class="account-group-meta">
              <span>文件数: ${group.length}</span>
              <span>最近更新: ${latestUpdated ? new Date(latestUpdated).toLocaleString() : "-"}</span>
              <span>${shouldOpen ? "当前命中组" : "点击展开"}</span>
            </div>
          </summary>
          <div class="account-group-body">
            ${group.map((item) => renderAccountCard(item)).join("")}
          </div>
        </details>
      `;
    })
    .join("");
}

function renderInvalidAccounts() {
  if (!nodes.invalidAccountsList || !nodes.invalidAccountsState) {
    return;
  }

  const invalidAccounts = (viewState.accounts || [])
    .filter((acc) => !acc.error)
    .map((acc) => ({
      acc,
      issue: describeAccountIssue(acc)
    }))
    .filter((entry) => entry.issue);

  if (!invalidAccounts.length) {
    nodes.invalidAccountsState.textContent = "正常";
    nodes.invalidAccountsState.className = "state-pill active";
    nodes.invalidAccountsList.innerHTML = `<div class="history-empty">最近没有已判定失效的账号文件</div>`;
    return;
  }

  nodes.invalidAccountsState.textContent = `${invalidAccounts.length} 个`;
  nodes.invalidAccountsState.className = "state-pill bad";
  nodes.invalidAccountsList.innerHTML = invalidAccounts
    .map(({ acc, issue }) => {
      const verification = getAccountVerification(acc.file);
      return `
        <article class="invalid-card">
          <div class="invalid-top">
            <div>
              <div class="account-file">${acc.file}</div>
              <div class="account-mail">${acc.email || "无邮箱字段"}</div>
            </div>
            <span class="state-pill ${issue.severity}">${issue.title}</span>
          </div>
          <div class="invalid-detail">${issue.detail}</div>
          <div class="account-meta">
            <div>account: ${acc.accountId || "-"}</div>
            <div>最近验证: ${verification?.checkedAt ? new Date(verification.checkedAt).toLocaleString() : "-"}</div>
          </div>
          <div class="account-actions">
            <button class="btn btn-mini" data-action="verify-account" data-file="${acc.file}">重新验证</button>
            <button class="btn btn-mini btn-main" data-action="prepare-reauth" data-file="${acc.file}">准备重登</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderModels(payload) {
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  const selectedModel = String(payload?.selected?.modelId || "");
  const selectedFullId = String(payload?.selected?.fullId || "");
  viewState.selectedModel = {
    modelId: selectedModel,
    fullId: selectedFullId
  };
  if (!ids.length) {
    nodes.models.innerHTML = `<span class="model-chip">暂无模型数据</span>`;
    return;
  }

  nodes.models.innerHTML = ids
    .map((id) => {
      const active = id === selectedModel;
      return `
        <button
          class="model-chip ${active ? "active" : ""}"
          data-model-id="${id}"
          type="button"
          title="${active ? `当前默认: ${selectedFullId}` : `设为默认模型: ${id}`}"
        >
          ${id}
        </button>
      `;
    })
    .join("");

  if (nodes.modelsHint) {
    nodes.modelsHint.textContent = selectedFullId
      ? `当前默认模型：${selectedFullId}。点击其他模型可直接切换。`
      : "点击模型可直接设为 OpenClaw 当前默认代理模型。";
  }
  renderModelState();
}

function renderConfig(payload) {
  nodes.localConfig.textContent = payload?.localConfig || "读取失败";
  nodes.activeConfig.textContent = payload?.activeConfig || "读取失败";
}

function renderLatestAuthHit(hit) {
  viewState.latestAuthHit = hit || null;
  if (!hit) {
    nodes.hitState.textContent = "等待请求";
    nodes.hitState.className = "state-pill idle";
    nodes.hitTime.textContent = "-";
    nodes.hitProvider.textContent = "-";
    nodes.hitModel.textContent = "-";
    nodes.hitEmail.textContent = "-";
    nodes.hitAuthFile.textContent = "-";
    renderModelState();
    return;
  }

  nodes.hitState.textContent = "已命中";
  nodes.hitState.className = "state-pill active";
  nodes.hitTime.textContent = hit.time || "-";
  nodes.hitProvider.textContent = hit.provider || "-";
  nodes.hitModel.textContent = hit.model || "-";
  nodes.hitEmail.textContent = guessEmailFromAuthFile(hit.authFile) || hit.email || "-";
  nodes.hitAuthFile.textContent = hit.authFile || "-";
  renderModelState();
}

function renderModelState() {
  const selectedFullId = String(viewState.selectedModel?.fullId || "");
  const selectedModelId = String(viewState.selectedModel?.modelId || "");
  const latestHitModel = String(viewState.latestAuthHit?.model || "");

  nodes.modelConfigDefault.textContent = selectedFullId || "-";
  nodes.modelLastHit.textContent = latestHitModel || "-";

  if (!selectedModelId) {
    nodes.modelStatePill.textContent = "未配置";
    nodes.modelStatePill.className = "state-pill idle";
    return;
  }

  if (!latestHitModel) {
    nodes.modelStatePill.textContent = "待验证";
    nodes.modelStatePill.className = "state-pill idle";
    return;
  }

  if (latestHitModel === selectedModelId) {
    nodes.modelStatePill.textContent = "已生效";
    nodes.modelStatePill.className = "state-pill active";
    return;
  }

  nodes.modelStatePill.textContent = "待生效";
  nodes.modelStatePill.className = "state-pill disabled";
}

function guessEmailFromAuthFile(fileName) {
  if (viewState.accountEmailByFile[fileName]) {
    return viewState.accountEmailByFile[fileName];
  }
  const baseName = String(fileName || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.json$/i, "")
    .replace(/-(added|team)$/i, "");
  const match = baseName.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : "";
}

function parseAuthHit(line) {
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
    model: match[4],
    email: guessEmailFromAuthFile(match[3])
  };
}

function rememberLocalSuppressedAuthHits(fileNames, durationMs = 45000) {
  const startedAt = Date.now() - 3000;
  const endedAt = Date.now() + durationMs;
  for (const fileName of fileNames) {
    if (!fileName) {
      continue;
    }
    viewState.localSuppressedAuthHitWindows.push({
      source: "dashboard-verify",
      fileName,
      startMs: startedAt,
      endMs: endedAt
    });
  }
  const cutoff = Date.now() - 30 * 60 * 1000;
  viewState.localSuppressedAuthHitWindows = viewState.localSuppressedAuthHitWindows.filter(
    (item) => Number(item?.endMs || 0) >= cutoff
  );
}

function parseLogTimestampText(line) {
  const match = String(line || "").match(/^\[([0-9-]{10} [0-9:]{8})\]/);
  return match ? match[1] : "";
}

function parseLogTimestamp(line) {
  const match = String(line || "").match(/^\[([0-9-]{10} [0-9:]{8})\]/);
  if (!match) {
    return null;
  }
  const value = new Date(match[1].replace(" ", "T"));
  return Number.isNaN(value.getTime()) ? null : value;
}

function isSuppressedAuthHit(line) {
  const authHit = parseAuthHit(line);
  if (!authHit) {
    return false;
  }
  const timestamp = parseLogTimestamp(line);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    return false;
  }
  return viewState.suppressedAuthHitWindows.some((item) => {
    const sameFile = String(item?.fileName || "") === authHit.authFile;
    const startMs = Number(item?.startMs || 0);
    const endMs = Number(item?.endMs || 0);
    return sameFile && startMs && endMs && timestamp.getTime() >= startMs && timestamp.getTime() <= endMs;
  }) || viewState.localSuppressedAuthHitWindows.some((item) => {
    const sameFile = String(item?.fileName || "") === authHit.authFile;
    const startMs = Number(item?.startMs || 0);
    const endMs = Number(item?.endMs || 0);
    return sameFile && startMs && endMs && timestamp.getTime() >= startMs && timestamp.getTime() <= endMs;
  });
}

function parseRequestId(line) {
  const match = String(line || "").match(/^\[[^\]]+\]\s+\[([^\]]+)\]/);
  if (!match || match[1] === "--------") {
    return "";
  }
  return match[1];
}

function isWithinRecentWindow(dateValue, anchor) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
    return false;
  }
  if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) {
    return true;
  }
  return anchor.getTime() - dateValue.getTime() <= ALERT_WINDOW_MS;
}

function classifyAlertLine(line) {
  const text = String(line || "");
  const timestamp = parseLogTimestamp(text);
  const time = timestamp ? timestamp.toLocaleTimeString("zh-CN", { hour12: false }) : "--:--:--";

  if (/token has been invalidated|authentication token has been invalidated|error status: 401/i.test(text)) {
    return {
      time,
      category: "认证失效",
      detail: "上游 OAuth token 已失效，需要重新认证"
    };
  }

  if (/validation failed .*level \"minimal\" not supported/i.test(text)) {
    return {
      time,
      category: "参数不兼容",
      detail: "thinking=minimal 不被当前 gpt-5.4 接受，已回退到支持级别"
    };
  }

  if (/address already in use|bind: address already in use/i.test(text)) {
    return {
      time,
      category: "端口占用",
      detail: "代理启动时端口 8317 被占用"
    };
  }

  if (/unknown provider for model/i.test(text)) {
    return {
      time,
      category: "模型映射错误",
      detail: "请求模型名与代理支持的 provider/model 不匹配"
    };
  }

  if (/POST\s+\"\/v1\/responses\"/.test(text) && /\b502\b/.test(text)) {
    return {
      time,
      category: "上游配置错误",
      detail: "代理快速返回 502，通常是模型映射或 provider 配置有误"
    };
  }

  if (/POST\s+\"\/v1\/responses\"/.test(text) && /\b500\b/.test(text)) {
    const duration = text.match(/\|\s+([0-9.]+s)\s+\|/);
    return {
      time,
      category: "上游请求失败",
      detail: `responses 接口返回 500${duration ? `，耗时 ${duration[1]}` : ""}`
    };
  }

  if (/rate limit/i.test(text)) {
    return {
      time,
      category: "限流",
      detail: "上游账号或模型达到速率限制"
    };
  }

  if (/timeout|i\/o timeout|context deadline exceeded/i.test(text)) {
    return {
      time,
      category: "超时",
      detail: "请求上游超时"
    };
  }

  if (/\[(warn|error)\s*\]/i.test(text)) {
    return {
      time,
      category: "其他告警",
      detail: text.replace(/^\[[^\]]+\]\s*/, "")
    };
  }

  return null;
}

function collapseAlertItems(items) {
  const collapsed = [];
  for (const item of items) {
    const key = `${item.category}||${item.detail}`;
    const last = collapsed[collapsed.length - 1];
    if (last && last.key === key) {
      last.count += 1;
      last.time = item.time;
      continue;
    }
    collapsed.push({
      key,
      time: item.time,
      category: item.category,
      detail: item.detail,
      count: 1
    });
  }
  return collapsed;
}

function buildAccountRuntimeMap(lines) {
  const runtimeByFile = {};
  const requestToAuthFile = {};

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const timestamp = parseLogTimestamp(line);
    const timeText = timestamp
      ? timestamp.toLocaleTimeString("zh-CN", { hour12: false })
      : "-";
    const requestId = parseRequestId(line);
    const authHit = parseAuthHit(line);

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

    if (!requestId) {
      continue;
    }

    const authFile = requestToAuthFile[requestId];
    if (!authFile) {
      continue;
    }

    const current = runtimeByFile[authFile] || {};

    if (/request error, error status:\s*401/i.test(line) || /token has been invalidated/i.test(line)) {
      runtimeByFile[authFile] = {
        ...current,
        label: "Token失效",
        tone: "bad",
        lastOutcome: `${timeText} 401 认证失效`,
        suggestion: "重新登录该账号，或导入新的 accessToken"
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
        label: "最近成功",
        tone: "active",
        lastOutcome: `${timeText} ${statusCode} 请求成功`,
        suggestion: "该文件最近可正常使用"
      };
      continue;
    }

    if (statusCode === 500) {
      runtimeByFile[authFile] = {
        ...current,
        label: "上游500",
        tone: "disabled",
        lastOutcome: `${timeText} ${statusCode} 上游请求失败`,
        suggestion: "优先重试；若持续出现，单独登录验证该账号"
      };
      continue;
    }

    if (statusCode === 429) {
      runtimeByFile[authFile] = {
        ...current,
        label: "请求限流",
        tone: "warnish",
        lastOutcome: `${timeText} ${statusCode} 触发限流`,
        suggestion: "降低并发或切换到其他账号"
      };
      continue;
    }

    if (statusCode === 502 || statusCode === 503) {
      runtimeByFile[authFile] = {
        ...current,
        label: "代理异常",
        tone: "disabled",
        lastOutcome: `${timeText} ${statusCode} 代理/上游异常`,
        suggestion: "检查模型映射或上游服务状态"
      };
      continue;
    }

    if (statusCode === 401) {
      runtimeByFile[authFile] = {
        ...current,
        label: "认证失败",
        tone: "bad",
        lastOutcome: `${timeText} ${statusCode} 未授权`,
        suggestion: "重新登录该账号，确认凭证仍有效"
      };
    }
  }

  return runtimeByFile;
}

function renderHitHistory(hits) {
  const list = Array.isArray(hits) ? hits : [];
  viewState.recentAuthHits = list;
  if (!nodes.hitHistoryList || !nodes.historyState) {
    return;
  }

  if (!list.length) {
    nodes.historyState.textContent = "暂无";
    nodes.historyState.className = "state-pill idle";
    nodes.hitHistoryList.innerHTML = `<div class="history-empty">最近没有命中记录</div>`;
    return;
  }

  nodes.historyState.textContent = `${list.length} 条`;
  nodes.historyState.className = "state-pill active";
  nodes.hitHistoryList.innerHTML = list
    .map((hit) => {
      return `
        <article class="history-card">
          <div class="history-top">
            <span class="history-model">${hit.model || "-"}</span>
            <span class="history-time">${hit.time || "-"}</span>
          </div>
          <div class="history-meta">
            <div>provider: ${hit.provider || "-"}</div>
            <div>email: ${guessEmailFromAuthFile(hit.authFile) || hit.email || "-"}</div>
            <div>file: ${hit.authFile || "-"}</div>
          </div>
        </article>
      `;
    })
    .join("");
}

function shouldKeepLogLine(line) {
  const text = String(line || "");
  if (!text) {
    return false;
  }
  if (/\[(warn|error)\s*\]/i.test(text)) {
    return true;
  }
  if (/AUTH-(MISS|FAIL|INVALID)/i.test(text)) {
    return true;
  }
  if (/rate limit|invalidated oauth|timeout|failed|panic|fatal/i.test(text)) {
    return true;
  }
  if (/gin_logger\.go:\d+\].*\b(401|403|409|429|500|502|503)\b/.test(text)) {
    return true;
  }
  if (/gin_logger\.go:\d+\].*\b(200|404)\b/.test(text)) {
    return false;
  }
  if (/\[debug\]/i.test(text)) {
    return false;
  }
  if (/apply\.go:/i.test(text)) {
    return false;
  }
  return false;
}

function renderLogs(payload) {
  const raw = String(payload?.text || "").trim();
  viewState.suppressedAuthHitWindows = Array.isArray(payload?.suppressedAuthHits)
    ? payload.suppressedAuthHits
    : [];
  if (!raw) {
    if (viewState.renderedLogText !== "暂无日志") {
      nodes.output.textContent = "暂无日志";
      viewState.renderedLogText = "暂无日志";
    }
    return;
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const visibleLines = lines.filter((line) => !isSuppressedAuthHit(line));
  const datedLines = lines
    .map((line) => ({ line, timestamp: parseLogTimestamp(line) }))
    .filter((item) => item.timestamp);
  const anchor = datedLines.length ? datedLines[datedLines.length - 1].timestamp : null;
  const recentLines = visibleLines.filter((line) => isWithinRecentWindow(parseLogTimestamp(line), anchor));
  viewState.accountRuntimeByFile = buildAccountRuntimeMap(recentLines);
  const latestFirst = visibleLines.slice().reverse();
  const recentAuthHits = recentLines
    .slice()
    .reverse()
    .map(parseAuthHit)
    .filter(Boolean);
  const authHits = latestFirst.map(parseAuthHit).filter(Boolean);
  const latestAuthHit = authHits[0] || null;
  const filtered = collapseAlertItems(
    recentLines
      .slice()
      .reverse()
      .filter(shouldKeepLogLine)
      .map(classifyAlertLine)
      .filter(Boolean)
  ).slice(0, 8);

  renderLatestAuthHit(latestAuthHit);
  renderHitHistory((recentAuthHits.length ? recentAuthHits : authHits).slice(0, 5));
  if (viewState.accounts.length) {
    renderAccounts({ accounts: viewState.accounts });
  } else {
    renderInvalidAccounts();
  }

  const sections = [];
  if (filtered.length) {
    sections.push(
      [
        "近10分钟异常与告警",
        ...filtered.map((item) =>
          `${item.time} | ${item.category} | ${item.detail}${item.count > 1 ? ` | x${item.count}` : ""}`
        )
      ].join("\n")
    );
  } else if (!latestAuthHit) {
    sections.push("最近没有可展示的关键日志");
  } else {
    sections.push("近10分钟没有异常或告警日志");
  }

  const nextText = sections.join("\n\n");
  if (nextText === viewState.renderedLogText) {
    return;
  }
  nodes.output.textContent = nextText;
  viewState.renderedLogText = nextText;
}

async function refreshHealth() {
  const health = await api("/api/health");
  renderHealth(health);
}

async function refreshAccounts() {
  const payload = await api("/api/accounts");
  renderAccounts(payload);
}

async function refreshModels() {
  const payload = await api("/api/models");
  renderModels(payload);
}

async function selectModel(modelId) {
  try {
    const restart = Boolean(nodes.modelsRestart?.checked);
    const payload = await api("/api/models/select", {
      method: "POST",
      body: JSON.stringify({ modelId, restart })
    });
    renderModels(payload);
    await refreshLogs();
    const selectedName = payload?.selected?.fullId || modelId;
    showToast(
      restart
        ? `默认模型已切到 ${selectedName}，并已重启 OpenClaw`
        : `默认模型已写入 ${selectedName}，下次重启或新会话时生效`
    );
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("模型切换失败", true);
  }
}

async function refreshConfig() {
  const payload = await api("/api/config");
  renderConfig(payload);
}

async function refreshLogs() {
  const payload = await api("/api/logs?lines=180");
  renderLogs(payload);
}

async function refreshAll() {
  const tasks = [
    refreshHealth(),
    refreshAccounts(),
    refreshModels(),
    refreshConfig(),
    refreshLogs()
  ];
  const results = await Promise.allSettled(tasks);
  const rejected = results.filter((item) => item.status === "rejected");
  if (rejected.length) {
    const message = rejected[0]?.reason?.message || "部分刷新失败";
    showToast(message, true);
  }
}

function nextHeartbeatDelay() {
  return document.visibilityState === "visible"
    ? HEARTBEAT_INTERVAL_MS
    : HEARTBEAT_INTERVAL_HIDDEN_MS;
}

function scheduleHeartbeat(delay = nextHeartbeatDelay()) {
  if (heartbeatState.timerId) {
    clearTimeout(heartbeatState.timerId);
  }
  heartbeatState.timerId = window.setTimeout(runHeartbeat, delay);
}

async function runHeartbeat() {
  if (heartbeatState.inFlight) {
    scheduleHeartbeat();
    return;
  }

  heartbeatState.inFlight = true;
  try {
    const results = await Promise.allSettled([refreshHealth(), refreshLogs()]);
    const hasFailure = results.some((item) => item.status === "rejected");
    if (hasFailure) {
      heartbeatState.consecutiveFailures += 1;
      if (heartbeatState.consecutiveFailures >= 2 && !heartbeatState.toastShown) {
        showToast("心跳刷新失败，请手动刷新检查", true);
        heartbeatState.toastShown = true;
      }
    } else {
      heartbeatState.consecutiveFailures = 0;
      heartbeatState.toastShown = false;
    }
  } finally {
    heartbeatState.inFlight = false;
    scheduleHeartbeat();
  }
}

async function runSync() {
  try {
    const payload = await api("/api/actions/sync", { method: "POST" });
    if (payload.health) {
      renderHealth(payload.health);
    }
    await refreshAccounts();
    await refreshLogs();
    showToast("凭证同步完成");
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("同步失败", true);
  }
}

async function runServiceAction(action) {
  try {
    const payload = await api("/api/actions/service", {
      method: "POST",
      body: JSON.stringify({ action })
    });
    if (payload.health) {
      renderHealth(payload.health);
    }
    await refreshModels();
    await refreshLogs();
    showToast(`服务操作完成: ${action}`);
  } catch (error) {
    setOutput(String(error.message || error));
    showToast(`服务操作失败: ${action}`, true);
  }
}

async function runImportAccount() {
  const raw = String(nodes.importInput?.value || "").trim();
  if (!raw) {
    showToast("先粘贴 token 或 JSON", true);
    return;
  }

  try {
    const mode = nodes.importReplace?.checked ? "replace-latest" : "append";
    const targetFile = String(viewState.importTargetFile || "");
    const payload = await api("/api/accounts/import", {
      method: "POST",
      body: JSON.stringify({ raw, mode, targetFile })
    });
    const imported = payload.imported || {};
    const report = [
      "[account import]",
      `file: ${imported.fileName || "-"}`,
      `email: ${imported.email || "-"}`,
      `account: ${imported.accountId || "-"}`,
      `expired: ${imported.expired || "-"}`,
      `target: ${imported.targetedFile || "-"}`,
      `mode: ${imported.replacedExisting ? "replaced existing file" : "created new file"}`,
      `inherit refresh: ${imported.inheritedRefreshToken ? "yes" : "no"}`,
      `inherit id: ${imported.inheritedIdToken ? "yes" : "no"}`,
      `account files: ${imported.matchingAccountCount || payload.count || "-"}`,
      imported.duplicateFiles?.length
        ? `duplicates: ${imported.duplicateFiles.join(", ")}`
        : "duplicates: none"
    ].join("\n");

    nodes.importInput.value = "";
    viewState.importTargetFile = "";
    renderImportTarget();
    renderAccounts(payload);
    await refreshHealth();
    await refreshLogs();
    showToast(
      imported.targetedFile
        ? `已覆盖 ${imported.targetedFile}`
        : imported.duplicateFiles?.length
          ? "已写入，且检测到同账号文件"
          : "账号已写入认证目录"
    );
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("账号写入失败", true);
  }
}

async function runVerifyAccount(file) {
  try {
    rememberLocalSuppressedAuthHits([file]);
    const payload = await api(`/api/accounts/${encodeURIComponent(file)}/verify`, {
      method: "POST"
    });
    const verification = payload?.verification || null;
    if (verification) {
      viewState.accountVerificationByFile[file] = verification;
    }
    renderInvalidAccounts();
    renderAccounts({ accounts: viewState.accounts });
    setOutput(
      [
        "[account verify]",
        `file: ${verification?.file || file}`,
        `status: ${verification?.status || "-"}`,
        `label: ${verification?.label || "-"}`,
        `detail: ${verification?.detail || "-"}`,
        `checked: ${verification?.checkedAt || "-"}`
      ].join("\n")
    );
    showToast(verification?.ok ? "账号验证成功" : `验证结果: ${verification?.label || "失败"}`, !verification?.ok);
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("账号验证失败", true);
  }
}

async function runVerifyAllAccounts() {
  try {
    rememberLocalSuppressedAuthHits((viewState.accounts || []).map((item) => item.file));
    const payload = await api("/api/accounts/verify-all", {
      method: "POST"
    });
    const verifications = Array.isArray(payload?.verifications) ? payload.verifications : [];
    for (const item of verifications) {
      if (item?.file) {
        viewState.accountVerificationByFile[item.file] = item;
      }
    }
    renderAccounts({ accounts: viewState.accounts });
    setOutput(
      [
        "[account verify all]",
        ...verifications.map((item) => `${item.file} | ${item.status || "-"} | ${item.label || "-"} | ${item.detail || "-"}`)
      ].join("\n")
    );
    const failedCount = verifications.filter((item) => !item.ok).length;
    showToast(
      failedCount ? `已验证 ${verifications.length} 个账号，异常 ${failedCount} 个` : `已验证 ${verifications.length} 个账号`,
      failedCount > 0
    );
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("批量验证失败", true);
  }
}

function prepareReauth(file) {
  viewState.importTargetFile = String(file || "");
  renderImportTarget();
  nodes.importInput?.focus();
  showToast(`后续写入将覆盖 ${file}`);
}

async function runToggleAccount(file, disabled) {
  try {
    const payload = await api(`/api/accounts/${encodeURIComponent(file)}/toggle-disabled`, {
      method: "POST",
      body: JSON.stringify({ disabled })
    });
    renderAccounts(payload);
    await refreshHealth();
    await refreshLogs();
    showToast(disabled ? "账号已禁用" : "账号已启用");
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("账号状态更新失败", true);
  }
}

async function runDeleteAccount(file) {
  if (!window.confirm(`确认删除账号文件？\n${file}`)) {
    return;
  }

  try {
    const payload = await api(`/api/accounts/${encodeURIComponent(file)}`, {
      method: "DELETE"
    });
    renderAccounts(payload);
    await refreshHealth();
    await refreshLogs();
    showToast(payload?.gone ? "文件已不存在，列表已刷新" : "账号文件已删除");
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("账号删除失败", true);
  }
}

function bindActions() {
  $("btn-refresh").addEventListener("click", async () => {
    await refreshAll();
    showToast("刷新完成");
  });

  $("btn-sync").addEventListener("click", runSync);
  $("btn-import-account").addEventListener("click", runImportAccount);
  nodes.verifyAllAccounts?.addEventListener("click", runVerifyAllAccounts);
  nodes.importClearTarget?.addEventListener("click", () => {
    viewState.importTargetFile = "";
    renderImportTarget();
  });
  $("btn-restart").addEventListener("click", () => runServiceAction("restart"));
  $("btn-start").addEventListener("click", () => runServiceAction("start"));
  $("btn-stop").addEventListener("click", () => runServiceAction("stop"));
  $("btn-models").addEventListener("click", refreshModels);
  $("btn-logs").addEventListener("click", refreshLogs);
  $("btn-config").addEventListener("click", refreshConfig);
  nodes.models.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-model-id]");
    if (!button) {
      return;
    }
    await selectModel(button.dataset.modelId || "");
  });
  nodes.accounts.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const file = button.dataset.file || "";
    const action = button.dataset.action || "";
    if (action === "toggle-disabled") {
      await runToggleAccount(file, button.dataset.disabled === "true");
      return;
    }
    if (action === "verify-account") {
      await runVerifyAccount(file);
      return;
    }
    if (action === "prepare-reauth") {
      prepareReauth(file);
      return;
    }
    if (action === "delete-account") {
      await runDeleteAccount(file);
    }
  });
  nodes.invalidAccountsList?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const file = button.dataset.file || "";
    const action = button.dataset.action || "";
    if (action === "verify-account") {
      await runVerifyAccount(file);
      return;
    }
    if (action === "prepare-reauth") {
      prepareReauth(file);
    }
  });
}

bindActions();
renderImportTarget();
refreshAll();
scheduleHeartbeat();
document.addEventListener("visibilitychange", () => scheduleHeartbeat(1000));

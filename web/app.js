const $ = (id) => document.getElementById(id);

const nodes = {
  serviceChip: $("service-chip"),
  metricService: $("metric-service"),
  metricServiceCheck: $("metric-service-check"),
  metricPort: $("metric-port"),
  metricModels: $("metric-models"),
  metricAuths: $("metric-auths"),
  output: $("ops-output"),
  invalidAccountsState: $("invalid-accounts-state"),
  invalidAccountsList: $("invalid-accounts-list"),
  invalidPanel: document.querySelector(".invalid-panel"),
  verifyAllAccounts: $("btn-verify-all-accounts"),
  usageAllAccounts: $("btn-usage-all-accounts"),
  accounts: $("accounts-grid"),
  accountCardTemplate: $("account-card-template"),
  verifyAllModal: $("verify-all-modal"),
  verifyAllModalClose: $("btn-verify-all-modal-close"),
  verifyAllModalOutput: $("verify-all-modal-output"),
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
  toast: $("toast"),
  globalSearch: $("global-search")
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
  accounts: [],
  accountRuntimeByFile: {},
  accountVerificationByFile: {},
  accountUsageByFile: {},
  accountGroupCountByKey: {},
  importTargetFile: "",
  searchQuery: "",
  localSuppressedAuthHitWindows: [],
  selectedModel: {
    fullId: "",
    modelId: ""
  },
  modelIds: [],
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
    const message =
      (payload?.error && typeof payload.error === "object" ? payload.error.message : payload?.error) ||
      payload?.message ||
      `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload;
}

function setOutput(text) {
  nodes.output.textContent = text || "";
}

function setVerifyAllModalOutput(text) {
  if (!nodes.verifyAllModalOutput) {
    return;
  }
  nodes.verifyAllModalOutput.textContent = text || "";
}

function openVerifyAllModal(text = "") {
  if (!nodes.verifyAllModal) {
    return;
  }
  setVerifyAllModalOutput(text);
  nodes.verifyAllModal.classList.remove("is-hidden");
  nodes.verifyAllModal.setAttribute("aria-hidden", "false");
}

function closeVerifyAllModal() {
  if (!nodes.verifyAllModal) {
    return;
  }
  nodes.verifyAllModal.classList.add("is-hidden");
  nodes.verifyAllModal.setAttribute("aria-hidden", "true");
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
  const suffix = health?.models?.error ? `（模型检查失败: ${health.models.error}）` : "";

  nodes.metricService.textContent = serviceState;
  if (nodes.metricServiceCheck) {
    nodes.metricServiceCheck.textContent = `最近检查：${checkedAt}${suffix}`;
  }
  nodes.metricPort.textContent = listening;
  nodes.metricModels.textContent = String(modelCount);
  nodes.metricAuths.textContent = String(authCount);

  const chip = classifyServiceChip(health);
  nodes.serviceChip.textContent = chip.text;
  nodes.serviceChip.className = chip.className;
  nodes.metricService.textContent = `${chip.text} / ${serviceState}`;
}

function getAccountVerification(fileName) {
  return viewState.accountVerificationByFile[fileName] || null;
}

function getAccountUsage(fileName) {
  return viewState.accountUsageByFile[fileName] || null;
}

function getRuntimeStatus(fileName) {
  return viewState.accountRuntimeByFile[fileName] || null;
}

function normPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
}

function usageTone(p) {
  if (p === null) {
    return "na";
  }
  if (p <= 15) {
    return "danger";
  }
  if (p <= 40) {
    return "warn";
  }
  return "ok";
}

function getUsagePercents(usage) {
  const scopedUsage = usage?.usage || usage || {};
  const primary = scopedUsage?.primaryWindow || {};
  const secondary = scopedUsage?.secondaryWindow || {};
  const primaryUsed = normPercent(primary?.usedPercent);
  const secondaryUsed = normPercent(secondary?.usedPercent);
  const today = normPercent(
    usage?.fiveHourRemainingPercent ??
      scopedUsage?.fiveHourRemainingPercent ??
      primary?.remainingPercent ??
      (primaryUsed === null ? null : 100 - primaryUsed)
  );
  const cycle = normPercent(
    usage?.weeklyRemainingPercent ??
      scopedUsage?.weeklyRemainingPercent ??
      secondary?.remainingPercent ??
      (secondaryUsed === null ? null : 100 - secondaryUsed)
  );
  return {
    today,
    cycle,
    stale: Boolean(usage?.stale)
  };
}

function riskScore(acc) {
  const usage = getAccountUsage(acc?.file || "") || acc?.usage || null;
  const { today, cycle } = getUsagePercents(usage);
  const score = Math.max(
    today === null ? -1 : 100 - today,
    cycle === null ? -1 : 100 - cycle
  );
  return Number.isFinite(score) ? score : -1;
}

function buildRuntimeFromVerification(verification) {
  if (!verification || typeof verification !== "object") {
    return null;
  }

  const checkedAtText = verification.checkedAt
    ? new Date(verification.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "-";
  const status = String(verification.status || "").trim().toLowerCase();

  if (verification.ok || status === "valid") {
    return {
      label: "验证通过",
      tone: "active",
      lastOutcome: `${checkedAtText} ${verification.label || "模型返回OK"}`,
      suggestion: "账号可正常使用"
    };
  }

  if (status === "invalidated" || status === "unauthorized") {
    return {
      label: "认证失败",
      tone: "bad",
      lastOutcome: `${checkedAtText} ${verification.detail || verification.label || "认证失败"}`,
      suggestion: "重新登录该账号后再验证"
    };
  }

  if (status === "rate-limited" || status === "cooling-down") {
    return {
      label: "请求限流",
      tone: "warnish",
      lastOutcome: `${checkedAtText} ${verification.detail || verification.label || "触发限流"}`,
      suggestion: "等待冷却后重试"
    };
  }

  if (status === "missing-token") {
    return {
      label: "缺少凭证",
      tone: "bad",
      lastOutcome: `${checkedAtText} ${verification.detail || verification.label || "缺少 access_token"}`,
      suggestion: "补充可用凭证后再验证"
    };
  }

  if (status === "upstream-500" || status === "proxy-error" || status === "proxy-check-failed") {
    return {
      label: verification.label || "代理异常",
      tone: "disabled",
      lastOutcome: `${checkedAtText} ${verification.detail || verification.label || "验证失败"}`,
      suggestion: "检查代理服务与上游状态"
    };
  }

  return null;
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
  if (!nodes.accountCardTemplate || !(nodes.accountCardTemplate instanceof HTMLTemplateElement)) {
    return null;
  }

  if (acc.error) {
    const fallback = document.createElement("article");
    fallback.className = "account-card-lite";
    fallback.innerHTML = `
      <div class="account-card-head">
        <div class="account-ident">
          <div class="account-email">${acc.file || "unknown"}</div>
          <div class="account-file-lite">解析失败</div>
        </div>
      </div>
      <div class="account-hit-lite">${acc.error}</div>
    `;
    return fallback;
  }

  const fragment = nodes.accountCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".account-card-lite");
  if (!card) {
    return null;
  }

  const usage = getAccountUsage(acc.file) || acc.usage || null;
  const runtime = getRuntimeStatus(acc.file) || {};
  const { today, cycle, stale } = getUsagePercents(usage);
  const minRemaining = Math.min(today ?? 101, cycle ?? 101);

  const emailNode = card.querySelector('[data-role="email"]');
  const statusNode = card.querySelector('[data-role="status"]');
  const staleNode = card.querySelector('[data-role="usage-stale"]');
  const hitNode = card.querySelector('[data-role="last-hit"]');
  const todayTextNode = card.querySelector('[data-role="today-text"]');
  const cycleTextNode = card.querySelector('[data-role="cycle-text"]');
  const todayBarNode = card.querySelector('[data-role="today-bar"]');
  const cycleBarNode = card.querySelector('[data-role="cycle-bar"]');

  if (emailNode) {
    emailNode.textContent = acc.email || "无邮箱字段";
  }
  if (statusNode) {
    statusNode.textContent = acc.disabled ? "已禁用" : "启用中";
    let statusClass = "active";
    if (acc.disabled) {
      statusClass = "disabled";
    } else if (today === null && cycle === null) {
      statusClass = "idle";
    } else if (minRemaining <= 15) {
      statusClass = "bad";
    } else if (minRemaining <= 40) {
      statusClass = "warnish";
    }
    statusNode.className = `state-pill ${statusClass}`;
  }
  if (staleNode) {
    staleNode.textContent = "缓存过期";
    staleNode.className = `state-pill ${stale ? "warnish" : "is-hidden"}`;
    staleNode.classList.toggle("is-hidden", !stale);
  }
  if (hitNode) {
    hitNode.textContent = runtime.lastHitTime || "-";
  }

  const todayText = today === null ? "--%" : `${today}%`;
  const cycleText = cycle === null ? "--%" : `${cycle}%`;
  if (todayTextNode) {
    todayTextNode.textContent = todayText;
  }
  if (cycleTextNode) {
    cycleTextNode.textContent = cycleText;
  }
  if (todayBarNode) {
    todayBarNode.style.width = today === null ? "0%" : `${today}%`;
    todayBarNode.className = `usage-fill tone-${usageTone(today)}`;
  }
  if (cycleBarNode) {
    cycleBarNode.style.width = cycle === null ? "0%" : `${cycle}%`;
    cycleBarNode.className = `usage-fill tone-${usageTone(cycle)}`;
  }

  return card;
}

function accountGroupKey(acc) {
  return String(acc?.rawAccountId || acc?.accountId || acc?.email || acc?.file || "");
}

function renderAccounts(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  viewState.accounts = accounts;
  viewState.accountGroupCountByKey = accounts.reduce((acc, item) => {
    const key = String(item?.rawAccountId || item?.accountId || item?.email || item?.file || "");
    if (!key) {
      return acc;
    }
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const allowedFiles = new Set(accounts.filter((item) => item?.file).map((item) => item.file));
  const retainedUsageByFile = Object.fromEntries(
    Object.entries(viewState.accountUsageByFile).filter(([fileName]) => allowedFiles.has(fileName))
  );
  for (const account of accounts) {
    if (account?.file && account?.usage) {
      retainedUsageByFile[account.file] = account.usage;
    }
  }
  viewState.accountUsageByFile = retainedUsageByFile;
  renderInvalidAccounts();
  if (!accounts.length) {
    nodes.accounts.innerHTML = `<div class="account-card">未发现认证文件。</div>`;
    return;
  }
  const keyword = String(viewState.searchQuery || "").trim().toLowerCase();
  const filtered = keyword
    ? accounts.filter((item) => {
        const text = [
          item?.email || "",
          item?.file || "",
          item?.type || "",
          item?.accountId || ""
        ]
          .join(" ")
          .toLowerCase();
        return text.includes(keyword);
      })
    : accounts;

  const sorted = filtered
    .slice()
    .sort((a, b) => riskScore(b) - riskScore(a));

  nodes.accounts.innerHTML = "";
  if (!sorted.length) {
    nodes.accounts.innerHTML = `<div class="history-empty">没有匹配当前搜索条件的账号</div>`;
    return;
  }
  for (const item of sorted) {
    const card = renderAccountCard(item);
    if (card) {
      nodes.accounts.appendChild(card);
    }
  }
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
    nodes.invalidPanel?.classList.remove("has-issues");
    nodes.invalidAccountsState.textContent = "正常";
    nodes.invalidAccountsState.className = "state-pill active";
    nodes.invalidAccountsList.innerHTML = `<div class="history-empty">最近没有已判定失效的账号文件</div>`;
    return;
  }

  nodes.invalidPanel?.classList.add("has-issues");
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
  viewState.modelIds = ids;
  viewState.selectedModel = {
    modelId: selectedModel,
    fullId: selectedFullId
  };
  if (!ids.length) {
    nodes.models.innerHTML = `<span class="model-chip">暂无模型数据</span>`;
    return;
  }

  const keyword = String(viewState.searchQuery || "").trim().toLowerCase();
  const visibleIds = keyword ? ids.filter((id) => String(id || "").toLowerCase().includes(keyword)) : ids;
  if (!visibleIds.length) {
    nodes.models.innerHTML = `<span class="model-chip">没有匹配当前搜索条件的模型</span>`;
    return;
  }

  nodes.models.innerHTML = visibleIds
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

function parseAuthHit(line) {
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

function shouldKeepLogLine(line) {
  const text = String(line || "");
  if (!text) {
    return false;
  }
  if (/AUTH-HIT/i.test(text)) {
    return false;
  }
  if (/\[(warn|error)\s*\]/i.test(text)) {
    return true;
  }
  if (/rate limit|invalidated oauth|token has been invalidated|timeout|deadline exceeded|failed|panic|fatal/i.test(text)) {
    return true;
  }
  if (/gin_logger\.go:\d+\].*\b(401|403|408|409|429|500|502|503)\b/.test(text)) {
    return true;
  }
  if (/gin_logger\.go:\d+\].*\b(200|204|304|404)\b/.test(text)) {
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
  const latestAuthHit = visibleLines
    .slice()
    .reverse()
    .map(parseAuthHit)
    .find(Boolean) || null;
  viewState.latestAuthHit = latestAuthHit;
  renderModelState();
  const filtered = collapseAlertItems(
    recentLines
      .slice()
      .reverse()
      .filter(shouldKeepLogLine)
      .map(classifyAlertLine)
      .filter(Boolean)
  ).slice(0, 8);

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

function confirmServiceAction(action) {
  if (action === "start") {
    return true;
  }
  if (action === "restart") {
    return window.confirm("确认重启代理服务？这会短暂中断当前请求。");
  }
  if (action === "stop") {
    const keyword = window.prompt("停止服务属于危险操作，请输入 STOP 确认：", "");
    return String(keyword || "").trim().toUpperCase() === "STOP";
  }
  return true;
}

async function runServiceAction(action) {
  if (!confirmServiceAction(action)) {
    showToast("已取消操作");
    return;
  }
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

async function runFetchAccountUsage(file) {
  try {
    const payload = await api(`/api/accounts/${encodeURIComponent(file)}/usage`, {
      method: "POST"
    });
    const usage = payload?.usage || null;
    if (usage?.file) {
      viewState.accountUsageByFile[usage.file] = usage;
    }
    renderAccounts({ accounts: viewState.accounts });
    setOutput(
      [
        "[account usage]",
        `file: ${usage?.file || file}`,
        `status: ${usage?.status || "-"}`,
        `label: ${usage?.label || "-"}`,
        `detail: ${usage?.detail || "-"}`,
        `checked: ${usage?.checkedAt || "-"}`
      ].join("\n")
    );
    showToast(usage?.ok ? "用量查询成功" : `用量查询结果: ${usage?.label || "失败"}`, !usage?.ok);
  } catch (error) {
    setOutput(String(error.message || error));
    showToast("用量查询失败", true);
  }
}

async function runFetchAllAccountUsage() {
  try {
    openVerifyAllModal(
      [
        "[account usage all]",
        `started: ${new Date().toLocaleString()}`,
        "status: running",
        "正在逐个查询账号用量，请稍候..."
      ].join("\n")
    );

    const payload = await api("/api/accounts/usage-all", {
      method: "POST"
    });
    const usages = Array.isArray(payload?.usages) ? payload.usages : [];
    for (const item of usages) {
      if (item?.file) {
        viewState.accountUsageByFile[item.file] = item;
      }
    }
    renderAccounts({ accounts: viewState.accounts });
    const report = [
      "[account usage all]",
      `finished: ${new Date().toLocaleString()}`,
      `total: ${usages.length}`,
      ...usages.map((item) => `${item.file} | ${item.status || "-"} | ${item.label || "-"} | ${item.detail || "-"}`)
    ].join("\n");
    setOutput(report);
    setVerifyAllModalOutput(report);
    const failedCount = usages.filter((item) => !item.ok).length;
    showToast(
      failedCount ? `已查询 ${usages.length} 个账号，异常 ${failedCount} 个` : `已查询 ${usages.length} 个账号用量`,
      failedCount > 0
    );
  } catch (error) {
    const message = String(error.message || error);
    setOutput(message);
    openVerifyAllModal(
      [
        "[account usage all]",
        `finished: ${new Date().toLocaleString()}`,
        "status: failed",
        message
      ].join("\n")
    );
    showToast("批量用量查询失败", true);
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
    openVerifyAllModal(
      [
        "[account verify all]",
        `started: ${new Date().toLocaleString()}`,
        "status: running",
        "正在逐个验证账号，请稍候..."
      ].join("\n")
    );
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
    const report = [
      "[account verify all]",
      `finished: ${new Date().toLocaleString()}`,
      `total: ${verifications.length}`,
      ...verifications.map((item) => `${item.file} | ${item.status || "-"} | ${item.label || "-"} | ${item.detail || "-"}`)
    ].join("\n");
    setOutput(report);
    setVerifyAllModalOutput(report);
    const failedCount = verifications.filter((item) => !item.ok).length;
    showToast(
      failedCount ? `已验证 ${verifications.length} 个账号，异常 ${failedCount} 个` : `已验证 ${verifications.length} 个账号`,
      failedCount > 0
    );
  } catch (error) {
    const message = String(error.message || error);
    setOutput(message);
    openVerifyAllModal(
      [
        "[account verify all]",
        `finished: ${new Date().toLocaleString()}`,
        "status: failed",
        message
      ].join("\n")
    );
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
  nodes.usageAllAccounts?.addEventListener("click", runFetchAllAccountUsage);
  nodes.verifyAllModalClose?.addEventListener("click", closeVerifyAllModal);
  nodes.verifyAllModal?.addEventListener("click", (event) => {
    if (event.target === nodes.verifyAllModal) {
      closeVerifyAllModal();
    }
  });
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
  nodes.globalSearch?.addEventListener("input", () => {
    viewState.searchQuery = String(nodes.globalSearch?.value || "").trim();
    renderAccounts({ accounts: viewState.accounts });
    renderModels({
      ids: viewState.modelIds,
      selected: viewState.selectedModel
    });
  });
  nodes.invalidAccountsList?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const file = button.dataset.file || "";
    const action = button.dataset.action || "";
    if (action === "usage-account") {
      await runFetchAccountUsage(file);
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
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeVerifyAllModal();
  }
});

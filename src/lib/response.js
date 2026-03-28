const crypto = require("crypto");
const { normalizeUnknownError } = require("./errors");

function createRequestId() {
  const rand = crypto.randomBytes(4).toString("hex");
  return `req_${Date.now().toString(36)}_${rand}`;
}

function requestContextMiddleware() {
  return (req, res, next) => {
    req.requestId = createRequestId();
    req.requestStartedAtMs = Date.now();
    next();
  };
}

function buildMeta(req) {
  return {
    requestId: String(req.requestId || ""),
    durationMs: Math.max(0, Date.now() - Number(req.requestStartedAtMs || Date.now()))
  };
}

function sendSuccess(req, res, payload, options = {}) {
  const status = Number(options.status || 200);
  const v2Enabled = Boolean(options.v2Enabled);

  if (!v2Enabled) {
    res.status(status).json(payload);
    return;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    res.status(status).json({
      ...payload,
      ok: true,
      data: payload,
      error: null,
      meta: buildMeta(req)
    });
    return;
  }

  res.status(status).json({
    ok: true,
    data: payload,
    error: null,
    meta: buildMeta(req)
  });
}

function sendError(req, res, error, options = {}) {
  const v2Enabled = Boolean(options.v2Enabled);
  const mapped = normalizeUnknownError(error);

  if (!v2Enabled) {
    res.status(mapped.status).json({
      ok: false,
      error: mapped.message,
      code: mapped.code,
      details: mapped.details || null
    });
    return;
  }

  res.status(mapped.status).json({
    ok: false,
    data: null,
    error: {
      code: mapped.code,
      message: mapped.message,
      details: mapped.details || null
    },
    message: mapped.message,
    meta: buildMeta(req)
  });
}

function asyncRoute(handler, options = {}) {
  return async (req, res) => {
    try {
      const payload = await handler(req, res);
      if (res.headersSent || typeof payload === "undefined") {
        return;
      }
      sendSuccess(req, res, payload, {
        status: Number(options.status || 200),
        v2Enabled: Boolean(options.v2Enabled)
      });
    } catch (error) {
      sendError(req, res, error, { v2Enabled: Boolean(options.v2Enabled) });
    }
  };
}

module.exports = {
  requestContextMiddleware,
  sendSuccess,
  sendError,
  asyncRoute
};

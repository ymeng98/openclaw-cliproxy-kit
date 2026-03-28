const ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  FILE_IO_ERROR: "FILE_IO_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR"
};

const DEFAULT_STATUS_BY_CODE = {
  [ERROR_CODES.INVALID_INPUT]: 400,
  [ERROR_CODES.AUTH_EXPIRED]: 401,
  [ERROR_CODES.UPSTREAM_UNAVAILABLE]: 502,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.FILE_IO_ERROR]: 500,
  [ERROR_CODES.INTERNAL_ERROR]: 500
};

class ApiError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || code || "internal error"));
    this.name = "ApiError";
    this.code = code || ERROR_CODES.INTERNAL_ERROR;
    this.status = Number(options.status || DEFAULT_STATUS_BY_CODE[this.code] || 500);
    this.details = options.details || null;
    this.cause = options.cause;
  }
}

function createApiError(code, message, options = {}) {
  return new ApiError(code, message, options);
}

function normalizeUnknownError(error) {
  if (error instanceof ApiError) {
    return error;
  }

  const message = String(error?.message || error || "internal error");
  const status = Number(error?.status || error?.httpStatus || 0);
  const fileCode = String(error?.code || "").toUpperCase();
  const text = message.toLowerCase();

  if (status === 400 || /invalid|schema|zod|validation/.test(text)) {
    return createApiError(ERROR_CODES.INVALID_INPUT, message, {
      status: 400,
      details: error?.details || null,
      cause: error
    });
  }

  if (
    status === 401 ||
    /token has been invalidated|authentication token has been invalidated|token expired|sign in again|unauthorized/.test(text)
  ) {
    return createApiError(ERROR_CODES.AUTH_EXPIRED, message, {
      status: 401,
      details: error?.details || null,
      cause: error
    });
  }

  if (status === 429 || /rate limit|too many requests|429/.test(text)) {
    return createApiError(ERROR_CODES.RATE_LIMITED, message, {
      status: 429,
      details: error?.details || null,
      cause: error
    });
  }

  if (["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR"].includes(fileCode)) {
    return createApiError(ERROR_CODES.FILE_IO_ERROR, message, {
      status: 500,
      details: { fileCode },
      cause: error
    });
  }

  if (
    status >= 500 ||
    /timeout|timed out|abort|network|upstream|proxy|fetch failed|econnrefused|enotfound/.test(text)
  ) {
    return createApiError(ERROR_CODES.UPSTREAM_UNAVAILABLE, message, {
      status: status >= 500 && status < 600 ? status : 502,
      details: error?.details || null,
      cause: error
    });
  }

  return createApiError(ERROR_CODES.INTERNAL_ERROR, message, {
    status: status >= 400 && status < 600 ? status : 500,
    details: error?.details || null,
    cause: error
  });
}

module.exports = {
  ApiError,
  ERROR_CODES,
  createApiError,
  normalizeUnknownError
};

function normalizeErrorMessage(error, fallback = 'Unknown storage error') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error.message === 'string' && error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}

function classifyStorageError(error, status) {
  if (error?.code === 'SERVER_MISCONFIGURED') {
    return {
      code: 'SERVER_MISCONFIGURED',
      message: error?.detail || 'Server encryption key is not configured. Set CONFIG_ENCRYPTION_KEY or SESSION_SECRET.',
      retriable: false,
    };
  }

  const message = normalizeErrorMessage(error).toLowerCase();
  const statusCode = Number(status || 0);

  const byStatus = (codes) => codes.includes(statusCode);
  const byMessage = (pattern) => pattern.test(message);

  if (
    byStatus([401, 403]) ||
    byMessage(/\bauth|unauthori[sz]ed|forbidden|invalid token|permission denied\b/)
  ) {
    return {
      code: 'AUTH_FAILED',
      message: 'Authentication failed or permission denied.',
      retriable: false,
    };
  }

  if (
    byStatus([429]) ||
    byMessage(/\brate limit|too many requests|flood wait|throttle\b/)
  ) {
    return {
      code: 'RATE_LIMITED',
      message: 'Rate limit reached, retry later.',
      retriable: true,
    };
  }

  if (
    byStatus([413, 507, 509]) ||
    byMessage(/\bquota|insufficient storage|storage limit|file too large|payload too large\b/)
  ) {
    return {
      code: 'QUOTA_EXCEEDED',
      message: 'Storage quota or size limit exceeded.',
      retriable: false,
    };
  }

  if (
    byStatus([404]) ||
    byMessage(/\bnot found|path does not exist|no such file|missing resource\b/)
  ) {
    return {
      code: 'PATH_NOT_FOUND',
      message: 'Target path or resource does not exist.',
      retriable: false,
    };
  }

  if (
    byMessage(/\bconfig_encryption_key\b|\bsession_secret\b|\bfile_url_secret\b|encrypted storage configs/)
  ) {
    return {
      code: 'SERVER_MISCONFIGURED',
      message: 'Server encryption key is not configured. Set CONFIG_ENCRYPTION_KEY or SESSION_SECRET.',
      retriable: false,
    };
  }

  if (
    byMessage(/\bnot configured|missing required|requires .*token|requires .*id\b/)
  ) {
    return {
      code: 'NOT_CONFIGURED',
      message: 'Storage adapter is not configured yet.',
      retriable: false,
    };
  }

  if (
    byStatus([408, 502, 503, 504]) ||
    byMessage(/\bnetwork|timeout|timed out|fetch failed|econn|enotfound|eai_again|socket\b/)
  ) {
    return {
      code: 'NETWORK_ERROR',
      message: 'Network timeout or upstream connectivity issue.',
      retriable: true,
    };
  }

  return {
    code: 'UNKNOWN',
    message: 'Unexpected storage error.',
    retriable: false,
  };
}

function toStorageErrorPayload(error, status) {
  const statusCode = Number(status || error?.status || 0) || undefined;
  const normalized = classifyStorageError(error, statusCode);
  return {
    ...normalized,
    detail: normalizeErrorMessage(error),
    status: statusCode,
  };
}

module.exports = {
  classifyStorageError,
  normalizeErrorMessage,
  toStorageErrorPayload,
};

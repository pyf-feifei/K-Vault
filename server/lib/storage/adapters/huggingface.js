function normalizeToken(value) {
  if (!value) return '';
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

function normalizeRepo(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/^datasets\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commitUrl(repo, branch = 'main') {
  return `https://huggingface.co/api/datasets/${repo}/commit/${encodeURIComponent(branch)}`;
}

function resolveUrl(repo, pathInRepo) {
  return `https://huggingface.co/datasets/${repo}/resolve/main/${pathInRepo}`;
}

function shouldRetryStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status || 0));
}

function isRetryableError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'AbortError'
    || /\bfetch failed|timed out|timeout|socket|econn|enotfound|eai_again\b/.test(message);
}

async function parseErrorBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json().catch(() => ({}));
    return json.error || json.message || JSON.stringify(json);
  }
  return response.text().catch(() => '');
}

async function discardResponseBody(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // best effort
  }
}

async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const {
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 1000,
    operation = 'HuggingFace request',
  } = retryOptions;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (shouldRetryStatus(response.status) && attempt < retries) {
        await discardResponseBody(response);
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timer);

      if (attempt < retries && isRetryableError(error)) {
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }

      if (error?.name === 'AbortError') {
        throw new Error(`${operation} timed out after ${timeoutMs}ms.`);
      }

      throw error;
    }
  }

  throw new Error(`${operation} failed after ${retries + 1} attempts.`);
}

class HuggingFaceStorageAdapter {
  constructor(config) {
    this.type = 'huggingface';
    this.config = {
      token: normalizeToken(config.token),
      repo: normalizeRepo(config.repo),
    };
  }

  validate() {
    if (!this.config.token || !this.config.repo) {
      throw new Error('HuggingFace storage requires token and repo.');
    }
  }

  authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.config.token}`,
      ...extra,
    };
  }

  async testConnection() {
    this.validate();

    const response = await fetchWithRetry(
      `https://huggingface.co/api/datasets/${this.config.repo}`,
      {
        headers: this.authHeaders(),
      },
      {
        timeoutMs: 15000,
        retries: 2,
        retryDelayMs: 1000,
        operation: 'HuggingFace connection test',
      }
    );

    return {
      connected: response.ok,
      status: response.status,
    };
  }

  async upload({ storageKey, buffer, fileName }) {
    this.validate();

    const maxSize = 35 * 1024 * 1024;
    if (buffer.byteLength > maxSize) {
      throw new Error('HuggingFace regular upload limit exceeded (35MB).');
    }

    const pathInRepo = storageKey;
    const body = [
      JSON.stringify({ key: 'header', value: { summary: `Upload ${fileName || pathInRepo}` } }),
      JSON.stringify({
        key: 'file',
        value: {
          path: pathInRepo,
          encoding: 'base64',
          content: toBase64(buffer),
        },
      }),
    ].join('\n');

    const response = await fetchWithRetry(
      commitUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
        body,
      },
      {
        timeoutMs: 120000,
        retries: 2,
        retryDelayMs: 2000,
        operation: 'HuggingFace upload',
      }
    );

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace upload failed (${response.status}).`);
    }

    return {
      storageKey: pathInRepo,
      metadata: {
        hfPath: pathInRepo,
        hfCommit: json.commitOid || null,
      },
    };
  }

  async download({ metadata = {}, storageKey, range }) {
    const pathInRepo = metadata.hfPath || storageKey;
    const headers = {};
    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }
    if (range) headers.Range = range;

    const response = await fetchWithRetry(
      resolveUrl(this.config.repo, pathInRepo),
      {
        headers,
        redirect: 'follow',
      },
      {
        timeoutMs: 30000,
        retries: 2,
        retryDelayMs: 1000,
        operation: 'HuggingFace download',
      }
    );

    if (!response.ok && response.status !== 206) {
      if (response.status === 404) return null;
      const detail = await parseErrorBody(response);
      throw new Error(detail || `HuggingFace download failed (${response.status}).`);
    }

    return response;
  }

  async delete({ metadata = {}, storageKey }) {
    this.validate();

    const pathInRepo = metadata.hfPath || storageKey;
    const body = [
      JSON.stringify({ key: 'header', value: { summary: `Delete ${pathInRepo}` } }),
      JSON.stringify({ key: 'deletedFile', value: { path: pathInRepo } }),
    ].join('\n');

    const response = await fetchWithRetry(
      commitUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
        body,
      },
      {
        timeoutMs: 60000,
        retries: 2,
        retryDelayMs: 1500,
        operation: 'HuggingFace delete',
      }
    );

    return Boolean(response.ok);
  }
}

module.exports = {
  HuggingFaceStorageAdapter,
};

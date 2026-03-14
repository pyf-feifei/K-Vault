const crypto = require('node:crypto');

const HF_ENDPOINT = 'https://huggingface.co';
const HF_BRANCH = 'main';
const DEFAULT_CAPACITY_THRESHOLD_GB = 100;
const CAPACITY_CACHE_TTL_MS = 60 * 1000;
const HF_LFS_HEADERS = {
  Accept: 'application/vnd.git-lfs+json',
  'Content-Type': 'application/vnd.git-lfs+json',
};

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

function toBytesFromGb(value, fallbackGb = DEFAULT_CAPACITY_THRESHOLD_GB) {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  const normalized = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackGb;
  return Math.round(normalized * 1024 * 1024 * 1024);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commitUrl(repo, branch = HF_BRANCH) {
  return `${HF_ENDPOINT}/api/datasets/${repo}/commit/${encodeURIComponent(branch)}`;
}

function resolveUrl(repo, pathInRepo) {
  return `${HF_ENDPOINT}/datasets/${repo}/resolve/${HF_BRANCH}/${pathInRepo}`;
}

function preuploadUrl(repo, branch = HF_BRANCH) {
  return `${HF_ENDPOINT}/api/datasets/${repo}/preupload/${encodeURIComponent(branch)}`;
}

function lfsBatchUrl(repo) {
  return `${HF_ENDPOINT}/datasets/${repo}.git/info/lfs/objects/batch`;
}

function datasetInfoUrl(repo) {
  return `${HF_ENDPOINT}/api/datasets/${repo}?expand=usedStorage`;
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

function getUploadInfo(buffer) {
  const content = Buffer.from(buffer);
  return {
    content,
    size: content.byteLength,
    sample: content.subarray(0, Math.min(512, content.byteLength)),
    oid: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function getCompletionPayload(etags, oid) {
  return {
    oid,
    parts: etags.map((etag, index) => ({
      partNumber: index + 1,
      etag,
    })),
  };
}

function getSortedPartUrls(header, uploadInfo, chunkSize) {
  const partUrls = Object.entries(header || {})
    .filter(([key]) => /^\d+$/.test(key))
    .map(([key, value]) => [Number.parseInt(key, 10), value])
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value);

  const expectedParts = Math.ceil(uploadInfo.size / chunkSize);
  if (partUrls.length !== expectedParts) {
    throw new Error('Invalid HuggingFace LFS multipart upload response.');
  }
  return partUrls;
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
      capacityThresholdBytes: toBytesFromGb(config.capacityThresholdGb),
    };
    this.capacityCache = null;
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

  async getCapacityInfo({ forceRefresh = false } = {}) {
    this.validate();

    if (
      !forceRefresh
      && this.capacityCache
      && (Date.now() - this.capacityCache.fetchedAt) < CAPACITY_CACHE_TTL_MS
    ) {
      return this.capacityCache;
    }

    const response = await fetchWithRetry(
      datasetInfoUrl(this.config.repo),
      {
        headers: this.authHeaders(),
      },
      {
        timeoutMs: 15000,
        retries: 2,
        retryDelayMs: 1000,
        operation: 'HuggingFace capacity query',
      }
    );

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace capacity query failed (${response.status}).`);
    }

    const usedBytes = Number(json.usedStorage || 0);
    const thresholdBytes = this.config.capacityThresholdBytes;
    const usagePercent = thresholdBytes > 0 ? (usedBytes / thresholdBytes) * 100 : 0;

    this.capacityCache = {
      repo: this.config.repo,
      usedBytes,
      thresholdBytes,
      remainingBytes: Math.max(0, thresholdBytes - usedBytes),
      usagePercent,
      withinThreshold: usedBytes < thresholdBytes,
      fetchedAt: Date.now(),
    };

    return this.capacityCache;
  }

  async requestUploadMode(pathInRepo, uploadInfo) {
    const response = await fetchWithRetry(
      preuploadUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          files: [
            {
              path: pathInRepo,
              sample: uploadInfo.sample.toString('base64'),
              size: uploadInfo.size,
            },
          ],
        }),
      },
      {
        timeoutMs: 15000,
        retries: 2,
        retryDelayMs: 1000,
        operation: 'HuggingFace preupload check',
      }
    );

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace preupload failed (${response.status}).`);
    }

    const fileInfo = Array.isArray(json.files) ? json.files[0] : null;
    if (!fileInfo?.uploadMode) {
      throw new Error('HuggingFace preupload response missing upload mode.');
    }

    return fileInfo;
  }

  async requestLfsBatch(uploadInfo) {
    const response = await fetchWithRetry(
      lfsBatchUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders(HF_LFS_HEADERS),
        body: JSON.stringify({
          operation: 'upload',
          transfers: ['basic', 'multipart'],
          objects: [
            {
              oid: uploadInfo.oid,
              size: uploadInfo.size,
            },
          ],
          hash_algo: 'sha256',
          ref: {
            name: HF_BRANCH,
          },
        }),
      },
      {
        timeoutMs: 20000,
        retries: 2,
        retryDelayMs: 1500,
        operation: 'HuggingFace LFS batch request',
      }
    );

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace LFS batch failed (${response.status}).`);
    }

    const objectInfo = Array.isArray(json.objects) ? json.objects[0] : null;
    if (objectInfo?.error?.message) {
      throw new Error(objectInfo.error.message);
    }
    if (!objectInfo?.oid || typeof objectInfo.size !== 'number') {
      throw new Error('Malformed HuggingFace LFS batch response.');
    }

    return objectInfo;
  }

  async uploadLfsBuffer(uploadInfo, lfsInfo) {
    const actions = lfsInfo.actions;
    if (!actions?.upload) {
      return;
    }

    const uploadAction = actions.upload;
    const header = uploadAction.header || {};
    const chunkSize = header.chunk_size ? Number.parseInt(String(header.chunk_size), 10) : null;

    if (chunkSize && Number.isFinite(chunkSize) && chunkSize > 0) {
      const partUrls = getSortedPartUrls(header, uploadInfo, chunkSize);
      const etags = [];

      for (let index = 0; index < partUrls.length; index += 1) {
        const start = index * chunkSize;
        const end = Math.min(uploadInfo.size, start + chunkSize);
        const partBuffer = uploadInfo.content.subarray(start, end);
        const response = await fetchWithRetry(
          partUrls[index],
          {
            method: 'PUT',
            body: partBuffer,
          },
          {
            timeoutMs: 120000,
            retries: 2,
            retryDelayMs: 1500,
            operation: `HuggingFace LFS multipart upload part ${index + 1}`,
          }
        );

        if (!response.ok) {
          const detail = await parseErrorBody(response);
          throw new Error(detail || `HuggingFace LFS multipart upload failed (${response.status}).`);
        }

        const etag = response.headers.get('etag');
        if (!etag) {
          throw new Error(`HuggingFace LFS multipart upload missing etag for part ${index + 1}.`);
        }
        etags.push(etag);
      }

      const completion = await fetchWithRetry(
        uploadAction.href,
        {
          method: 'POST',
          headers: HF_LFS_HEADERS,
          body: JSON.stringify(getCompletionPayload(etags, uploadInfo.oid)),
        },
        {
          timeoutMs: 30000,
          retries: 2,
          retryDelayMs: 1000,
          operation: 'HuggingFace LFS multipart completion',
        }
      );

      if (!completion.ok) {
        const detail = await parseErrorBody(completion);
        throw new Error(detail || `HuggingFace LFS multipart completion failed (${completion.status}).`);
      }
    } else {
      const response = await fetchWithRetry(
        uploadAction.href,
        {
          method: 'PUT',
          body: uploadInfo.content,
        },
        {
          timeoutMs: 120000,
          retries: 2,
          retryDelayMs: 1500,
          operation: 'HuggingFace LFS upload',
        }
      );

      if (!response.ok) {
        const detail = await parseErrorBody(response);
        throw new Error(detail || `HuggingFace LFS upload failed (${response.status}).`);
      }
    }

    if (actions.verify?.href) {
      const verify = await fetchWithRetry(
        actions.verify.href,
        {
          method: 'POST',
          headers: this.authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            oid: uploadInfo.oid,
            size: uploadInfo.size,
          }),
        },
        {
          timeoutMs: 20000,
          retries: 2,
          retryDelayMs: 1000,
          operation: 'HuggingFace LFS verify',
        }
      );

      if (!verify.ok) {
        const detail = await parseErrorBody(verify);
        throw new Error(detail || `HuggingFace LFS verify failed (${verify.status}).`);
      }
    }
  }

  async commitRegularFile(pathInRepo, uploadInfo, fileName) {
    const response = await fetchWithRetry(
      commitUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
        body: [
          JSON.stringify({ key: 'header', value: { summary: `Upload ${fileName || pathInRepo}` } }),
          JSON.stringify({
            key: 'file',
            value: {
              path: pathInRepo,
              encoding: 'base64',
              content: toBase64(uploadInfo.content),
            },
          }),
        ].join('\n'),
      },
      {
        timeoutMs: 120000,
        retries: 2,
        retryDelayMs: 2000,
        operation: 'HuggingFace regular commit upload',
      }
    );

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace upload failed (${response.status}).`);
    }
    return json;
  }

  async commitLfsFile(pathInRepo, uploadInfo, fileName) {
    const response = await fetchWithRetry(
      commitUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
        body: [
          JSON.stringify({ key: 'header', value: { summary: `Upload ${fileName || pathInRepo}` } }),
          JSON.stringify({
            key: 'lfsFile',
            value: {
              path: pathInRepo,
              algo: 'sha256',
              oid: uploadInfo.oid,
              size: uploadInfo.size,
            },
          }),
        ].join('\n'),
      },
      {
        timeoutMs: 120000,
        retries: 2,
        retryDelayMs: 2000,
        operation: 'HuggingFace LFS commit',
      }
    );

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace LFS commit failed (${response.status}).`);
    }
    return json;
  }

  async testConnection() {
    this.validate();
    const capacity = await this.getCapacityInfo({ forceRefresh: true });

    return {
      connected: true,
      status: 200,
      usedBytes: capacity.usedBytes,
      thresholdBytes: capacity.thresholdBytes,
      remainingBytes: capacity.remainingBytes,
      usagePercent: capacity.usagePercent,
      withinThreshold: capacity.withinThreshold,
    };
  }

  async upload({ storageKey, buffer, fileName }) {
    this.validate();

    const maxSize = 35 * 1024 * 1024;
    if (buffer.byteLength > maxSize) {
      throw new Error('HuggingFace regular upload limit exceeded (35MB).');
    }

    const pathInRepo = storageKey;
    const uploadInfo = getUploadInfo(buffer);
    const modeInfo = await this.requestUploadMode(pathInRepo, uploadInfo);

    let commitResult;
    if (modeInfo.uploadMode === 'lfs') {
      const lfsInfo = await this.requestLfsBatch(uploadInfo);
      await this.uploadLfsBuffer(uploadInfo, lfsInfo);
      commitResult = await this.commitLfsFile(pathInRepo, uploadInfo, fileName);
    } else {
      commitResult = await this.commitRegularFile(pathInRepo, uploadInfo, fileName);
    }

    return {
      storageKey: pathInRepo,
      metadata: {
        hfPath: pathInRepo,
        hfCommit: commitResult.commitOid || null,
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
    const response = await fetchWithRetry(
      commitUrl(this.config.repo),
      {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
        body: [
          JSON.stringify({ key: 'header', value: { summary: `Delete ${pathInRepo}` } }),
          JSON.stringify({ key: 'deletedFile', value: { path: pathInRepo } }),
        ].join('\n'),
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

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function toBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return defaultValue;
}

function toBytes(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const normalized = String(value).trim().toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/);
  if (!match) return fallback;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;

  const unit = match[2] || 'B';
  const multipliers = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };

  return Math.round(amount * (multipliers[unit] || 1));
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildCacheHash(fileId) {
  return crypto.createHash('sha1').update(String(fileId || '')).digest('hex');
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader || !String(rangeHeader).startsWith('bytes=')) {
    return null;
  }

  const [startRaw, endRaw] = String(rangeHeader).slice('bytes='.length).split('-', 2);
  if (startRaw === '' && endRaw === '') {
    return { invalid: true };
  }

  let start;
  let end;

  if (startRaw === '') {
    const suffixLength = normalizePositiveInt(endRaw, 0);
    if (!suffixLength) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { invalid: true };
  }

  end = Math.min(end, size - 1);
  return {
    start,
    end,
    size: end - start + 1,
  };
}

class FileCacheService {
  constructor(config = {}) {
    this.baseConfig = this.normalizeConfig({
      enabled: config.enabled !== false,
      dir: path.resolve(config.dir || path.join(process.cwd(), 'data', 'file-cache')),
      ttlMs: Math.max(60 * 60 * 1000, Number(config.ttlMs || 7 * 24 * 60 * 60 * 1000)),
      maxBytes: Math.max(256 * 1024 * 1024, Number(config.maxBytes || 5 * 1024 * 1024 * 1024)),
      maxFiles: Math.max(100, Number(config.maxFiles || 5000)),
      minFreeBytes: Math.max(256 * 1024 * 1024, Number(config.minFreeBytes || 2 * 1024 * 1024 * 1024)),
      maxFileBytes: Math.max(1 * 1024 * 1024, Number(config.maxFileBytes || 256 * 1024 * 1024)),
    });
    this.config = { ...this.baseConfig };
    this.overrideConfig = null;
    this.cleanupPromise = null;
    this.lastCleanupAt = 0;
    this.cleanupIntervalMs = 60 * 1000;
    this.warmupPromises = new Map();
    this.metrics = {
      requests: 0,
      hit: 0,
      missFill: 0,
      missStore: 0,
      bypass: 0,
      bypassRange: 0,
    };

    if (this.config.enabled) {
      fs.mkdirSync(this.config.dir, { recursive: true });
    }
  }

  normalizeConfig(input = {}, fallback = this.baseConfig || {}) {
    const ttlMs = input.ttlMs != null
      ? Number(input.ttlMs)
      : input.ttlHours != null
        ? normalizePositiveInt(input.ttlHours, Math.round((fallback.ttlMs || 0) / (60 * 60 * 1000))) * 60 * 60 * 1000
        : fallback.ttlMs;

    return {
      enabled: toBool(input.enabled, fallback.enabled !== false),
      dir: input.dir ? path.resolve(input.dir) : fallback.dir,
      ttlMs: Math.max(60 * 60 * 1000, Number.isFinite(ttlMs) ? ttlMs : fallback.ttlMs),
      maxBytes: Math.max(256 * 1024 * 1024, toBytes(input.maxBytes, fallback.maxBytes)),
      maxFiles: Math.max(100, normalizePositiveInt(input.maxFiles, fallback.maxFiles)),
      minFreeBytes: Math.max(256 * 1024 * 1024, toBytes(input.minFreeBytes, fallback.minFreeBytes)),
      maxFileBytes: Math.max(1 * 1024 * 1024, toBytes(input.maxFileBytes, fallback.maxFileBytes)),
    };
  }

  setOverride(config = null) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      this.overrideConfig = null;
      this.config = { ...this.baseConfig };
    } else {
      this.overrideConfig = { ...config };
      this.config = this.normalizeConfig(config, this.baseConfig);
    }

    if (this.config.enabled) {
      fs.mkdirSync(this.config.dir, { recursive: true });
    }
  }

  getEditableSettings() {
    return {
      enabled: this.config.enabled,
      ttlHours: Math.round(this.config.ttlMs / (60 * 60 * 1000)),
      maxBytes: this.config.maxBytes,
      maxFiles: this.config.maxFiles,
      minFreeBytes: this.config.minFreeBytes,
      maxFileBytes: this.config.maxFileBytes,
    };
  }

  recordAccess(status) {
    if (!status) return;
    this.metrics.requests += 1;

    if (status === 'hit') this.metrics.hit += 1;
    if (status === 'miss-fill') this.metrics.missFill += 1;
    if (status === 'miss-store') this.metrics.missStore += 1;
    if (status === 'bypass') this.metrics.bypass += 1;
    if (status === 'bypass-range') this.metrics.bypassRange += 1;
  }

  async getStatus() {
    let currentBytes = 0;
    let currentFiles = 0;
    let freeBytes = Number.POSITIVE_INFINITY;

    if (this.config.enabled) {
      const entries = await this.scanEntries();
      currentFiles = entries.length;
      currentBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      freeBytes = this.getFreeBytes();
    }

    const hitRate = this.metrics.requests > 0
      ? this.metrics.hit / this.metrics.requests
      : 0;

    return {
      enabled: this.config.enabled,
      overrideActive: Boolean(this.overrideConfig),
      dir: this.config.dir,
      ttlMs: this.config.ttlMs,
      maxBytes: this.config.maxBytes,
      maxFiles: this.config.maxFiles,
      minFreeBytes: this.config.minFreeBytes,
      maxFileBytes: this.config.maxFileBytes,
      currentBytes,
      currentFiles,
      freeBytes,
      warming: this.warmupPromises.size,
      editable: this.getEditableSettings(),
      metrics: {
        ...this.metrics,
        hitRate,
      },
    };
  }

  isEnabled() {
    return this.config.enabled;
  }

  shouldCacheFile(file) {
    if (!this.config.enabled || !file) return false;
    const size = Number(file.file_size || 0);
    return Number.isFinite(size) && size > 0 && size <= this.config.maxFileBytes;
  }

  getPaths(fileId) {
    const hash = buildCacheHash(fileId);
    const shard = hash.slice(0, 2);
    const baseDir = path.join(this.config.dir, shard);
    const dataPath = path.join(baseDir, `${hash}.bin`);
    const metaPath = path.join(baseDir, `${hash}.json`);

    return {
      shard,
      baseDir,
      dataPath,
      metaPath,
      tempPath: `${dataPath}.tmp`,
      tempMetaPath: `${metaPath}.tmp`,
    };
  }

  async ensureDir(fileId) {
    const { baseDir } = this.getPaths(fileId);
    await fsp.mkdir(baseDir, { recursive: true });
  }

  async readMeta(fileId) {
    const { metaPath } = this.getPaths(fileId);
    const raw = await fsp.readFile(metaPath, 'utf8').catch(() => '');
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async writeMeta(fileId, meta) {
    const { metaPath, tempMetaPath } = this.getPaths(fileId);
    await this.ensureDir(fileId);
    await fsp.writeFile(tempMetaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await fsp.rename(tempMetaPath, metaPath);
  }

  async removeEntry(fileId) {
    const { dataPath, metaPath, tempPath, tempMetaPath } = this.getPaths(fileId);
    await Promise.allSettled([
      fsp.rm(dataPath, { force: true }),
      fsp.rm(metaPath, { force: true }),
      fsp.rm(tempPath, { force: true }),
      fsp.rm(tempMetaPath, { force: true }),
    ]);
  }

  getFreeBytes() {
    try {
      const stats = fs.statfsSync(this.config.dir);
      return Number(stats.bavail || 0) * Number(stats.bsize || 0);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  async scanEntries() {
    const entries = [];
    const stack = [this.config.dir];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const children = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        const childPath = path.join(current, child.name);
        if (child.isDirectory()) {
          stack.push(childPath);
          continue;
        }
        if (!child.isFile() || !child.name.endsWith('.json')) continue;

        let meta = {};
        try {
          meta = JSON.parse(await fsp.readFile(childPath, 'utf8').catch(() => '{}'));
        } catch {
          await fsp.rm(childPath, { force: true }).catch(() => {});
          continue;
        }
        const dataPath = childPath.replace(/\.json$/, '.bin');
        const stat = await fsp.stat(dataPath).catch(() => null);
        if (!stat || !stat.isFile()) {
          const fileId = meta?.fileId || '';
          if (fileId) {
            await this.removeEntry(fileId);
          } else {
            await fsp.rm(childPath, { force: true }).catch(() => {});
          }
          continue;
        }

        entries.push({
          fileId: meta.fileId,
          fileName: meta.fileName || meta.fileId || '',
          mimeType: meta.mimeType || '',
          dataPath,
          metaPath: childPath,
          bytes: Number(stat.size || 0),
          cachedAt: Number(meta.cachedAt || 0) || 0,
          lastAccessAt: Number(meta.lastAccessAt || meta.cachedAt || 0) || 0,
        });
      }
    }

    return entries;
  }

  async cleanup(reason = 'periodic') {
    if (!this.config.enabled) return;
    if (this.cleanupPromise) return this.cleanupPromise;

    this.cleanupPromise = (async () => {
      this.lastCleanupAt = Date.now();
      const entries = await this.scanEntries();
      const now = Date.now();
      let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      let totalFiles = entries.length;

      const sorted = [...entries].sort((left, right) => left.lastAccessAt - right.lastAccessAt);

      for (const entry of sorted) {
        if (now - entry.lastAccessAt <= this.config.ttlMs) continue;
        await this.removeEntry(entry.fileId);
        totalBytes -= entry.bytes;
        totalFiles -= 1;
      }

      let freeBytes = this.getFreeBytes();
      if (
        totalBytes <= this.config.maxBytes
        && totalFiles <= this.config.maxFiles
        && freeBytes >= this.config.minFreeBytes
      ) {
        return;
      }

      const freshEntries = await this.scanEntries();
      const victims = [...freshEntries].sort((left, right) => left.lastAccessAt - right.lastAccessAt);
      totalBytes = freshEntries.reduce((sum, entry) => sum + entry.bytes, 0);
      totalFiles = freshEntries.length;
      freeBytes = this.getFreeBytes();

      for (const entry of victims) {
        if (
          totalBytes <= this.config.maxBytes
          && totalFiles <= this.config.maxFiles
          && freeBytes >= this.config.minFreeBytes
        ) {
          break;
        }

        await this.removeEntry(entry.fileId);
        totalBytes -= entry.bytes;
        totalFiles -= 1;
        freeBytes = this.getFreeBytes();
      }
    })().finally(() => {
      this.cleanupPromise = null;
    });

    return this.cleanupPromise;
  }

  async maybeCleanup(reason = 'periodic') {
    if (!this.config.enabled) return;
    if (Date.now() - this.lastCleanupAt < this.cleanupIntervalMs) return;
    await this.cleanup(reason);
  }

  async getCachedMeta(file) {
    if (!this.shouldCacheFile(file)) return null;
    await this.maybeCleanup('lookup');

    const meta = await this.readMeta(file.id);
    if (!meta) return null;

    const { dataPath } = this.getPaths(file.id);
    const stat = await fsp.stat(dataPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      await this.removeEntry(file.id);
      return null;
    }

    const now = Date.now();
    const lastAccessAt = Number(meta.lastAccessAt || meta.cachedAt || 0) || 0;
    if (now - lastAccessAt > this.config.ttlMs) {
      await this.removeEntry(file.id);
      return null;
    }

    return {
      ...meta,
      dataPath,
      size: Number(stat.size || 0),
    };
  }

  async listEntries(limit = 100) {
    if (!this.config.enabled) return [];
    const normalizedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const entries = await this.scanEntries();
    return entries
      .sort((left, right) => right.lastAccessAt - left.lastAccessAt)
      .slice(0, normalizedLimit)
      .map((entry) => ({
        fileId: entry.fileId,
        fileName: entry.fileName,
        mimeType: entry.mimeType,
        bytes: entry.bytes,
        cachedAt: entry.cachedAt,
        lastAccessAt: entry.lastAccessAt,
      }));
  }

  async touch(fileId, meta = null) {
    const nextMeta = meta || await this.readMeta(fileId);
    if (!nextMeta) return;
    nextMeta.lastAccessAt = Date.now();
    await this.writeMeta(fileId, nextMeta);
  }

  async createResponse(file, rangeHeader, method = 'GET') {
    const meta = await this.getCachedMeta(file);
    if (!meta) return null;

    await this.touch(file.id, meta);

    const headers = new Headers();
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Type', file.mime_type || 'application/octet-stream');
    headers.set('Content-Length', String(meta.size));

    const range = parseRange(rangeHeader, meta.size);
    if (range?.invalid) {
      headers.set('Content-Range', `bytes */${meta.size}`);
      return new Response(null, { status: 416, headers });
    }

    if (!range) {
      const body = method === 'HEAD'
        ? null
        : Readable.toWeb(fs.createReadStream(meta.dataPath));
      return new Response(body, {
        status: 200,
        headers,
      });
    }

    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${meta.size}`);
    headers.set('Content-Length', String(range.size));
    const body = method === 'HEAD'
      ? null
      : Readable.toWeb(fs.createReadStream(meta.dataPath, { start: range.start, end: range.end }));

    return new Response(body, {
      status: 206,
      headers,
    });
  }

  async storeFromWebStream(file, webStream) {
    if (!this.shouldCacheFile(file) || !webStream) return;
    await this.maybeCleanup('before-store');
    await this.ensureDir(file.id);

    const { tempPath, dataPath } = this.getPaths(file.id);
    const writable = fs.createWriteStream(tempPath);
    try {
      await pipeline(Readable.fromWeb(webStream), writable);
      await fsp.rename(tempPath, dataPath);
      await this.writeMeta(file.id, {
        version: 1,
        fileId: file.id,
        fileName: file.file_name,
        mimeType: file.mime_type || 'application/octet-stream',
        fileSize: Number(file.file_size || 0),
        cachedAt: Date.now(),
        lastAccessAt: Date.now(),
      });
      await this.cleanup('after-store');
    } catch (error) {
      await this.removeEntry(file.id);
      throw error;
    }
  }

  async clearAll({ resetMetrics = false } = {}) {
    if (!this.config.enabled) return { deleted: 0 };

    const entries = await this.scanEntries();
    for (const entry of entries) {
      await this.removeEntry(entry.fileId);
    }

    if (resetMetrics) {
      this.metrics = {
        requests: 0,
        hit: 0,
        missFill: 0,
        missStore: 0,
        bypass: 0,
        bypassRange: 0,
      };
    }

    return { deleted: entries.length };
  }

  async wrapResponseAndCache(file, upstreamResponse) {
    if (!this.shouldCacheFile(file)) {
      return upstreamResponse;
    }
    if (!upstreamResponse?.body || Number(upstreamResponse.status) !== 200) {
      return upstreamResponse;
    }

    const [clientStream, cacheStream] = upstreamResponse.body.tee();
    void this.storeFromWebStream(file, cacheStream).catch(() => {});

    return new Response(clientStream, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: new Headers(upstreamResponse.headers),
    });
  }

  async ensureCached(file, fetcher) {
    if (!this.shouldCacheFile(file)) return false;

    const existing = await this.getCachedMeta(file);
    if (existing) return true;

    if (this.warmupPromises.has(file.id)) {
      await this.warmupPromises.get(file.id).catch(() => {});
      return Boolean(await this.getCachedMeta(file));
    }

    const promise = (async () => {
      const response = await fetcher();
      if (!response?.body || Number(response.status) !== 200) {
        return false;
      }
      await this.storeFromWebStream(file, response.body);
      return true;
    })().finally(() => {
      this.warmupPromises.delete(file.id);
    });

    this.warmupPromises.set(file.id, promise);
    return Boolean(await promise.catch(() => false));
  }

  async warmFile(file, fetcher) {
    if (!this.shouldCacheFile(file)) return;
    const existing = await this.getCachedMeta(file);
    if (existing) return;

    if (this.warmupPromises.has(file.id)) {
      return this.warmupPromises.get(file.id);
    }

    const promise = (async () => {
      const response = await fetcher();
      if (!response?.body || Number(response.status) !== 200) {
        return;
      }
      await this.storeFromWebStream(file, response.body);
    })().finally(() => {
      this.warmupPromises.delete(file.id);
    });

    this.warmupPromises.set(file.id, promise);
    return promise;
  }
}

module.exports = {
  FileCacheService,
};

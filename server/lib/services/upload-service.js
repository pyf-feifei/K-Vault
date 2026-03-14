const { buildPublicFileId, normalizeStorageType } = require('../storage/common');
const { normalizeFolderPath } = require('../repos/file-repo');

class UploadService {
  constructor({ storageRepo, fileRepo, storageFactory, fileCache }) {
    this.storageRepo = storageRepo;
    this.fileRepo = fileRepo;
    this.storageFactory = storageFactory;
    this.fileCache = fileCache;
  }

  async resolveStorage({ storageId, storageMode }) {
    if (!storageId && normalizeStorageType(storageMode) === 'huggingface') {
      const huggingfaceStorage = await this.resolveHuggingFaceStorageByThreshold();
      if (huggingfaceStorage) {
        return huggingfaceStorage;
      }
    }

    const storageConfig = await this.storageRepo.resolveStorageSelection({ storageId, storageMode });
    if (!storageConfig) {
      throw new Error('No available storage configuration.');
    }
    return storageConfig;
  }

  async resolveHuggingFaceStorageByThreshold() {
    const configs = await this.storageRepo.findEnabledByType('huggingface');
    if (configs.length === 0) return null;

    let hasCapacityError = false;
    for (const config of configs) {
      try {
        const adapter = this.storageFactory.createAdapter(config);
        const capacity = await adapter.getCapacityInfo();
        if (capacity.withinThreshold) {
          return config;
        }
      } catch (error) {
        hasCapacityError = true;
      }
    }

    if (hasCapacityError) {
      return configs[0];
    }

    const error = new Error('All enabled HuggingFace storage configs exceeded their configured capacity thresholds.');
    error.code = 'CAPACITY_THRESHOLD_EXCEEDED';
    throw error;
  }

  async uploadFile({
    fileName,
    mimeType,
    fileSize,
    buffer,
    storageId,
    storageMode,
    folderPath,
  }) {
    const storageConfig = await this.resolveStorage({ storageId, storageMode });
    const adapter = this.storageFactory.createAdapter(storageConfig);
    const storageType = normalizeStorageType(storageConfig.type);
    const normalizedFolderPath = normalizeFolderPath(folderPath);

    const publicId = buildPublicFileId(storageType, fileName, mimeType);

    let adapterStorageKey = normalizedFolderPath ? `${normalizedFolderPath}/${publicId}` : publicId;
    if (storageType === 'huggingface') {
      adapterStorageKey = `uploads/${publicId}`;
    }

    const uploadResult = await adapter.upload({
      storageKey: adapterStorageKey,
      fileName,
      mimeType,
      fileSize,
      buffer,
    });

    const storageKey = uploadResult.storageKey || adapterStorageKey;

    const fileRecord = this.fileRepo.create({
      id: publicId,
      storageConfigId: storageConfig.id,
      storageType,
      storageKey,
      fileName,
      fileSize,
      mimeType,
      folderPath: normalizedFolderPath,
      extra: uploadResult.metadata || {},
    });

    return {
      file: fileRecord,
      src: `/file/${encodeURIComponent(publicId)}`,
      storage: {
        id: storageConfig.id,
        name: storageConfig.name,
        type: storageType,
      },
    };
  }

  async uploadFromUrl({
    url,
    storageId,
    storageMode,
    folderPath,
    maxBytes = 20 * 1024 * 1024,
  }) {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTP/HTTPS URL is supported.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'K-Vault/2.0 (+https://github.com/katelya77/K-Vault)',
          Accept: '*/*',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Target URL responded with ${response.status}.`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
      throw new Error('Target URL returned empty body.');
    }

    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Remote file exceeds size limit (${Math.floor(maxBytes / 1024 / 1024)}MB).`);
    }

    let fileName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '').trim();
    if (!fileName) {
      fileName = `url_${Date.now()}`;
    }

    if (!fileName.includes('.')) {
      const ext = String(contentType).split('/')[1]?.split(';')[0] || 'bin';
      fileName = `${fileName}.${ext}`;
    }

    return this.uploadFile({
      fileName,
      mimeType: contentType,
      fileSize: arrayBuffer.byteLength,
      buffer: arrayBuffer,
      storageId,
      storageMode,
      folderPath,
    });
  }

  async getFileResponse(fileId, rangeHeader, method = 'GET') {
    const file = this.fileRepo.getById(fileId);
    if (!file) return null;
    const shouldCache = Boolean(this.fileCache?.shouldCacheFile(file));

    const cachedResponse = await this.fileCache?.createResponse(file, rangeHeader, method);
    if (cachedResponse) {
      return {
        file,
        response: cachedResponse,
        cacheStatus: 'hit',
      };
    }

    const storageConfig = await this.storageRepo.getById(file.storage_config_id, true);
    if (!storageConfig) {
      throw new Error('Storage config referenced by file not found.');
    }

    const adapter = this.storageFactory.createAdapter(storageConfig);
    const response = await adapter.download({
      storageKey: file.storage_key,
      metadata: file.metadata,
      range: rangeHeader,
    });

    if (!response) return null;

    if (method !== 'GET') {
      return {
        file,
        response,
        cacheStatus: 'bypass',
      };
    }

    if (shouldCache) {
      const cached = await this.fileCache?.ensureCached(file, async () => await adapter.download({
        storageKey: file.storage_key,
        metadata: file.metadata,
        range: undefined,
      }));

      if (cached) {
        const cachedFilledResponse = await this.fileCache?.createResponse(file, rangeHeader, method);
        if (cachedFilledResponse) {
          return {
            file,
            response: cachedFilledResponse,
            cacheStatus: 'miss-fill',
          };
        }
      }
    }

    if (!rangeHeader) {
      const cached = await this.fileCache?.wrapResponseAndCache(file, response);
      return {
        file,
        response: cached || response,
        cacheStatus: cached ? 'miss-store' : 'bypass',
      };
    }

    return {
      file,
      response,
      cacheStatus: 'bypass-range',
    };
  }

  async deleteFile(fileId) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return { deleted: false, reason: 'not-found' };

    const storageConfig = await this.storageRepo.getById(file.storage_config_id, true);
    if (storageConfig) {
      const adapter = this.storageFactory.createAdapter(storageConfig);
      try {
        await adapter.delete({ storageKey: file.storage_key, metadata: file.metadata });
      } catch (error) {
        // best-effort cleanup on remote storage
      }
    }

    this.fileRepo.delete(fileId);
    await this.fileCache?.removeEntry(fileId);
    return { deleted: true };
  }
}

module.exports = {
  UploadService,
};

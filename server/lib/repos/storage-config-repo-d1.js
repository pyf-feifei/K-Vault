/**
 * D1-backed StorageConfigRepository. All methods are async.
 */
const { encryptJson, decryptJson, randomId } = require('../utils/crypto');
const { normalizeStorageType } = require('../storage/common');

class StorageConfigRepositoryD1 {
  constructor(d1Client, appConfig, fileRepo) {
    this.d1 = d1Client;
    this.appConfig = appConfig;
    this.fileRepo = fileRepo;
  }

  parseRow(row, includeSecrets = false) {
    if (!row) return null;

    const payloadBlob = JSON.parse(row.encrypted_payload || '{}');
    let decrypted = {};
    try {
      decrypted = decryptJson(payloadBlob, this.appConfig.configEncryptionKey);
    } catch (error) {
      throw new Error(`Failed to decrypt storage config "${row.name}". Check CONFIG_ENCRYPTION_KEY.`);
    }

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config: includeSecrets ? decrypted : this.maskSensitiveFields(row.type, decrypted),
    };
  }

  maskSensitiveFields(type, config) {
    const cloned = { ...(config || {}) };
    const secretFieldsByType = {
      telegram: ['botToken'],
      r2: ['accessKeyId', 'secretAccessKey'],
      s3: ['accessKeyId', 'secretAccessKey'],
      discord: ['botToken', 'webhookUrl'],
      huggingface: ['token'],
      webdav: ['password', 'bearerToken', 'token'],
      github: ['token'],
    };
    (secretFieldsByType[type] || []).forEach((field) => {
      if (cloned[field]) cloned[field] = '********';
    });
    return cloned;
  }

  mergeConfigPreserveSecrets(type, currentConfig, patchConfig) {
    if (!patchConfig || typeof patchConfig !== 'object') return { ...(currentConfig || {}) };
    const merged = { ...(currentConfig || {}) };
    const incoming = { ...patchConfig };
    const secretFieldsByType = {
      telegram: ['botToken'],
      r2: ['accessKeyId', 'secretAccessKey'],
      s3: ['accessKeyId', 'secretAccessKey'],
      discord: ['botToken', 'webhookUrl'],
      huggingface: ['token'],
      webdav: ['password', 'bearerToken', 'token'],
      github: ['token'],
    };
    (secretFieldsByType[type] || []).forEach((field) => {
      if (incoming[field] === '********') delete incoming[field];
    });
    return { ...merged, ...incoming };
  }

  async list(includeSecrets = false) {
    const rows = await this.d1.all(
      `SELECT * FROM storage_configs ORDER BY is_default DESC, type ASC, created_at ASC`
    );
    return rows.map((row) => this.parseRow(row, includeSecrets));
  }

  async getById(id, includeSecrets = true) {
    const row = await this.d1.get('SELECT * FROM storage_configs WHERE id = ?', [id]);
    return this.parseRow(row, includeSecrets);
  }

  async getDefault() {
    const row = await this.d1.get(
      'SELECT * FROM storage_configs WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1'
    );
    return this.parseRow(row, true);
  }

  async findEnabledByType(type) {
    const normalized = normalizeStorageType(type);
    const rows = await this.d1.all(
      `SELECT * FROM storage_configs WHERE type = ? AND enabled = 1 ORDER BY is_default DESC, updated_at DESC`,
      [normalized]
    );
    return rows.map((row) => this.parseRow(row, true));
  }

  async resolveStorageSelection({ storageId, storageMode }) {
    if (storageId) {
      const byId = await this.getById(storageId, true);
      if (!byId || !byId.enabled) throw new Error('Selected storage config not found or disabled.');
      return byId;
    }
    if (storageMode) {
      const typed = await this.findEnabledByType(storageMode);
      if (typed.length > 0) return typed[0];
    }
    const defaultConfig = await this.getDefault();
    if (defaultConfig && defaultConfig.enabled) return defaultConfig;
    const rows = await this.d1.all(
      `SELECT * FROM storage_configs WHERE enabled = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1`
    );
    return this.parseRow(rows[0] || null, true);
  }

  async create({ name, type, config, enabled = true, isDefault = false, metadata = {} }) {
    const normalizedType = normalizeStorageType(type);
    const now = Date.now();
    const id = randomId('sc');
    const encrypted = encryptJson(config, this.appConfig.configEncryptionKey);

    await this.d1.transaction(async (tx) => {
      if (isDefault) {
        await tx.run('UPDATE storage_configs SET is_default = 0');
      }
      await tx.run(
        `INSERT INTO storage_configs(
          id, name, type, encrypted_payload, is_default, enabled, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          normalizedType,
          JSON.stringify(encrypted),
          isDefault ? 1 : 0,
          enabled ? 1 : 0,
          JSON.stringify(metadata || {}),
          now,
          now,
        ]
      );
    });

    return this.getById(id, true);
  }

  async update(id, patch) {
    const current = await this.getById(id, true);
    if (!current) return null;

    const nextType = normalizeStorageType(patch.type || current.type);
    const nextConfig = this.mergeConfigPreserveSecrets(nextType, current.config, patch.config);
    const encrypted = encryptJson(nextConfig, this.appConfig.configEncryptionKey);
    const now = Date.now();

    await this.d1.transaction(async (tx) => {
      if (patch.isDefault) {
        await tx.run('UPDATE storage_configs SET is_default = 0 WHERE id != ?', [id]);
      }
      await tx.run(
        `UPDATE storage_configs SET name = ?, type = ?, encrypted_payload = ?, is_default = ?, enabled = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
        [
          patch.name || current.name,
          nextType,
          JSON.stringify(encrypted),
          patch.isDefault != null ? (patch.isDefault ? 1 : 0) : (current.isDefault ? 1 : 0),
          patch.enabled != null ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
          JSON.stringify(patch.metadata || current.metadata || {}),
          now,
          id,
        ]
      );
    });

    return this.getById(id, true);
  }

  async setDefault(id) {
    await this.d1.transaction(async (tx) => {
      await tx.run('UPDATE storage_configs SET is_default = 0');
      await tx.run('UPDATE storage_configs SET is_default = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
    });
    return this.getById(id, true);
  }

  async delete(id) {
    const inUse = this.fileRepo.countByStorageConfigId(id);
    if (inUse > 0) {
      throw new Error('Storage config is in use by existing files and cannot be deleted.');
    }
    const result = await this.d1.run('DELETE FROM storage_configs WHERE id = ?', [id]);
    return Number(result.changes || 0) > 0;
  }

  async ensureBootstrapStorage() {
    const rows = await this.d1.all('SELECT COUNT(1) AS c FROM storage_configs');
    const count = rows[0] ? Number(rows[0].c) : 0;
    if (count > 0) return;

    const bootstrap = this.appConfig.bootstrapDefaultStorage;
    const type = normalizeStorageType(bootstrap.type || 'telegram');
    const byType = bootstrap[type] || {};

    const hasRequired = {
      telegram: Boolean(byType.botToken && byType.chatId),
      r2: Boolean(byType.endpoint && byType.bucket && byType.accessKeyId && byType.secretAccessKey),
      s3: Boolean(byType.endpoint && byType.bucket && byType.accessKeyId && byType.secretAccessKey),
      discord: Boolean(byType.webhookUrl || (byType.botToken && byType.channelId)),
      huggingface: Boolean(byType.token && byType.repo),
      webdav: Boolean(byType.baseUrl && (byType.bearerToken || (byType.username && byType.password))),
      github: Boolean(byType.repo && byType.token),
    };

    if (!hasRequired[type]) {
      if (!hasRequired.telegram) return;
      await this.create({
        name: 'Telegram (Env Bootstrap)',
        type: 'telegram',
        config: bootstrap.telegram,
        enabled: true,
        isDefault: true,
        metadata: { source: 'env-bootstrap', envSource: bootstrap.telegram?.envSource || {} },
      });
      return;
    }

    await this.create({
      name: `${type.toUpperCase()} (Env Bootstrap)`,
      type,
      config: byType,
      enabled: true,
      isDefault: true,
      metadata: { source: 'env-bootstrap', envSource: byType?.envSource || {} },
    });
  }
}

module.exports = {
  StorageConfigRepositoryD1,
};

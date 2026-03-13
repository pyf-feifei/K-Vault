const path = require('node:path');
const { ensureRuntimeSecrets, resolveRuntimeSecretsPath } = require('./runtime-secrets');

function toBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return defaultValue;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveDataPath(...parts) {
  return path.resolve(process.cwd(), ...parts);
}

function pickEnvAlias(env, aliases = [], fallback = '') {
  for (const alias of aliases) {
    const value = env[alias];
    if (value != null && String(value).trim() !== '') {
      return { value, source: alias };
    }
  }
  return { value: fallback, source: '' };
}

function resolveBasePaths(env = process.env) {
  const dataDir = env.DATA_DIR
    ? path.resolve(env.DATA_DIR)
    : resolveDataPath('data');

  return {
    dataDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'k-vault.db'),
    chunkDir: env.CHUNK_DIR ? path.resolve(env.CHUNK_DIR) : path.join(dataDir, 'chunks'),
    runtimeSecretsPath: resolveRuntimeSecretsPath({ env, dataDir }),
  };
}

function buildSqliteBackupConfig(env = process.env, basePaths = resolveBasePaths(env)) {
  const sqliteBackupRepo = env.SQLITE_BACKUP_GITHUB_REPO || env.SQLITE_BACKUP_REPO || '';
  const sqliteBackupToken = env.SQLITE_BACKUP_GITHUB_TOKEN || env.SQLITE_BACKUP_TOKEN || '';
  const sqliteBackupExplicit = env.SQLITE_BACKUP_ENABLED;
  const sqliteBackupIntervalMs = Math.max(10000, toInt(env.SQLITE_BACKUP_INTERVAL_MS, 15000));
  const sqliteBackupIdleMs = Math.max(sqliteBackupIntervalMs, toInt(env.SQLITE_BACKUP_IDLE_MS, 120000));

  return {
    enabled: sqliteBackupExplicit == null || sqliteBackupExplicit === ''
      ? Boolean(sqliteBackupRepo && sqliteBackupToken)
      : toBool(sqliteBackupExplicit, false),
    repo: sqliteBackupRepo,
    token: sqliteBackupToken,
    branch: env.SQLITE_BACKUP_GITHUB_BRANCH || env.SQLITE_BACKUP_BRANCH || 'main',
    repoDir: env.SQLITE_BACKUP_REPO_DIR
      ? path.resolve(env.SQLITE_BACKUP_REPO_DIR)
      : path.join(basePaths.dataDir, 'sqlite-backup-repo'),
    snapshotPath: env.SQLITE_BACKUP_PATH || 'backups/k-vault.db',
    managedFiles: [
      {
        localPath: basePaths.runtimeSecretsPath,
        repoPath: env.SQLITE_BACKUP_SECRET_PATH || 'backups/k-vault.runtime-secrets.json',
      },
    ],
    intervalMs: sqliteBackupIntervalMs,
    idleMs: sqliteBackupIdleMs,
    gitUserName: env.SQLITE_BACKUP_GIT_USER_NAME || 'K-Vault Backup Bot',
    gitUserEmail: env.SQLITE_BACKUP_GIT_USER_EMAIL || 'k-vault-backup@users.noreply.github.com',
    lfsEnabled: toBool(env.SQLITE_BACKUP_GIT_LFS, true),
  };
}

function loadBootstrapConfig(env = process.env) {
  const basePaths = resolveBasePaths(env);
  return {
    ...basePaths,
    runtimeSecretsAutoGenerate: toBool(env.RUNTIME_SECRETS_AUTO_GENERATE, true),
    sqliteBackup: buildSqliteBackupConfig(env, basePaths),
  };
}

function loadConfig(env = process.env) {
  const basePaths = resolveBasePaths(env);
  const bootstrap = loadBootstrapConfig(env);
  const runtimeSecrets = ensureRuntimeSecrets({
    env,
    dataDir: basePaths.dataDir,
    autoGenerate: bootstrap.runtimeSecretsAutoGenerate,
  });

  const telegramToken = pickEnvAlias(env, ['TG_BOT_TOKEN', 'TG_Bot_Token']);
  const telegramChatId = pickEnvAlias(env, ['TG_CHAT_ID', 'TG_Chat_ID']);
  const telegramApiBase = pickEnvAlias(env, ['CUSTOM_BOT_API_URL'], 'https://api.telegram.org');

  return {
    port: toInt(env.PORT, 8787),
    nodeEnv: env.NODE_ENV || 'development',
    publicBaseUrl: env.PUBLIC_BASE_URL || '',

    basicUser: env.BASIC_USER || '',
    basicPass: env.BASIC_PASS || '',
    sessionCookieName: env.SESSION_COOKIE_NAME || 'k_vault_session',
    sessionDurationMs: toInt(env.SESSION_DURATION_MS, 24 * 60 * 60 * 1000),

    guestUploadEnabled: toBool(env.GUEST_UPLOAD, false),
    guestMaxFileSize: toInt(env.GUEST_MAX_FILE_SIZE, 5 * 1024 * 1024),
    guestDailyLimit: toInt(env.GUEST_DAILY_LIMIT, 10),

    uploadMaxSize: toInt(env.UPLOAD_MAX_SIZE, 100 * 1024 * 1024),
    uploadSmallFileThreshold: toInt(env.UPLOAD_SMALL_FILE_THRESHOLD, 20 * 1024 * 1024),
    chunkSize: toInt(env.CHUNK_SIZE, 5 * 1024 * 1024),

    configEncryptionKey: runtimeSecrets.configEncryptionKey,
    sessionSecret: runtimeSecrets.sessionSecret,

    dataDir: basePaths.dataDir,
    dbPath: basePaths.dbPath,
    chunkDir: basePaths.chunkDir,
    runtimeSecrets,
    settingsStore: (env.SETTINGS_STORE || 'sqlite').toLowerCase(),
    settingsRedisUrl: env.SETTINGS_REDIS_URL || env.REDIS_URL || '',
    settingsRedisPrefix: env.SETTINGS_REDIS_PREFIX || 'k-vault',
    settingsRedisConnectTimeoutMs: toInt(env.SETTINGS_REDIS_CONNECT_TIMEOUT_MS, 5000),
    sqliteBackup: bootstrap.sqliteBackup,

    telegramApiBase: telegramApiBase.value,

    bootstrapDefaultStorage: {
      type: (env.DEFAULT_STORAGE_TYPE || 'telegram').toLowerCase(),
      telegram: {
        botToken: telegramToken.value || '',
        chatId: telegramChatId.value || '',
        apiBase: telegramApiBase.value || 'https://api.telegram.org',
        envSource: {
          botToken: telegramToken.source || 'none',
          chatId: telegramChatId.source || 'none',
          apiBase: telegramApiBase.source || 'default',
        },
      },
      r2: {
        endpoint: env.R2_ENDPOINT || env.S3_ENDPOINT || '',
        region: env.R2_REGION || env.S3_REGION || 'auto',
        bucket: env.R2_BUCKET || env.S3_BUCKET || '',
        accessKeyId: env.R2_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || '',
      },
      s3: {
        endpoint: env.S3_ENDPOINT || '',
        region: env.S3_REGION || 'us-east-1',
        bucket: env.S3_BUCKET || '',
        accessKeyId: env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      },
      discord: {
        webhookUrl: env.DISCORD_WEBHOOK_URL || '',
        botToken: env.DISCORD_BOT_TOKEN || '',
        channelId: env.DISCORD_CHANNEL_ID || '',
      },
      huggingface: {
        token: env.HF_TOKEN || '',
        repo: env.HF_REPO || '',
      },
      webdav: {
        baseUrl: env.WEBDAV_BASE_URL || '',
        username: env.WEBDAV_USERNAME || '',
        password: env.WEBDAV_PASSWORD || '',
        bearerToken: env.WEBDAV_BEARER_TOKEN || env.WEBDAV_TOKEN || '',
        rootPath: env.WEBDAV_ROOT_PATH || '',
      },
      github: {
        repo: env.GITHUB_REPO || '',
        token: env.GITHUB_TOKEN || '',
        mode: (env.GITHUB_MODE || 'releases').toLowerCase(),
        prefix: env.GITHUB_PREFIX || env.GITHUB_PATH || '',
        releaseTag: env.GITHUB_RELEASE_TAG || '',
        branch: env.GITHUB_BRANCH || '',
        apiBase: env.GITHUB_API_BASE || 'https://api.github.com',
      },
    },
  };
}

module.exports = {
  buildSqliteBackupConfig,
  loadBootstrapConfig,
  loadConfig,
  resolveBasePaths,
  resolveDataPath,
  toBool,
  toInt,
};

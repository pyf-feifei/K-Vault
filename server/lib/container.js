const { initDatabase, cleanupExpiredState, registerMutationObserver } = require('../db');
const { loadBootstrapConfig, loadConfig } = require('./config');
const { AuthService } = require('./utils/auth');
const { GuestService } = require('./utils/guest');
const { StorageFactory } = require('./storage/factory');
const { StorageConfigRepository } = require('./repos/storage-config-repo');
const { FileRepository } = require('./repos/file-repo');
const { UploadService } = require('./services/upload-service');
const { ChunkUploadService } = require('./services/chunk-service');
const { createSettingsStore } = require('./settings/factory');
const { createSqliteGitHubBackup } = require('./backup/sqlite-github-backup');

async function createContainer(env = process.env) {
  const bootstrapConfig = loadBootstrapConfig(env);
  const sqliteBackup = createSqliteGitHubBackup(bootstrapConfig.sqliteBackup, bootstrapConfig.dbPath);

  if (sqliteBackup) {
    await sqliteBackup.restoreIfAvailable();
  }

  const config = loadConfig(env);
  if (config.runtimeSecrets.generatedKeys.length > 0) {
    console.log(`[runtime-secrets] Generated ${config.runtimeSecrets.generatedKeys.join(', ')} at ${config.runtimeSecrets.runtimeSecretsPath}`);
    sqliteBackup?.recordActivity();
  }

  const db = initDatabase(config.dbPath);
  const unregisterBackupObserver = sqliteBackup
    ? registerMutationObserver(db, () => sqliteBackup.recordActivity())
    : () => {};

  sqliteBackup?.attachDatabase(db);

  const fileRepo = new FileRepository(db);
  const storageRepo = new StorageConfigRepository(db, config);
  const settingsStore = createSettingsStore({ db, config });
  const authService = new AuthService(db, config);
  const guestService = new GuestService(db, config);

  await storageRepo.ensureBootstrapStorage();
  cleanupExpiredState(db);

  const storageFactory = new StorageFactory();

  const uploadService = new UploadService({
    storageRepo,
    fileRepo,
    storageFactory,
  });

  const chunkService = new ChunkUploadService({
    db,
    config,
    uploadService,
  });

  return {
    config,
    db,
    authService,
    guestService,
    storageRepo,
    fileRepo,
    storageFactory,
    settingsStore,
    uploadService,
    chunkService,
    sqliteBackup,
    close: async () => {
      unregisterBackupObserver();
      await sqliteBackup?.shutdown();
      await settingsStore?.close?.();
      db.close?.();
    },
  };
}

module.exports = {
  createContainer,
};

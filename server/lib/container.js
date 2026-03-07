const { initDatabase, cleanupExpiredState } = require('../db');
const { loadConfig } = require('./config');
const { AuthService } = require('./utils/auth');
const { GuestService } = require('./utils/guest');
const { StorageFactory } = require('./storage/factory');
const { StorageConfigRepository } = require('./repos/storage-config-repo');
const { StorageConfigRepositoryD1 } = require('./repos/storage-config-repo-d1');
const { FileRepository } = require('./repos/file-repo');
const { UploadService } = require('./services/upload-service');
const { ChunkUploadService } = require('./services/chunk-service');
const { createSettingsStore } = require('./settings/factory');
const fs = require('node:fs');
const path = require('node:path');
const { createD1Client } = require('./d1/client');
const { D1SessionStore } = require('./d1/session-store');
const { D1GuestStore } = require('./d1/guest-store');

const D1_SCHEMA_PATH = path.join(__dirname, 'd1', 'schema.sql');

async function createContainer(env = process.env) {
  const config = loadConfig(env);
  const db = initDatabase(config.dbPath);

  const d1Client = createD1Client(env);
  const useD1 = Boolean(d1Client);
  const fileRepo = new FileRepository(db);

  let storageRepo;
  let settingsStore;
  let authService;
  let guestService;

  if (useD1) {
    try {
      const schemaSql = fs.readFileSync(D1_SCHEMA_PATH, 'utf8');
      await d1Client.initSchema(schemaSql);
    } catch (e) {
      console.warn('[d1] Schema init warning:', e?.message || e);
    }
    storageRepo = new StorageConfigRepositoryD1(d1Client, config, fileRepo);
    settingsStore = createSettingsStore({ db, config, d1Client });
    const sessionStore = new D1SessionStore(d1Client);
    const guestStore = new D1GuestStore(d1Client);
    authService = new AuthService(sessionStore, config);
    guestService = new GuestService(guestStore, config);

    await storageRepo.ensureBootstrapStorage();
    await sessionStore.cleanupExpired?.();
  } else {
    storageRepo = new StorageConfigRepository(db, config);
    settingsStore = createSettingsStore({ db, config });
    authService = new AuthService(db, config);
    guestService = new GuestService(db, config);

    await storageRepo.ensureBootstrapStorage();
    cleanupExpiredState(db);
  }
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
    d1Client,
    authService,
    guestService,
    storageRepo,
    fileRepo,
    storageFactory,
    settingsStore,
    uploadService,
    chunkService,
  };
}

module.exports = {
  createContainer,
};

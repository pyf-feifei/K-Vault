const { SqliteSettingsStore } = require('./sqlite-store');
const { D1SettingsStore } = require('./d1-store');

function createSettingsStore({ db, config, d1Client }) {
  if (d1Client) {
    return new D1SettingsStore(d1Client);
  }

  const mode = String(config.settingsStore || 'sqlite').toLowerCase();

  if (mode === 'sqlite') {
    return new SqliteSettingsStore(db);
  }

  if (mode === 'redis') {
    const { RedisSettingsStore } = require('./redis-store');
    return new RedisSettingsStore(config);
  }

  console.warn(`[settings] Unknown SETTINGS_STORE "${mode}", fallback to sqlite.`);
  return new SqliteSettingsStore(db);
}

module.exports = {
  createSettingsStore,
};

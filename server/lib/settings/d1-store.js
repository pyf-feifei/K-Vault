/**
 * D1-backed app_settings store.
 */
function serializeValue(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function deserializeValue(valueJson) {
  if (typeof valueJson !== 'string') return null;
  try {
    return JSON.parse(valueJson);
  } catch {
    return valueJson;
  }
}

class D1SettingsStore {
  constructor(d1Client) {
    this.d1 = d1Client;
  }

  async getAll() {
    const rows = await this.d1.all('SELECT key, value_json FROM app_settings');
    const output = {};
    for (const row of rows) {
      output[row.key] = deserializeValue(row.value_json);
    }
    return output;
  }

  async getMany(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) return {};
    const result = {};
    for (const key of keys) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) continue;
      const row = await this.d1.get('SELECT value_json FROM app_settings WHERE key = ?', [normalizedKey]);
      if (row) result[normalizedKey] = deserializeValue(row.value_json);
    }
    return result;
  }

  async setMany(values = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return;
    const now = Date.now();
    for (const [rawKey, value] of Object.entries(values)) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      await this.d1.run(
        `INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        [key, serializeValue(value), now]
      );
    }
  }

  async deleteMany(keys = []) {
    if (!Array.isArray(keys) || keys.length === 0) return;
    for (const rawKey of keys) {
      const key = String(rawKey || '').trim();
      if (!key) continue;
      await this.d1.run('DELETE FROM app_settings WHERE key = ?', [key]);
    }
  }

  async healthCheck() {
    try {
      await this.d1.get('SELECT 1');
      return { backend: 'd1', connected: true, message: 'Cloudflare D1 app settings store enabled' };
    } catch (e) {
      return { backend: 'd1', connected: false, message: String(e?.message || e) };
    }
  }

  async close() {}
}

module.exports = {
  D1SettingsStore,
};

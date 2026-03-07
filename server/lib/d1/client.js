/**
 * Cloudflare D1 REST API client.
 * Uses: POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query
 * Body: { "sql": "...", "params": [] }
 * Auth: Authorization: Bearer {CF_API_TOKEN}
 */
const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4';

class D1Client {
  constructor({ accountId, databaseId, apiToken, apiBase = DEFAULT_API_BASE }) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
    this.baseUrl = `${apiBase.replace(/\/$/, '')}/accounts/${accountId}/d1/database/${databaseId}/query`;
  }

  async _request(sql, params = []) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: JSON.stringify({ sql, params }),
    });

    const json = await res.json();
    if (!res.ok) {
      const err = new Error(json.errors?.[0]?.message || `D1 API error: ${res.status}`);
      err.status = res.status;
      err.d1Errors = json.errors;
      throw err;
    }

    if (!json.success) {
      const err = new Error(json.errors?.[0]?.message || 'D1 request failed');
      err.d1Errors = json.errors;
      throw err;
    }

    return json;
  }

  /**
   * Execute a query that returns rows. Returns array of row objects.
   */
  async all(sql, params = []) {
    const json = await this._request(sql, params);
    const first = json.result?.[0];
    if (!first) return [];
    const results = first.results;
    return Array.isArray(results) ? results : [];
  }

  /**
   * Execute a query and return the first row or null.
   */
  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Execute a statement (INSERT/UPDATE/DELETE). Returns meta with changes.
   */
  async run(sql, params = []) {
    const json = await this._request(sql, params);
    const first = json.result?.[0];
    const meta = first?.meta || {};
    return {
      changes: meta.changes ?? 0,
      last_row_id: meta.last_row_id ?? 0,
    };
  }

  /**
   * Execute multiple statements sequentially. D1 REST API does not support
   * true transactions; this is best-effort sequential execution.
   */
  async transaction(fn) {
    const self = this;
    const tx = {
      run: (sql, params) => self.run(sql, params),
      get: (sql, params) => self.get(sql, params),
      all: (sql, params) => self.all(sql, params),
    };
    return fn(tx);
  }

  async healthCheck() {
    try {
      await this.get('SELECT 1');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /**
   * Initialize D1 schema. Run each statement separately (D1 REST API).
   */
  async initSchema(schemaSql) {
    const stmts = schemaSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('--'));
    for (const sql of stmts) {
      if (sql) await this.run(sql);
    }
  }
}

function createD1Client(env = process.env) {
  const accountId = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.CF_D1_DATABASE_ID || env.CLOUDFLARE_D1_DATABASE_ID;
  const apiToken = env.CF_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const apiBase = env.CF_D1_API_BASE || env.CLOUDFLARE_D1_API_BASE || DEFAULT_API_BASE;

  if (!accountId || !databaseId || !apiToken) {
    return null;
  }

  return new D1Client({ accountId, databaseId, apiToken, apiBase });
}

module.exports = {
  D1Client,
  createD1Client,
};

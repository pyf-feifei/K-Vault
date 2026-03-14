const crypto = require('node:crypto');
const { all, get, run } = require('../../db');
const { normalizeFolderPath } = require('./file-repo');

const TOKEN_PREFIX = 'kvault_';
const VALID_SCOPES = ['upload', 'read', 'delete'];

function normalizeScopes(rawScopes = []) {
  const list = Array.isArray(rawScopes) ? rawScopes : [rawScopes];
  const normalized = [];
  for (const item of list) {
    const scope = String(item || '').trim().toLowerCase();
    if (!VALID_SCOPES.includes(scope)) continue;
    if (normalized.includes(scope)) continue;
    normalized.push(scope);
  }
  return normalized;
}

function normalizeExpiresAt(rawValue) {
  if (rawValue == null || rawValue === '') return null;
  const parsed = Number(rawValue);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.floor(parsed));
  }
  const asDate = Date.parse(String(rawValue));
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.floor(asDate));
  }
  return null;
}

function timingSafeEqualHex(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function randomString(length) {
  return crypto.randomBytes(length).toString('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, length);
}

function splitToken(rawToken = '') {
  const value = String(rawToken || '').trim();
  const match = /^kvault_([A-Za-z0-9_-]{6,128})_([A-Za-z0-9_-]{16,256})$/.exec(value);
  if (!match) return null;
  return {
    tokenId: match[1],
    secret: match[2],
  };
}

function hashSecret(secret, salt) {
  return crypto.createHash('sha256').update(`${salt}:${secret}`).digest('hex');
}

function toPublicToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes_json || '[]'),
    restrictions: JSON.parse(row.restrictions_json || '{}'),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at || 0),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    tokenPreview: `******${row.token_suffix || ''}`,
  };
}

function normalizeRestrictions(rawValue = {}) {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return {};
  }

  const storageConfigId = String(rawValue.storageConfigId || rawValue.storageId || '').trim();
  const folderPath = normalizeFolderPath(rawValue.folderPath || rawValue.folderPathPrefix || '');

  const output = {};
  if (storageConfigId) output.storageConfigId = storageConfigId;
  if (folderPath) output.folderPath = folderPath;
  return output;
}

class ApiTokenRepository {
  constructor(db) {
    this.db = db;
    this.ensureSchema();
  }

  ensureSchema() {
    run(
      this.db,
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        restrictions_json TEXT NOT NULL DEFAULT '{}',
        expires_at INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        token_salt TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_suffix TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )`
    );
    const columns = all(this.db, 'PRAGMA table_info(api_tokens)');
    const hasRestrictions = columns.some((column) => column.name === 'restrictions_json');
    if (!hasRestrictions) {
      run(this.db, `ALTER TABLE api_tokens ADD COLUMN restrictions_json TEXT NOT NULL DEFAULT '{}'`);
    }
    run(this.db, 'CREATE INDEX IF NOT EXISTS idx_api_tokens_enabled ON api_tokens(enabled)');
    run(this.db, 'CREATE INDEX IF NOT EXISTS idx_api_tokens_expires_at ON api_tokens(expires_at)');
  }

  getScopes() {
    return [...VALID_SCOPES];
  }

  list() {
    const rows = all(this.db, 'SELECT * FROM api_tokens ORDER BY created_at DESC');
    return rows.map((row) => toPublicToken(row));
  }

  getById(id) {
    const tokenId = String(id || '').trim();
    if (!tokenId) return null;
    const row = get(this.db, 'SELECT * FROM api_tokens WHERE id = ?', [tokenId]);
    return row || null;
  }

  create({ name, scopes, restrictions, expiresAt, enabled = true }) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw new Error('Token name is required.');
    }

    const normalizedScopes = normalizeScopes(scopes);
    if (normalizedScopes.length === 0) {
      throw new Error('At least one valid scope is required.');
    }

    const tokenId = randomString(12);
    const tokenSecret = randomString(40);
    const tokenSalt = randomString(16);
    const tokenHash = hashSecret(tokenSecret, tokenSalt);
    const tokenSuffix = tokenSecret.slice(-6);
    const normalizedRestrictions = normalizeRestrictions(restrictions);
    const now = Date.now();

    run(
      this.db,
      `INSERT INTO api_tokens(
        id, name, scopes_json, restrictions_json, expires_at, enabled, token_salt, token_hash, token_suffix, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tokenId,
        normalizedName,
        JSON.stringify(normalizedScopes),
        JSON.stringify(normalizedRestrictions),
        normalizeExpiresAt(expiresAt),
        enabled !== false ? 1 : 0,
        tokenSalt,
        tokenHash,
        tokenSuffix,
        now,
        null,
      ]
    );

    return {
      token: `${TOKEN_PREFIX}${tokenId}_${tokenSecret}`,
      tokenInfo: toPublicToken(this.getById(tokenId)),
    };
  }

  update(id, patch = {}) {
    const current = this.getById(id);
    if (!current) return null;

    const nextName = Object.prototype.hasOwnProperty.call(patch, 'name')
      ? String(patch.name || '').trim()
      : current.name;
    if (!nextName) {
      throw new Error('Token name is required.');
    }

    const nextScopes = Object.prototype.hasOwnProperty.call(patch, 'scopes')
      ? normalizeScopes(patch.scopes)
      : JSON.parse(current.scopes_json || '[]');
    if (nextScopes.length === 0) {
      throw new Error('At least one valid scope is required.');
    }

    const nextRestrictions = Object.prototype.hasOwnProperty.call(patch, 'restrictions')
      ? normalizeRestrictions(patch.restrictions)
      : JSON.parse(current.restrictions_json || '{}');

    const nextExpiresAt = Object.prototype.hasOwnProperty.call(patch, 'expiresAt')
      ? normalizeExpiresAt(patch.expiresAt)
      : current.expires_at;
    const nextEnabled = Object.prototype.hasOwnProperty.call(patch, 'enabled')
      ? (patch.enabled ? 1 : 0)
      : current.enabled;

    run(
      this.db,
      `UPDATE api_tokens
       SET name = ?, scopes_json = ?, restrictions_json = ?, expires_at = ?, enabled = ?
       WHERE id = ?`,
      [nextName, JSON.stringify(nextScopes), JSON.stringify(nextRestrictions), nextExpiresAt, nextEnabled, current.id]
    );

    return toPublicToken(this.getById(id));
  }

  delete(id) {
    const result = run(this.db, 'DELETE FROM api_tokens WHERE id = ?', [String(id || '').trim()]);
    return Number(result.changes || 0) > 0;
  }

  touch(id) {
    run(this.db, 'UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [Date.now(), String(id || '').trim()]);
  }

  verify(rawToken, requiredScope = '') {
    const parsed = splitToken(rawToken);
    if (!parsed) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_INVALID',
        message: 'API Token is invalid.',
      };
    }

    const row = this.getById(parsed.tokenId);
    if (!row) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_INVALID',
        message: 'API Token is invalid.',
      };
    }

    const expectedHash = hashSecret(parsed.secret, row.token_salt);
    if (!timingSafeEqualHex(expectedHash, row.token_hash)) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_INVALID',
        message: 'API Token is invalid.',
      };
    }

    if (!row.enabled) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_DISABLED',
        message: 'API Token is disabled.',
      };
    }

    if (Number.isFinite(Number(row.expires_at)) && Number(row.expires_at) > 0 && Date.now() > Number(row.expires_at)) {
      return {
        ok: false,
        status: 401,
        code: 'TOKEN_EXPIRED',
        message: 'API Token has expired.',
      };
    }

    const normalizedRequiredScope = String(requiredScope || '').trim().toLowerCase();
    const scopes = JSON.parse(row.scopes_json || '[]');
    if (normalizedRequiredScope && !scopes.includes(normalizedRequiredScope)) {
      return {
        ok: false,
        status: 403,
        code: 'TOKEN_SCOPE_DENIED',
        message: `API Token does not include "${normalizedRequiredScope}" scope.`,
      };
    }

    return {
      ok: true,
      token: toPublicToken(row),
      raw: row,
    };
  }
}

module.exports = {
  ApiTokenRepository,
};

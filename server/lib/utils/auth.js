const crypto = require('node:crypto');
const { run, get } = require('../../db');

const LEGACY_COOKIE_NAME = 'katelya_session';

function parseCookies(cookieHeader = '') {
  const result = {};
  if (!cookieHeader) return result;

  cookieHeader.split(';').forEach((chunk) => {
    const [rawName, ...rest] = chunk.trim().split('=');
    if (!rawName) return;
    const rawValue = rest.join('=');
    result[rawName] = decodeURIComponent(rawValue || '');
  });

  return result;
}

/** SQLite-backed session store (sync) */
class SqliteSessionStore {
  constructor(db) {
    this.db = db;
  }

  async createSession(token, userName, createdAt, expiresAt) {
    run(
      this.db,
      `INSERT INTO sessions(token, user_name, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      [token, userName, createdAt, expiresAt]
    );
  }

  async getSession(token) {
    if (!token) return null;
    return get(this.db, 'SELECT * FROM sessions WHERE token = ?', [token]);
  }

  async deleteSession(token) {
    if (!token) return;
    run(this.db, 'DELETE FROM sessions WHERE token = ?', [token]);
  }
}

class AuthService {
  constructor(dbOrSessionStore, config) {
    this.config = config;
    this.sessionStore = dbOrSessionStore && typeof dbOrSessionStore.getSession === 'function'
      ? dbOrSessionStore
      : new SqliteSessionStore(dbOrSessionStore);
  }

  isAuthRequired() {
    return Boolean(this.config.basicUser && this.config.basicPass);
  }

  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  verifyBasicAuth(headerValue = '') {
    if (!headerValue || !headerValue.startsWith('Basic ')) return null;

    try {
      const encoded = headerValue.slice('Basic '.length).trim();
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator === -1) return null;
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);

      if (user === this.config.basicUser && pass === this.config.basicPass) {
        return { authenticated: true, user, reason: 'basic-auth' };
      }
    } catch (error) {
      return null;
    }

    return null;
  }

  async createSession(userName) {
    const now = Date.now();
    const expiresAt = now + this.config.sessionDurationMs;
    const token = this.generateToken();

    await this.sessionStore.createSession(token, userName, now, expiresAt);

    return { token, expiresAt };
  }

  async deleteSession(token) {
    if (!token) return;
    await this.sessionStore.deleteSession(token);
  }

  async getSession(token) {
    if (!token) return null;
    const row = await this.sessionStore.getSession(token);
    if (!row) return null;
    if (Date.now() > row.expires_at) {
      await this.deleteSession(token);
      return null;
    }
    return row;
  }

  getSessionTokenFromRequest(request) {
    const cookies = parseCookies(request.headers.get('cookie') || '');
    return cookies[this.config.sessionCookieName] || cookies[LEGACY_COOKIE_NAME] || null;
  }

  createSessionCookie(token) {
    const maxAge = Math.floor(this.config.sessionDurationMs / 1000);
    return `${this.config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }

  createClearSessionCookies() {
    return [
      `${this.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      `${LEGACY_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    ];
  }

  async checkAuthentication(request) {
    if (!this.isAuthRequired()) {
      return { authenticated: true, reason: 'no-auth-required', user: 'anonymous' };
    }

    const sessionToken = this.getSessionTokenFromRequest(request);
    const session = await this.getSession(sessionToken);
    if (session) {
      return {
        authenticated: true,
        reason: 'session',
        token: sessionToken,
        user: session.user_name,
      };
    }

    const basicAuth = this.verifyBasicAuth(request.headers.get('authorization') || '');
    if (basicAuth) return basicAuth;

    return { authenticated: false, reason: 'unauthorized' };
  }
}

module.exports = {
  AuthService,
  SqliteSessionStore,
  parseCookies,
};

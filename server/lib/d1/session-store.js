/**
 * D1-backed session store for AuthService.
 */
class D1SessionStore {
  constructor(d1Client) {
    this.d1 = d1Client;
  }

  async createSession(userName, token, createdAt, expiresAt) {
    await this.d1.run(
      `INSERT INTO sessions(token, user_name, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      [token, userName, createdAt, expiresAt]
    );
  }

  async getSession(token) {
    if (!token) return null;
    const row = await this.d1.get('SELECT * FROM sessions WHERE token = ?', [token]);
    return row;
  }

  async deleteSession(token) {
    if (!token) return;
    await this.d1.run('DELETE FROM sessions WHERE token = ?', [token]);
  }

  async cleanupExpired() {
    await this.d1.run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  }
}

module.exports = {
  D1SessionStore,
};

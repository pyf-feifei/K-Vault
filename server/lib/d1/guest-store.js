/**
 * D1-backed guest upload counter store.
 */
class D1GuestStore {
  constructor(d1Client) {
    this.d1 = d1Client;
  }

  async getCount(id) {
    const row = await this.d1.get('SELECT count FROM guest_upload_counters WHERE id = ?', [id]);
    return row ? Number(row.count) : 0;
  }

  async increment(id, ip, day) {
    const now = Date.now();
    const existing = await this.d1.get('SELECT count FROM guest_upload_counters WHERE id = ?', [id]);
    if (!existing) {
      await this.d1.run(
        `INSERT INTO guest_upload_counters(id, ip, day, count, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [id, ip, day, 1, now]
      );
    } else {
      await this.d1.run(
        `UPDATE guest_upload_counters SET count = ?, updated_at = ? WHERE id = ?`,
        [Number(existing.count) + 1, now, id]
      );
    }
  }
}

module.exports = {
  D1GuestStore,
};

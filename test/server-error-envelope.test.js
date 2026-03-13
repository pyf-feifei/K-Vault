const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server/app');

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, snapshot);
}

describe('server error envelope', function () {
  let envSnapshot;
  let tempDir;

  beforeEach(function () {
    envSnapshot = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-vault-server-'));

    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.DATA_DIR = tempDir;
    process.env.DB_PATH = path.join(tempDir, 'k-vault.db');
    process.env.CHUNK_DIR = path.join(tempDir, 'chunks');
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'admin';
    process.env.SQLITE_BACKUP_ENABLED = 'false';
    process.env.RUNTIME_SECRETS_AUTO_GENERATE = 'false';

    delete process.env.CONFIG_ENCRYPTION_KEY;
    delete process.env.SESSION_SECRET;
    delete process.env.FILE_URL_SECRET;
  });

  afterEach(function () {
    restoreEnv(envSnapshot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns JSON when encrypted storage config save fails', async function () {
    const app = await createApp();
    const authHeader = `Basic ${Buffer.from('admin:admin').toString('base64')}`;
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      const response = await app.fetch(new Request('http://localhost/api/storage', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.kvault.v2+json',
          Authorization: authHeader,
          'Content-Type': 'application/json',
          'X-KVault-Client': 'app-v2',
        },
        body: JSON.stringify({
          name: 'hf-space',
          type: 'huggingface',
          enabled: true,
          isDefault: true,
          config: {
            token: 'hf_xxx',
            repo: 'owner/dataset',
          },
        }),
      }));

      const payload = JSON.parse(await response.text());

      assert.strictEqual(response.status, 500);
      assert.match(response.headers.get('content-type') || '', /application\/json/i);
      assert.strictEqual(payload.success, false);
      assert.strictEqual(payload.error.code, 'SERVER_MISCONFIGURED');
      assert.match(payload.error.message, /CONFIG_ENCRYPTION_KEY|SESSION_SECRET/i);
      assert.match(payload.error.detail, /CONFIG_ENCRYPTION_KEY/i);
      assert.ok(payload.traceId);
    } finally {
      console.error = originalConsoleError;
      await app.container.close();
    }
  });
});

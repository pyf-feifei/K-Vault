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

describe('API token management endpoints', function () {
  let envSnapshot;
  let tempDir;

  beforeEach(function () {
    envSnapshot = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-vault-api-token-'));

    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.DATA_DIR = tempDir;
    process.env.DB_PATH = path.join(tempDir, 'k-vault.db');
    process.env.CHUNK_DIR = path.join(tempDir, 'chunks');
    process.env.BASIC_USER = 'admin';
    process.env.BASIC_PASS = 'admin';
    process.env.SQLITE_BACKUP_ENABLED = 'false';
  });

  afterEach(function () {
    restoreEnv(envSnapshot);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, lists, and updates API tokens', async function () {
    const app = await createApp();
    const authHeader = `Basic ${Buffer.from('admin:admin').toString('base64')}`;

    try {
      const createResponse = await app.fetch(new Request('http://localhost/api/tokens', {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.kvault.v2+json',
          'X-KVault-Client': 'app-v2',
        },
        body: JSON.stringify({
          name: 'integration-token',
          scopes: ['upload'],
          enabled: true,
        }),
      }));

      const created = JSON.parse(await createResponse.text());
      assert.strictEqual(createResponse.status, 201);
      assert.strictEqual(created.success, true);
      assert.ok(/^kvault_/.test(created.token));
      assert.strictEqual(created.tokenInfo.name, 'integration-token');

      const listResponse = await app.fetch(new Request('http://localhost/api/tokens', {
        headers: {
          Authorization: authHeader,
          Accept: 'application/vnd.kvault.v2+json',
          'X-KVault-Client': 'app-v2',
        },
      }));
      const listed = JSON.parse(await listResponse.text());
      assert.strictEqual(listResponse.status, 200);
      assert.strictEqual(listed.tokens.length, 1);
      assert.deepStrictEqual(listed.tokens[0].scopes, ['upload']);

      const patchResponse = await app.fetch(new Request(`http://localhost/api/tokens/${listed.tokens[0].id}`, {
        method: 'PATCH',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.kvault.v2+json',
          'X-KVault-Client': 'app-v2',
        },
        body: JSON.stringify({
          enabled: false,
        }),
      }));
      const patched = JSON.parse(await patchResponse.text());
      assert.strictEqual(patchResponse.status, 200);
      assert.strictEqual(patched.tokenInfo.enabled, false);
    } finally {
      await app.container.close();
    }
  });
});

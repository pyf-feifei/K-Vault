const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadBootstrapConfig, loadConfig } = require('../server/lib/config');

describe('runtime secrets', function () {
  let tempDir;

  beforeEach(function () {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-vault-runtime-secrets-'));
  });

  afterEach(function () {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates and persists secrets when env values are absent', function () {
    const env = {
      DATA_DIR: tempDir,
      SQLITE_BACKUP_ENABLED: 'false',
    };

    const first = loadConfig(env);
    const runtimeSecretsPath = path.join(tempDir, 'k-vault.runtime-secrets.json');

    assert.ok(first.configEncryptionKey);
    assert.ok(first.sessionSecret);
    assert.deepStrictEqual(first.runtimeSecrets.generatedKeys.sort(), ['CONFIG_ENCRYPTION_KEY', 'SESSION_SECRET']);
    assert.strictEqual(first.runtimeSecrets.runtimeSecretsPath, runtimeSecretsPath);
    assert.ok(fs.existsSync(runtimeSecretsPath));

    const stored = JSON.parse(fs.readFileSync(runtimeSecretsPath, 'utf8'));
    assert.strictEqual(stored.configEncryptionKey, first.configEncryptionKey);
    assert.strictEqual(stored.sessionSecret, first.sessionSecret);

    const second = loadConfig(env);
    assert.strictEqual(second.configEncryptionKey, first.configEncryptionKey);
    assert.strictEqual(second.sessionSecret, first.sessionSecret);
    assert.deepStrictEqual(second.runtimeSecrets.generatedKeys, []);
    assert.strictEqual(second.runtimeSecrets.source, 'file');
  });

  it('keeps runtime secrets in sqlite backup managed files', function () {
    const env = {
      DATA_DIR: tempDir,
      SQLITE_BACKUP_GITHUB_REPO: 'owner/repo',
      SQLITE_BACKUP_GITHUB_TOKEN: 'token',
    };

    const bootstrap = loadBootstrapConfig(env);

    assert.strictEqual(bootstrap.runtimeSecretsPath, path.join(tempDir, 'k-vault.runtime-secrets.json'));
    assert.strictEqual(bootstrap.sqliteBackup.managedFiles.length, 1);
    assert.strictEqual(bootstrap.sqliteBackup.managedFiles[0].localPath, bootstrap.runtimeSecretsPath);
    assert.strictEqual(bootstrap.sqliteBackup.managedFiles[0].repoPath, 'backups/k-vault.runtime-secrets.json');
  });

  it('allows disabling auto generation', function () {
    const env = {
      DATA_DIR: tempDir,
      SQLITE_BACKUP_ENABLED: 'false',
      RUNTIME_SECRETS_AUTO_GENERATE: 'false',
    };

    const config = loadConfig(env);

    assert.strictEqual(config.configEncryptionKey, '');
    assert.strictEqual(config.sessionSecret, '');
    assert.deepStrictEqual(config.runtimeSecrets.generatedKeys, []);
    assert.strictEqual(fs.existsSync(path.join(tempDir, 'k-vault.runtime-secrets.json')), false);
  });
});

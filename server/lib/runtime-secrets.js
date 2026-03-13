const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function normalizeSecret(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeSecret(value);
    if (normalized) return normalized;
  }
  return '';
}

function generateSecret() {
  return crypto.randomBytes(48).toString('base64url');
}

function resolveRuntimeSecretsPath({ env = process.env, dataDir }) {
  if (env.RUNTIME_SECRETS_FILE) {
    return path.resolve(env.RUNTIME_SECRETS_FILE);
  }
  return path.join(path.resolve(dataDir), 'k-vault.runtime-secrets.json');
}

function readRuntimeSecretsFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      exists: false,
      configEncryptionKey: '',
      sessionSecret: '',
      generatedAt: null,
      updatedAt: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse runtime secrets file: ${resolvedPath}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Runtime secrets file must contain a JSON object: ${resolvedPath}`);
  }

  return {
    exists: true,
    configEncryptionKey: firstNonEmpty(parsed.configEncryptionKey, parsed.CONFIG_ENCRYPTION_KEY),
    sessionSecret: firstNonEmpty(parsed.sessionSecret, parsed.SESSION_SECRET),
    generatedAt: Number(parsed.generatedAt || 0) || null,
    updatedAt: Number(parsed.updatedAt || 0) || null,
  };
}

function writeRuntimeSecretsFile(filePath, payload) {
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  const document = {
    version: 1,
    generatedAt: payload.generatedAt,
    updatedAt: payload.updatedAt,
    configEncryptionKey: payload.configEncryptionKey,
    sessionSecret: payload.sessionSecret,
  };

  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${resolvedPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, resolvedPath);
}

function ensureRuntimeSecrets({
  env = process.env,
  dataDir,
  autoGenerate = true,
}) {
  const runtimeSecretsPath = resolveRuntimeSecretsPath({ env, dataDir });
  const fileSecrets = readRuntimeSecretsFile(runtimeSecretsPath);

  let configEncryptionKey = firstNonEmpty(
    env.CONFIG_ENCRYPTION_KEY,
    env.FILE_URL_SECRET,
    env.SESSION_SECRET,
    fileSecrets.configEncryptionKey,
    fileSecrets.sessionSecret
  );
  let sessionSecret = firstNonEmpty(
    env.SESSION_SECRET,
    env.FILE_URL_SECRET,
    env.CONFIG_ENCRYPTION_KEY,
    fileSecrets.sessionSecret,
    fileSecrets.configEncryptionKey
  );

  const generatedKeys = [];
  if (!configEncryptionKey) {
    if (!autoGenerate) {
      return {
        configEncryptionKey: '',
        sessionSecret,
        runtimeSecretsPath,
        generatedKeys,
        source: fileSecrets.exists ? 'file' : 'missing',
      };
    }
    configEncryptionKey = generateSecret();
    generatedKeys.push('CONFIG_ENCRYPTION_KEY');
  }

  if (!sessionSecret) {
    if (!autoGenerate) {
      return {
        configEncryptionKey,
        sessionSecret: '',
        runtimeSecretsPath,
        generatedKeys,
        source: fileSecrets.exists ? 'file' : 'missing',
      };
    }
    sessionSecret = generateSecret();
    generatedKeys.push('SESSION_SECRET');
  }

  if (generatedKeys.length > 0) {
    const now = Date.now();
    writeRuntimeSecretsFile(runtimeSecretsPath, {
      generatedAt: fileSecrets.generatedAt || now,
      updatedAt: now,
      configEncryptionKey,
      sessionSecret,
    });
  }

  const source = generatedKeys.length > 0
    ? 'generated'
    : fileSecrets.exists
      ? 'file'
      : 'env';

  return {
    configEncryptionKey,
    sessionSecret,
    runtimeSecretsPath,
    generatedKeys,
    source,
    fileExists: fileSecrets.exists || generatedKeys.length > 0,
  };
}

module.exports = {
  ensureRuntimeSecrets,
  generateSecret,
  readRuntimeSecretsFile,
  resolveRuntimeSecretsPath,
};

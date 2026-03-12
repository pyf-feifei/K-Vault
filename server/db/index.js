const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function isMutationSql(sql) {
  const normalized = String(sql || '').trim().toUpperCase();
  return (
    normalized.startsWith('INSERT') ||
    normalized.startsWith('UPDATE') ||
    normalized.startsWith('DELETE') ||
    normalized.startsWith('REPLACE') ||
    normalized.startsWith('ALTER') ||
    normalized.startsWith('CREATE') ||
    normalized.startsWith('DROP') ||
    normalized.startsWith('VACUUM')
  );
}

function isSchemaMutationSql(sql) {
  const normalized = String(sql || '').trim().toUpperCase();
  return (
    normalized.startsWith('ALTER') ||
    normalized.startsWith('CREATE') ||
    normalized.startsWith('DROP') ||
    normalized.startsWith('VACUUM')
  );
}

function registerMutationObserver(db, observer) {
  if (!db || typeof observer !== 'function') return () => {};

  if (!db.__mutationObservers) {
    Object.defineProperty(db, '__mutationObservers', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: new Set(),
    });
  }

  db.__mutationObservers.add(observer);

  return () => {
    db.__mutationObservers?.delete(observer);
  };
}

function notifyMutationObservers(db, sql, result) {
  if (!db?.__mutationObservers || !isMutationSql(sql)) return;
  if (!isSchemaMutationSql(sql) && Number(result?.changes || 0) <= 0) return;

  for (const observer of db.__mutationObservers) {
    try {
      observer(sql);
    } catch (error) {
      console.warn('[db] Mutation observer failed:', error?.message || error);
    }
  }
}

function executeStatement(stmt, method, params) {
  if (params == null) {
    return stmt[method]();
  }
  if (Array.isArray(params)) {
    return stmt[method](...params);
  }
  return stmt[method](params);
}

function initDatabase(dbPath) {
  const fullPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  const db = new DatabaseSync(fullPath);
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  return db;
}

function run(db, sql, params) {
  const stmt = db.prepare(sql);
  const result = executeStatement(stmt, 'run', params);
  notifyMutationObservers(db, sql, result);
  return result;
}

function get(db, sql, params) {
  const stmt = db.prepare(sql);
  return executeStatement(stmt, 'get', params);
}

function all(db, sql, params) {
  const stmt = db.prepare(sql);
  return executeStatement(stmt, 'all', params);
}

function transaction(db, callback) {
  db.exec('BEGIN');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cleanupExpiredState(db) {
  const now = Date.now();
  run(db, 'DELETE FROM sessions WHERE expires_at <= ?', [now]);
  run(db, 'DELETE FROM chunk_uploads WHERE expires_at <= ?', [now]);
}

module.exports = {
  initDatabase,
  run,
  get,
  all,
  transaction,
  cleanupExpiredState,
  registerMutationObserver,
};

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function normalizeRepo(repo) {
  const value = String(repo || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, '');
  return `https://github.com/${value.replace(/^\/+/, '').replace(/\.git$/i, '')}.git`;
}

function sqliteLiteral(value) {
  return String(value || '').replace(/'/g, "''");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelySqliteFile(filePath) {
  try {
    const handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(handle, header, 0, 16, 0);
    fs.closeSync(handle);
    return header.toString('utf8') === 'SQLite format 3\u0000';
  } catch {
    return false;
  }
}

class SqliteGitHubBackup {
  constructor({ config, dbPath }) {
    this.config = config || {};
    this.dbPath = path.resolve(dbPath);
    this.repoUrl = normalizeRepo(this.config.repo);
    this.repoDir = path.resolve(this.config.repoDir || path.dirname(this.dbPath));
    this.snapshotPath = String(this.config.snapshotPath || 'backups/k-vault.db').replace(/^\/+/, '');
    this.snapshotTempPath = path.join(path.dirname(this.dbPath), '.sqlite-backup.tmp');
    this.enabled = Boolean(this.config.enabled);
    this.requiredConfigured = Boolean(this.repoUrl && this.config.token);

    this.db = null;
    this.intervalHandle = null;
    this.idleHandle = null;
    this.flushPromise = null;
    this.dirty = false;
    this.activityCounter = 0;
    this.lastActivityAt = 0;
    this.lastBackupAt = 0;
    this.lastRestoreAt = 0;
    this.lastError = '';
    this.stoppedReason = 'idle';
  }

  validateConfig() {
    if (!this.enabled) return;
    if (!this.requiredConfigured) {
      throw new Error('SQLite GitHub backup is enabled but SQLITE_BACKUP_GITHUB_REPO/SQLITE_BACKUP_GITHUB_TOKEN is incomplete.');
    }
  }

  attachDatabase(db) {
    this.db = db;
  }

  getStatus() {
    if (!this.enabled) {
      return {
        enabled: false,
        running: false,
        dirty: false,
        message: 'SQLite GitHub backup disabled',
      };
    }

    return {
      enabled: true,
      running: Boolean(this.intervalHandle),
      dirty: this.dirty,
      branch: this.config.branch,
      snapshotPath: this.snapshotPath,
      lastActivityAt: this.lastActivityAt || null,
      lastBackupAt: this.lastBackupAt || null,
      lastRestoreAt: this.lastRestoreAt || null,
      message: this.lastError || (this.intervalHandle ? 'SQLite GitHub backup active' : `SQLite GitHub backup idle (${this.stoppedReason})`),
    };
  }

  buildGitEnv() {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    };

    if (!this.config.token) {
      return env;
    }

    const remoteUrl = new URL(this.repoUrl);
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${remoteUrl.protocol}//${remoteUrl.host}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.config.token}`).toString('base64')}`;
    return env;
  }

  runGit(args, options = {}) {
    const { cwd, allowFailure = false } = options;
    const env = this.buildGitEnv();

    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (allowFailure) {
          resolve({ ok: false, code: -1, stdout, stderr: error.message });
          return;
        }
        reject(error);
      });

      child.on('close', (code) => {
        const result = {
          ok: code === 0,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        };

        if (!result.ok && !allowFailure) {
          const message = result.stderr || result.stdout || `git ${args.join(' ')} failed with exit code ${code}`;
          reject(new Error(message));
          return;
        }

        resolve(result);
      });
    });
  }

  async remoteBranchExists() {
    const result = await this.runGit(
      ['ls-remote', '--heads', this.repoUrl, this.config.branch],
      { allowFailure: true }
    );
    return result.ok && Boolean(result.stdout);
  }

  async ensureGitLfs(repoDir) {
    if (!this.config.lfsEnabled) return;

    const version = await this.runGit(['lfs', 'version'], { allowFailure: true });
    if (!version.ok) {
      throw new Error('git-lfs is required for SQLite GitHub backup but is not available.');
    }

    await this.runGit(['-C', repoDir, 'lfs', 'install', '--local']);
    await this.runGit(['-C', repoDir, 'lfs', 'track', this.snapshotPath]);
  }

  async ensureRepoReady({ syncRemote = false } = {}) {
    await fsp.mkdir(path.dirname(this.repoDir), { recursive: true });

    if (!fs.existsSync(path.join(this.repoDir, '.git'))) {
      await this.runGit(['clone', this.repoUrl, this.repoDir]);
    }

    await this.runGit(['-C', this.repoDir, 'config', 'user.name', this.config.gitUserName]);
    await this.runGit(['-C', this.repoDir, 'config', 'user.email', this.config.gitUserEmail]);
    await this.ensureGitLfs(this.repoDir);

    const remoteBranchExists = await this.remoteBranchExists();
    const currentBranch = await this.runGit(['-C', this.repoDir, 'branch', '--show-current'], { allowFailure: true });
    const currentName = currentBranch.stdout.trim();

    if (remoteBranchExists) {
      const localBranch = await this.runGit(
        ['-C', this.repoDir, 'rev-parse', '--verify', `refs/heads/${this.config.branch}`],
        { allowFailure: true }
      );

      if (currentName !== this.config.branch) {
        if (localBranch.ok) {
          await this.runGit(['-C', this.repoDir, 'switch', this.config.branch]);
        } else {
          await this.runGit(['-C', this.repoDir, 'switch', '--track', `origin/${this.config.branch}`]);
        }
      }

      if (syncRemote) {
        await this.runGit(['-C', this.repoDir, 'pull', '--ff-only', 'origin', this.config.branch]);
        if (this.config.lfsEnabled) {
          await this.runGit(['-C', this.repoDir, 'lfs', 'pull', 'origin', this.config.branch]);
        }
      }
    } else if (currentName !== this.config.branch) {
      const localBranch = await this.runGit(
        ['-C', this.repoDir, 'rev-parse', '--verify', `refs/heads/${this.config.branch}`],
        { allowFailure: true }
      );

      if (localBranch.ok) {
        await this.runGit(['-C', this.repoDir, 'switch', this.config.branch]);
      } else {
        await this.runGit(['-C', this.repoDir, 'switch', '-c', this.config.branch]);
      }
    }
  }

  async restoreIfAvailable() {
    if (!this.enabled) {
      return { restored: false, skipped: true, reason: 'disabled' };
    }

    this.validateConfig();
    await this.ensureRepoReady({ syncRemote: true });

    const sourcePath = path.join(this.repoDir, this.snapshotPath);
    if (!fs.existsSync(sourcePath)) {
      return { restored: false, skipped: true, reason: 'missing-backup' };
    }

    if (!isLikelySqliteFile(sourcePath)) {
      throw new Error(`Backup file is not a valid SQLite snapshot: ${this.snapshotPath}`);
    }

    await fsp.mkdir(path.dirname(this.dbPath), { recursive: true });
    await fsp.copyFile(sourcePath, this.dbPath);
    this.lastRestoreAt = Date.now();
    this.lastError = '';

    console.log(`[sqlite-backup] Restored ${this.snapshotPath} from ${this.config.branch}`);

    return { restored: true, sourcePath };
  }

  recordActivity() {
    if (!this.enabled) return;

    this.lastActivityAt = Date.now();
    this.activityCounter += 1;
    this.dirty = true;
    this.lastError = '';

    if (!this.intervalHandle) {
      this.intervalHandle = setInterval(() => {
        void this.flushNow('interval');
      }, this.config.intervalMs);
    }

    if (this.idleHandle) {
      clearTimeout(this.idleHandle);
    }

    this.idleHandle = setTimeout(() => {
      void this.handleIdleTimeout();
    }, this.config.idleMs);
  }

  async handleIdleTimeout() {
    try {
      if (this.dirty) {
        await this.flushNow('idle-timeout');
      }
    } catch (error) {
      this.lastError = error?.message || String(error);
    } finally {
      if (this.dirty) {
        this.idleHandle = setTimeout(() => {
          void this.handleIdleTimeout();
        }, this.config.idleMs);
        return;
      }
      this.stop('idle-timeout');
    }
  }

  stop(reason = 'manual') {
    this.stoppedReason = reason;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.idleHandle) {
      clearTimeout(this.idleHandle);
      this.idleHandle = null;
    }
  }

  async exportSnapshot() {
    await fsp.mkdir(path.dirname(this.snapshotTempPath), { recursive: true });
    await fsp.rm(this.snapshotTempPath, { force: true });

    if (this.db) {
      this.db.exec(`VACUUM INTO '${sqliteLiteral(this.snapshotTempPath)}'`);
      return;
    }

    await fsp.copyFile(this.dbPath, this.snapshotTempPath);
  }

  async stageSnapshot() {
    await this.exportSnapshot();

    const repoSnapshotPath = path.join(this.repoDir, this.snapshotPath);
    await fsp.mkdir(path.dirname(repoSnapshotPath), { recursive: true });
    await fsp.copyFile(this.snapshotTempPath, repoSnapshotPath);

    const stageTargets = [this.snapshotPath];
    const gitattributesPath = path.join(this.repoDir, '.gitattributes');
    if (fs.existsSync(gitattributesPath)) {
      stageTargets.push('.gitattributes');
    }

    await this.runGit(['-C', this.repoDir, 'add', '--', ...stageTargets]);
    const status = await this.runGit(
      ['-C', this.repoDir, 'status', '--porcelain', '--', ...stageTargets],
      { allowFailure: true }
    );

    if (!status.ok) {
      throw new Error(status.stderr || 'git status failed');
    }

    if (!status.stdout) {
      return false;
    }
    return true;
  }

  async pushSnapshot(reason) {
    const commitMessage = `chore: backup sqlite (${reason}) ${new Date().toISOString()}`;

    await this.runGit(['-C', this.repoDir, 'commit', '-m', commitMessage]);

    const firstPush = await this.runGit(
      ['-C', this.repoDir, 'push', '-u', 'origin', this.config.branch],
      { allowFailure: true }
    );
    if (firstPush.ok) {
      return;
    }

    await this.runGit(['-C', this.repoDir, 'pull', '--rebase', 'origin', this.config.branch]);
    if (this.config.lfsEnabled) {
      await this.runGit(['-C', this.repoDir, 'lfs', 'pull', 'origin', this.config.branch], { allowFailure: true });
    }
    await this.runGit(['-C', this.repoDir, 'push', '-u', 'origin', this.config.branch]);
  }

  async performBackup(reason) {
    if (!this.dirty) return false;

    this.validateConfig();
    await this.ensureRepoReady();
    const snapshotActivity = this.activityCounter;

    const changed = await this.stageSnapshot();
    if (!changed) {
      this.dirty = this.activityCounter > snapshotActivity;
      return false;
    }

    await this.pushSnapshot(reason);
    this.dirty = this.activityCounter > snapshotActivity;
    this.lastBackupAt = Date.now();
    this.lastError = '';

    console.log(`[sqlite-backup] Pushed ${this.snapshotPath} to ${this.config.branch}`);

    return true;
  }

  async flushNow(reason = 'manual') {
    if (!this.enabled) return false;

    if (this.flushPromise) {
      return this.flushPromise;
    }

    this.flushPromise = (async () => {
      try {
        return await this.performBackup(reason);
      } catch (error) {
        this.lastError = error?.message || String(error);
        console.error('[sqlite-backup] Backup failed:', this.lastError);
        throw error;
      } finally {
        this.flushPromise = null;
      }
    })();

    return this.flushPromise;
  }

  async shutdown() {
    if (!this.enabled) return;

    this.stop('shutdown');

    if (this.flushPromise) {
      await this.flushPromise.catch(() => {});
    }

    if (this.dirty) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.flushNow('shutdown');
          break;
        } catch (error) {
          if (attempt === 1) {
            throw error;
          }
          await delay(1000);
        }
      }
    }
  }
}

function createSqliteGitHubBackup(config, dbPath) {
  const backup = new SqliteGitHubBackup({
    config,
    dbPath,
  });

  return backup.enabled ? backup : null;
}

module.exports = {
  SqliteGitHubBackup,
  createSqliteGitHubBackup,
};

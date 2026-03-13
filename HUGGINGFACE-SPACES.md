# HuggingFace Spaces Deployment

This repository does not map directly to HuggingFace Spaces out of the box because the original self-hosted setup uses two containers:

- `web`: Nginx static files + reverse proxy
- `api`: Node.js + Hono backend

To make Spaces deployment possible, this repository now includes a root-level `Dockerfile` that runs both parts inside one container.

## Runtime Routes

The HuggingFace container now serves the Vue app as the primary UI:

- `/` -> upload console
- `/login` -> admin login
- `/drive` -> drive/file manager
- `/storage` -> storage profile management
- `/status` -> frontend status page

Legacy static pages remain available for compatibility:

- `/admin.html`
- `/webdav.html`
- `/gallery.html`
- `/legacy/index.html`

## Recommended Space Setup

1. Create a new **Docker Space**.
2. Use the root `Dockerfile`.
3. Copy the contents of `README-HF-SPACES.md` to the root `README.md` in your Space repository.
4. Add the runtime secrets and variables listed below.
5. Configure SQLite GitHub backup if you need data to survive Space restarts.

## Runtime Secrets

These can still be created in **Space Settings -> Secrets**, but they are no longer mandatory when you use `/data` persistence or the SQLite GitHub backup flow.

| Name | Required | Purpose |
| :--- | :---: | :--- |
| `CONFIG_ENCRYPTION_KEY` | optional | Manual override for encrypting dynamic storage configurations |
| `SESSION_SECRET` | optional | Manual override for share-link/app signatures |
| `BASIC_PASS` | recommended | Admin password for the backend UI |

If `CONFIG_ENCRYPTION_KEY` / `SESSION_SECRET` are missing, K-Vault will:

1. generate both values on first startup
2. write them to `/data/k-vault.runtime-secrets.json`
3. reuse that file on later starts
4. back it up together with SQLite when SQLite GitHub backup is enabled

This means:

- with **Persistent Storage** enabled on the Space, the generated file stays on `/data`
- with **SQLite GitHub backup** enabled, the generated file is restored from and pushed to the backup repository
- without either of the above, Space rebuilds can lose the generated secrets and previously saved storage configs may become undecryptable

If you rely on SQLite GitHub backup for generated secrets, keep that backup repository private/trusted because it will now contain the runtime secret file.

## Recommended Variables

These can be created in **Space Settings -> Variables**.

| Name | Required | Recommended value | Purpose |
| :--- | :---: | :--- | :--- |
| `BASIC_USER` | recommended | `admin` | Admin username |
| `PUBLIC_BASE_URL` | recommended | `https://<your-space>.hf.space` | Public base URL used by share/webhook flows |
| `GUEST_UPLOAD` | optional | `false` | Enable guest uploads |
| `GUEST_MAX_FILE_SIZE` | optional | `5242880` | Guest single file limit in bytes |
| `GUEST_DAILY_LIMIT` | optional | `10` | Guest upload count per IP per day |
| `DEFAULT_STORAGE_TYPE` | optional | `telegram` | Bootstrap default storage type |
| `RUNTIME_SECRETS_AUTO_GENERATE` | optional | `true` | Auto-generate runtime secrets when env secrets are missing |
| `RUNTIME_SECRETS_FILE` | optional | `/data/k-vault.runtime-secrets.json` | Path of the generated runtime secret file |

## Storage Bootstrap Variables

You only need one storage backend to make uploads work immediately after startup.

If you do not set any backend variables, the app can still boot, and you can create storage profiles later in `/storage` after logging in.

### Telegram

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `TG_BOT_TOKEN` | Secret | yes |
| `TG_CHAT_ID` | Variable or Secret | yes |
| `CUSTOM_BOT_API_URL` | Variable | no |

### Cloudflare R2

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `R2_ENDPOINT` | Variable | yes |
| `R2_REGION` | Variable | no |
| `R2_BUCKET` | Variable | yes |
| `R2_ACCESS_KEY_ID` | Secret | yes |
| `R2_SECRET_ACCESS_KEY` | Secret | yes |

### S3-Compatible Storage

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `S3_ENDPOINT` | Variable | yes |
| `S3_REGION` | Variable | yes |
| `S3_BUCKET` | Variable | yes |
| `S3_ACCESS_KEY_ID` | Secret | yes |
| `S3_SECRET_ACCESS_KEY` | Secret | yes |

### Discord

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `DISCORD_WEBHOOK_URL` | Secret | one of two |
| `DISCORD_BOT_TOKEN` | Secret | recommended |
| `DISCORD_CHANNEL_ID` | Variable or Secret | bot mode only |

### HuggingFace Dataset Storage

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `HF_TOKEN` | Secret | yes |
| `HF_REPO` | Variable | yes |

### WebDAV

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `WEBDAV_BASE_URL` | Variable | yes |
| `WEBDAV_USERNAME` | Variable | conditional |
| `WEBDAV_PASSWORD` | Secret | conditional |
| `WEBDAV_BEARER_TOKEN` | Secret | conditional |
| `WEBDAV_ROOT_PATH` | Variable | no |

Use either `WEBDAV_USERNAME` + `WEBDAV_PASSWORD`, or `WEBDAV_BEARER_TOKEN`.

### GitHub

| Name | Where to store | Required |
| :--- | :--- | :---: |
| `GITHUB_REPO` | Variable | yes |
| `GITHUB_TOKEN` | Secret | yes |
| `GITHUB_MODE` | Variable | no |
| `GITHUB_PREFIX` | Variable | no |
| `GITHUB_RELEASE_TAG` | Variable | no |
| `GITHUB_BRANCH` | Variable | no |
| `GITHUB_API_BASE` | Variable | no |

## SQLite GitHub Backup

If your Space filesystem is ephemeral, use a separate GitHub repository as the SQLite backup target. K-Vault will:

- `git pull` the latest backup before the API starts
- restore `k-vault.db` from that repository
- start periodic backup only after SQLite writes happen
- stop the backup timer automatically after an idle period
- `git push` the latest SQLite snapshot back to GitHub

The backup flow uses `git-lfs` by default and the image now includes both `git` and `git-lfs`.
Make sure Git LFS is enabled for the backup repository before first use.

| Name | Where | Required | Purpose |
| :--- | :---: | :---: | :--- |
| `SQLITE_BACKUP_ENABLED` | Variable | no | Force enable/disable backup. If omitted, backup auto-enables when repo + token are present |
| `SQLITE_BACKUP_GITHUB_REPO` | Variable | yes* | Backup repo, e.g. `owner/repo` or full `https://github.com/...git` URL |
| `SQLITE_BACKUP_GITHUB_TOKEN` | Secret | yes* | GitHub token with push access to the backup repo |
| `SQLITE_BACKUP_GITHUB_BRANCH` | Variable | no | Branch to restore from and push to. Default: `main` |
| `SQLITE_BACKUP_PATH` | Variable | no | SQLite snapshot path inside the repo. Default: `backups/k-vault.db` |
| `SQLITE_BACKUP_SECRET_PATH` | Variable | no | Runtime secret file path inside the repo. Default: `backups/k-vault.runtime-secrets.json` |
| `SQLITE_BACKUP_INTERVAL_MS` | Variable | no | Backup interval after activity. Default: `15000` |
| `SQLITE_BACKUP_IDLE_MS` | Variable | no | Stop the timer after this much idle time. Default: `120000` |
| `SQLITE_BACKUP_GIT_LFS` | Variable | no | Use Git LFS for the SQLite snapshot. Default: `true` |
| `SQLITE_BACKUP_GIT_USER_NAME` | Variable | no | Commit author name |
| `SQLITE_BACKUP_GIT_USER_EMAIL` | Variable | no | Commit author email |

\* `SQLITE_BACKUP_GITHUB_REPO` and `SQLITE_BACKUP_GITHUB_TOKEN` are both required when backup is enabled.

## Variables You Usually Do Not Need To Override

These are already baked into the root `Dockerfile` for Spaces:

- `PORT=8787`
- `APP_PORT=7860`
- `DATA_DIR=/data`
- `DB_PATH=/data/k-vault.db`
- `CHUNK_DIR=/data/chunks`

## Minimum Working Configuration

If you want the smallest possible setup, start with:

- Variable: `BASIC_USER=admin`
- Secret: `BASIC_PASS=<your password>`
- Variable: `PUBLIC_BASE_URL=https://<your-space>.hf.space`
- one of:
  - Persistent Storage enabled for `/data`
  - SQLite GitHub backup configured
  - manual Secrets `CONFIG_ENCRYPTION_KEY` + `SESSION_SECRET`

Then either:

- add one bootstrap storage backend via variables/secrets, or
- log in after startup and create storage configs in `/storage`

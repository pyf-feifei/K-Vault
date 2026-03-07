# HuggingFace Spaces Deployment

This repository does not map directly to HuggingFace Spaces out of the box because the original self-hosted setup uses two containers:

- `web`: Nginx static files + reverse proxy
- `api`: Node.js + Hono backend

To make Spaces deployment possible, this repository now includes a root-level `Dockerfile` that runs both parts inside one container.

## Recommended Space Setup

1. Create a new **Docker Space**.
2. Use the root `Dockerfile`.
3. Copy the contents of `README-HF-SPACES.md` to the root `README.md` in your Space repository.
4. Add the runtime secrets and variables listed below.
5. If your Space supports persistent storage, keep it enabled so SQLite data survives restarts.

## Required Secrets

These should be created in **Space Settings -> Secrets**.

| Name | Required | Purpose |
| :--- | :---: | :--- |
| `CONFIG_ENCRYPTION_KEY` | yes | Encrypts dynamic storage configurations saved from the admin UI |
| `SESSION_SECRET` | yes | Signs session cookies and share links |
| `BASIC_PASS` | recommended | Admin password for the backend UI |

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

## Variables You Usually Do Not Need To Override

These are already baked into the root `Dockerfile` for Spaces:

- `PORT=8787`
- `APP_PORT=7860`
- `DATA_DIR=/data`
- `DB_PATH=/data/k-vault.db`
- `CHUNK_DIR=/data/chunks`

## Cloudflare D1 (Optional)

When configured, K-Vault uses Cloudflare D1 for persistent storage of `storage_configs`, `app_settings`, `sessions`, and `guest_upload_counters`. Files metadata stays in local SQLite.

| Name | Where | Required | Purpose |
| :--- | :---: | :---: | :--- |
| `CF_ACCOUNT_ID` | Variable | yes* | Cloudflare account ID |
| `CF_D1_DATABASE_ID` | Variable | yes* | D1 database ID |
| `CF_API_TOKEN` | Secret | yes* | API token with D1 Edit permission |
| `CF_D1_API_BASE` | Variable | no | Override API base (default: `https://api.cloudflare.com/client/v4`) |

\* All three (`CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN`) must be set to enable D1. Otherwise SQLite is used.

D1 tables are created automatically on first run. You can also run the schema manually:

```sh
npx wrangler d1 execute <db-name> --remote --file=server/lib/d1/schema.sql
```

## Minimum Working Configuration

If you want the smallest possible setup, start with:

- Secret: `CONFIG_ENCRYPTION_KEY`
- Secret: `SESSION_SECRET`
- Variable: `BASIC_USER=admin`
- Secret: `BASIC_PASS=<your password>`
- Variable: `PUBLIC_BASE_URL=https://<your-space>.hf.space`

Then either:

- add one bootstrap storage backend via variables/secrets, or
- log in after startup and create storage configs in `/storage`

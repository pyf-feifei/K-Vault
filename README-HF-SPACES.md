---
title: K-Vault
sdk: docker
app_port: 7860
---

This Space runs the single-container HuggingFace deployment of K-Vault.

Setup instructions and runtime variable details are documented in `HUGGINGFACE-SPACES.md`.

If `CONFIG_ENCRYPTION_KEY` / `SESSION_SECRET` are not provided, K-Vault now auto-generates them on first startup and stores them in `/data/k-vault.runtime-secrets.json`. When SQLite GitHub backup is enabled, that file is backed up together with SQLite.

Primary UI routes after deployment:

- `/` upload console
- `/login` admin login
- `/storage` storage profile management
- `/drive` drive manager
- `/status` status page

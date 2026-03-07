const { serve } = require('@hono/node-server');
const { createApp } = require('./app');

async function main() {
  const app = await createApp();
  const port = Number(process.env.PORT || 8787);
  console.log(`[k-vault] Starting Docker runtime on :${port}`);
  serve({ fetch: app.fetch, port });
}

main().catch((err) => {
  console.error('[k-vault] Startup failed:', err);
  process.exit(1);
});

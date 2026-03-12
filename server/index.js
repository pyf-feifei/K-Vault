const { serve } = require('@hono/node-server');
const { createApp } = require('./app');

async function main() {
  const app = await createApp();
  const container = app.container;
  const port = Number(process.env.PORT || 8787);
  console.log(`[k-vault] Starting Docker runtime on :${port}`);
  serve({ fetch: app.fetch, port });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[k-vault] Received ${signal}, flushing state...`);
    try {
      await container?.close?.();
    } catch (error) {
      console.error('[k-vault] Shutdown failed:', error);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  console.error('[k-vault] Startup failed:', err);
  process.exit(1);
});

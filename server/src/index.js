import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool, pingDb } from './db.js';

const app = createApp();

const server = app.listen(env.port, async () => {
  const dbUp = await pingDb();
  console.log(`Hospital ERP API listening on http://localhost:${env.port} (db ${dbUp ? 'up' : 'DOWN'})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

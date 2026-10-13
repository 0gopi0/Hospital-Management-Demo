/**
 * Applies server/migrations/*.sql in filename order, recording each in
 * `schema_migrations` so re-runs are no-ops.
 *
 *   node scripts/migrate.js          apply pending migrations
 *   node scripts/migrate.js --fresh  DROP every table in DB_NAME first, then apply all
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { createMigrationConnection } from '../src/db.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const fresh = process.argv.includes('--fresh');

async function dropAllTables(conn) {
  const [tables] = await conn.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    [env.db.name]
  );
  if (tables.length === 0) return;
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { name } of tables) {
    await conn.query(`DROP TABLE IF EXISTS \`${name}\``);
    console.log(`  dropped table ${name}`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

async function main() {
  const conn = await createMigrationConnection();
  try {
    console.log(
      `Migrating ${env.db.user}@${env.db.host}:${env.db.port}/${env.db.name}${fresh ? ' (--fresh)' : ''}`
    );
    if (fresh) await dropAllTables(conn);

    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const [appliedRows] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip  ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      console.log(`  apply ${file}`);
      count += 1;
    }
    console.log(`Done. ${count} migration(s) applied.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

import mysql from 'mysql2/promise';
import { env } from './config/env.js';

const baseConfig = {
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.name,
  charset: 'utf8mb4',
  timezone: 'Z',
  // DATE columns come back as 'YYYY-MM-DD'; DATETIME/TIMESTAMP as JS Dates (UTC).
  dateStrings: ['DATE'],
  // DECIMAL money columns come back as numbers rather than strings.
  decimalNumbers: true,
};

export const pool = mysql.createPool({
  ...baseConfig,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  enableKeepAlive: true,
});

// Store and compare all DATETIMEs in UTC regardless of the server's local zone.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Run a parameterised query and return rows. */
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** Run `fn(conn)` inside a transaction, committing on success. */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Dedicated single connection allowing multi-statement SQL (migrations/seed only). */
export async function createMigrationConnection() {
  const conn = await mysql.createConnection({ ...baseConfig, multipleStatements: true });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}

export async function pingDb() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

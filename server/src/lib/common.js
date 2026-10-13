import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from './httpError.js';

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** Query-string boolean: "true"/"1" → true, "false"/"0" → false. */
export const qbool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Non-negative money amount rounded to 2 decimals. */
export const money = z.coerce
  .number()
  .nonnegative()
  .max(100_000_000)
  .transform((n) => Math.round(n * 100) / 100);

export const positiveMoney = money.refine((n) => n > 0, 'Must be greater than 0');

export const isoDate = z.iso.date();
export const dateTime = z.coerce.date();

export const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** SELECT a row by id (optionally FOR UPDATE on `conn`) or throw 404. */
export async function findOr404(table, id, { conn = pool, label = table, lock = false } = {}) {
  const [[row]] = await conn.query(
    `SELECT * FROM \`${table}\` WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  if (!row) throw HttpError.notFound(`${label} ${id} not found`);
  return row;
}

/** Builds a SET clause from an object of column → value, skipping undefined. */
export function buildSet(fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  return {
    sql: entries.map(([k]) => `\`${k}\` = ?`).join(', '),
    params: entries.map(([, v]) => v),
    empty: entries.length === 0,
  };
}

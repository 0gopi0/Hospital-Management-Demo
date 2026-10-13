import { z } from 'zod';
import { pool } from '../db.js';
import { likeEscape } from './common.js';

/**
 * Standard list query schema: page, limit, search, sort (one of sortMap keys), order,
 * plus any route-specific filters in `extra`.
 */
export const listSchema = (sortMap, extra = {}, defaultOrder = 'desc') => {
  const keys = Object.keys(sortMap);
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(keys).default(keys[0]),
    order: z.enum(['asc', 'desc']).default(defaultOrder),
    ...extra,
  });
};

/**
 * Runs a paginated list query.
 *   select     column list, e.g. 'p.*'
 *   from       FROM + JOIN clause (without the word FROM)
 *   where      array of [sql, ...params] filters (falsy entries skipped)
 *   searchCols columns matched with LIKE against q.search
 *   sortMap    sort key → column expression
 */
export async function paginate({ select, from, where = [], searchCols = [], sortMap, q, map = (r) => r }) {
  const clauses = [];
  const params = [];
  for (const w of where.filter(Boolean)) {
    const [sql, ...values] = w;
    clauses.push(sql);
    params.push(...values);
  }
  if (q.search && searchCols.length) {
    const term = `%${likeEscape(q.search)}%`;
    clauses.push(`(${searchCols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    params.push(...searchCols.map(() => term));
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (q.page - 1) * q.limit;

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${from} ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${sortMap[q.sort]} ${dir}, 1 ${dir} LIMIT ? OFFSET ?`,
    [...params, q.limit, offset]
  );

  return {
    data: rows.map(map),
    pagination: {
      page: q.page,
      limit: q.limit,
      total: Number(total),
      totalPages: Math.max(1, Math.ceil(Number(total) / q.limit)),
    },
  };
}

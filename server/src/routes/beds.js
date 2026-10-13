import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { findOr404, idParamSchema, money } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

const SORT = { ward: "CONCAT(w.name, '-', LPAD(b.bed_number, 6, '0'))", id: 'b.id', status: 'b.status', rate: 'b.daily_rate' };
const listQuery = listSchema(
  SORT,
  {
    ward_id: z.coerce.number().int().positive().optional(),
    status: z.enum(['available', 'occupied', 'maintenance']).optional(),
  },
  'asc'
);

const wardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().trim().max(40).default('general'),
  floor: z.string().trim().max(20).nullish(),
});
const bedSchema = z.object({
  ward_id: z.coerce.number().int().positive(),
  bed_number: z.string().trim().min(1).max(20),
  daily_rate: money.default(0),
  status: z.enum(['available', 'maintenance']).default('available'),
});
const bedUpdateSchema = z
  .object({
    bed_number: z.string().trim().min(1).max(20).optional(),
    daily_rate: money.optional(),
    status: z.enum(['available', 'maintenance']).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'No fields to update');

const SELECT = `b.id, b.*, w.name AS ward_name, w.type AS ward_type,
  ad.id AS admission_id, ad.patient_id, CONCAT(p.first_name, ' ', p.last_name) AS patient_name`;
const FROM = `beds b JOIN wards w ON w.id = b.ward_id
  LEFT JOIN admissions ad ON ad.bed_id = b.id AND ad.status = 'admitted'
  LEFT JOIN patients p ON p.id = ad.patient_id`;

async function getBed(id) {
  const [row] = await query(`SELECT ${SELECT} FROM ${FROM} WHERE b.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Bed ${id} not found`);
  return row;
}

// ---------------------------------------------------------------- wards
router.get(
  '/wards',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT w.*, COUNT(b.id) AS total_beds,
              COALESCE(SUM(b.status = 'available'), 0) AS available,
              COALESCE(SUM(b.status = 'occupied'), 0) AS occupied,
              COALESCE(SUM(b.status = 'maintenance'), 0) AS maintenance
         FROM wards w LEFT JOIN beds b ON b.ward_id = w.id
        GROUP BY w.id ORDER BY w.name`
    );
    res.json({ data: rows.map((r) => ({ ...r, available: Number(r.available), occupied: Number(r.occupied), maintenance: Number(r.maintenance) })) });
  })
);

router.post(
  '/wards',
  requireRole(),
  validate(wardSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const r = await query('INSERT INTO wards (name, type, floor) VALUES (?, ?, ?)', [b.name, b.type, b.floor ?? null]);
    res.status(201).json(await findOr404('wards', r.insertId, { label: 'Ward' }));
  })
);

// ---------------------------------------------------------------- beds
router.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    res.json(
      await paginate({
        select: SELECT,
        from: FROM,
        where: [q.ward_id && ['b.ward_id = ?', q.ward_id], q.status && ['b.status = ?', q.status]],
        searchCols: ['b.bed_number', 'w.name', 'p.first_name', 'p.last_name'],
        sortMap: SORT,
        q,
      })
    );
  })
);

router.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => res.json(await getBed(req.valid.params.id)))
);

router.post(
  '/',
  requireRole(),
  validate(bedSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    await findOr404('wards', b.ward_id, { label: 'Ward' });
    const r = await query('INSERT INTO beds (ward_id, bed_number, daily_rate, status) VALUES (?, ?, ?, ?)', [
      b.ward_id, b.bed_number, b.daily_rate, b.status,
    ]);
    res.status(201).json(await getBed(r.insertId));
  })
);

// Occupancy is only ever changed by admit/discharge; this edits metadata or toggles maintenance.
router.patch(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  validate(bedUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    await withTransaction(async (conn) => {
      const bed = await findOr404('beds', id, { conn, label: 'Bed', lock: true });
      if (b.status && bed.status === 'occupied') {
        throw HttpError.conflict('Bed is occupied; discharge the patient before changing its status');
      }
      await conn.query('UPDATE beds SET bed_number = ?, daily_rate = ?, status = ? WHERE id = ?', [
        b.bed_number ?? bed.bed_number, b.daily_rate ?? bed.daily_rate, b.status ?? bed.status, id,
      ]);
    });
    res.json(await getBed(id));
  })
);

router.delete(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const bed = await findOr404('beds', req.valid.params.id, { label: 'Bed' });
    if (bed.status === 'occupied') throw HttpError.conflict('Cannot delete an occupied bed');
    await query('DELETE FROM beds WHERE id = ?', [bed.id]);
    res.status(204).end();
  })
);

export default router;

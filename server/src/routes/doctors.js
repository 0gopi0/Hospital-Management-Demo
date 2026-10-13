import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { buildSet, findOr404, idParamSchema, money, qbool } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

const SORT = { name: 'd.name', id: 'd.id', department: 'dp.name', fee: 'd.consultation_fee', created: 'd.created_at' };
const listQuery = listSchema(
  SORT,
  {
    department_id: z.coerce.number().int().positive().optional(),
    active: qbool.optional(),
  },
  'asc'
);

const baseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  department_id: z.coerce.number().int().positive(),
  user_id: z.coerce.number().int().positive().nullish(),
  specialization: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.email().trim().toLowerCase().nullish(),
  consultation_fee: money.default(0),
  is_active: z.boolean().default(true),
});
const updateSchema = baseSchema.partial().refine((o) => Object.keys(o).length > 0, 'No fields to update');

const SELECT = 'd.id, d.*, dp.name AS department_name';
const FROM = 'doctors d JOIN departments dp ON dp.id = d.department_id';

async function getDoctor(id) {
  const [row] = await query(`SELECT ${SELECT} FROM ${FROM} WHERE d.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Doctor ${id} not found`);
  return row;
}

async function checkRefs({ department_id, user_id }) {
  if (department_id) await findOr404('departments', department_id, { label: 'Department' });
  if (user_id) {
    const user = await findOr404('users', user_id, { label: 'User' });
    if (user.role !== 'doctor') throw HttpError.badRequest('Linked user must have role "doctor"');
  }
}

router.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    res.json(
      await paginate({
        select: SELECT,
        from: FROM,
        where: [
          q.department_id && ['d.department_id = ?', q.department_id],
          q.active !== undefined && ['d.is_active = ?', q.active ? 1 : 0],
        ],
        searchCols: ['d.name', 'd.specialization', 'd.phone', 'd.email', 'dp.name'],
        sortMap: SORT,
        q,
      })
    );
  })
);

router.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const doctor = await getDoctor(req.valid.params.id);
    const upcoming = await query(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.patient_id,
              CONCAT(p.first_name, ' ', p.last_name) AS patient_name
         FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.doctor_id = ? AND a.status = 'scheduled' AND a.starts_at >= NOW()
        ORDER BY a.starts_at LIMIT 20`,
      [doctor.id]
    );
    res.json({ ...doctor, upcoming_appointments: upcoming });
  })
);

router.post(
  '/',
  requireRole(),
  validate(baseSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    await checkRefs(b);
    const r = await query(
      `INSERT INTO doctors (name, department_id, user_id, specialization, phone, email, consultation_fee, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.name, b.department_id, b.user_id ?? null, b.specialization ?? null, b.phone ?? null,
        b.email ?? null, b.consultation_fee, b.is_active ? 1 : 0]
    );
    res.status(201).json(await getDoctor(r.insertId));
  })
);

router.patch(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await getDoctor(id);
    const b = req.valid.body;
    await checkRefs(b);
    const set = buildSet({ ...b, is_active: b.is_active === undefined ? undefined : b.is_active ? 1 : 0 });
    await query(`UPDATE doctors SET ${set.sql} WHERE id = ?`, [...set.params, id]);
    res.json(await getDoctor(id));
  })
);

router.delete(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await getDoctor(req.valid.params.id);
    await query('DELETE FROM doctors WHERE id = ?', [req.valid.params.id]);
    res.status(204).end();
  })
);

export default router;

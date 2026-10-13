import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { findOr404, idParamSchema, qbool } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

const SORT = { admitted: 'ad.admitted_at', id: 'ad.id', discharged: 'ad.discharged_at', patient: 'p.last_name' };
const listQuery = listSchema(SORT, {
  status: z.enum(['admitted', 'discharged']).optional(),
  patient_id: z.coerce.number().int().positive().optional(),
  ward_id: z.coerce.number().int().positive().optional(),
});

const createSchema = z.object({
  patient_id: z.coerce.number().int().positive(),
  bed_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive().nullish(),
  reason: z.string().trim().max(255).nullish(),
});
const updateSchema = z
  .object({
    doctor_id: z.coerce.number().int().positive().nullish(),
    reason: z.string().trim().max(255).nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, 'No fields to update');
const dischargeSchema = z.object({ notes: z.string().trim().max(5000).optional() });
const forceQuery = z.object({ force: qbool.optional() });

const SELECT = `ad.id, ad.*, CONCAT(p.first_name, ' ', p.last_name) AS patient_name, p.mrn,
  b.bed_number, w.id AS ward_id, w.name AS ward_name, d.name AS doctor_name`;
const FROM = `admissions ad
  JOIN patients p ON p.id = ad.patient_id
  JOIN beds b ON b.id = ad.bed_id
  JOIN wards w ON w.id = b.ward_id
  LEFT JOIN doctors d ON d.id = ad.doctor_id`;

async function getAdmission(id) {
  const [row] = await query(`SELECT ${SELECT} FROM ${FROM} WHERE ad.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Admission ${id} not found`);
  const bills = await query(
    'SELECT id, bill_number, total, paid, balance, status FROM bills WHERE admission_id = ? ORDER BY id',
    [id]
  );
  return { ...row, bills };
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
          q.status && ['ad.status = ?', q.status],
          q.patient_id && ['ad.patient_id = ?', q.patient_id],
          q.ward_id && ['w.id = ?', q.ward_id],
        ],
        searchCols: ['p.first_name', 'p.last_name', 'p.mrn', 'b.bed_number', 'w.name', 'ad.reason'],
        sortMap: SORT,
        q,
      })
    );
  })
);

router.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => res.json(await getAdmission(req.valid.params.id)))
);

router.post(
  '/',
  requireRole('receptionist', 'doctor'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const id = await withTransaction(async (conn) => {
      // Lock the patient first so two concurrent admissions for the same patient serialise.
      await findOr404('patients', b.patient_id, { conn, label: 'Patient', lock: true });
      if (b.doctor_id) await findOr404('doctors', b.doctor_id, { conn, label: 'Doctor' });

      const [[active]] = await conn.query(
        "SELECT id, bed_id FROM admissions WHERE patient_id = ? AND status = 'admitted' LIMIT 1",
        [b.patient_id]
      );
      if (active) throw HttpError.conflict('Patient is already admitted', { admissionId: active.id, bedId: active.bed_id });

      const bed = await findOr404('beds', b.bed_id, { conn, label: 'Bed', lock: true });
      if (bed.status !== 'available') {
        throw HttpError.conflict(`Bed is not available (status: ${bed.status})`, { bedId: bed.id, status: bed.status });
      }

      const [r] = await conn.query(
        'INSERT INTO admissions (patient_id, bed_id, doctor_id, reason, created_by) VALUES (?, ?, ?, ?, ?)',
        [b.patient_id, b.bed_id, b.doctor_id ?? null, b.reason ?? null, req.user.id]
      );
      await conn.query("UPDATE beds SET status = 'occupied' WHERE id = ?", [b.bed_id]);
      return r.insertId;
    });
    res.status(201).json(await getAdmission(id));
  })
);

router.patch(
  '/:id',
  requireRole('receptionist', 'doctor'),
  validate(idParamSchema, 'params'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    const adm = await findOr404('admissions', id, { label: 'Admission' });
    if (b.doctor_id) await findOr404('doctors', b.doctor_id, { label: 'Doctor' });
    await query('UPDATE admissions SET doctor_id = ?, reason = ? WHERE id = ?', [
      b.doctor_id === undefined ? adm.doctor_id : b.doctor_id,
      b.reason === undefined ? adm.reason : b.reason,
      id,
    ]);
    res.json(await getAdmission(id));
  })
);

router.post(
  '/:id/discharge',
  requireRole('receptionist', 'doctor'),
  validate(idParamSchema, 'params'),
  validate(forceQuery, 'query'),
  validate(dischargeSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const force = req.valid.query.force ?? false;
    await withTransaction(async (conn) => {
      const adm = await findOr404('admissions', id, { conn, label: 'Admission', lock: true });
      if (adm.status !== 'admitted') throw HttpError.conflict('Patient is already discharged');

      const [unpaid] = await conn.query(
        `SELECT id, bill_number, total, paid, balance, status FROM bills
          WHERE admission_id = ? AND status IN ('unpaid', 'partial') AND balance > 0 FOR UPDATE`,
        [id]
      );
      const balance = Math.round(unpaid.reduce((s, b) => s + Number(b.balance) * 100, 0)) / 100;
      if (balance > 0 && !force) {
        throw HttpError.paymentRequired('Admission has unpaid bills. Settle them or discharge with ?force=true.', {
          balance,
          bills: unpaid,
        });
      }

      await conn.query(
        "UPDATE admissions SET status = 'discharged', discharged_at = NOW(), discharge_notes = ? WHERE id = ?",
        [req.valid.body.notes ?? null, id]
      );
      await conn.query("UPDATE beds SET status = 'available' WHERE id = ?", [adm.bed_id]);
    });
    res.json(await getAdmission(id));
  })
);

export default router;

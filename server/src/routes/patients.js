import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { buildSet, findOr404, idParamSchema, isoDate, qbool } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

const SORT = {
  created: 'p.created_at',
  id: 'p.id',
  name: "CONCAT(p.last_name, ' ', p.first_name)",
  mrn: 'p.mrn',
  dob: 'p.dob',
};
const listQuery = listSchema(SORT, {
  gender: z.enum(['male', 'female', 'other']).optional(),
  phone: z.string().trim().max(30).optional(),
});

const normalizePhone = (s) => s.replace(/[^\d+]/g, '');

const baseSchema = z.object({
  mrn: z.string().trim().min(3).max(30).optional(),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  dob: isoDate.nullish().refine((d) => !d || new Date(d) <= new Date(), 'Date of birth cannot be in the future'),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  phone: z
    .string()
    .trim()
    .transform(normalizePhone)
    .pipe(z.string().min(7, 'Phone must have at least 7 digits').max(20)),
  email: z.email().trim().toLowerCase().nullish(),
  address: z.string().trim().max(255).nullish(),
  blood_group: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullish(),
  emergency_contact: z.string().trim().max(120).nullish(),
});
const createSchema = baseSchema.extend({ force: z.boolean().default(false) });
const updateSchema = baseSchema
  .partial()
  .extend({ force: z.boolean().default(false) })
  .refine((o) => Object.keys(o).some((k) => k !== 'force'), 'No fields to update');
const forceQuery = z.object({ force: qbool.optional() });

/** 409 with the existing patient(s) unless force is set. */
async function assertPhoneUnique(conn, phone, { force, excludeId = 0 }) {
  if (force) return;
  const [existing] = await conn.query(
    `SELECT id, mrn, first_name, last_name, phone FROM patients WHERE phone = ? AND id <> ? ORDER BY id LIMIT 5`,
    [phone, excludeId]
  );
  if (existing.length) {
    throw HttpError.conflict('A patient with this phone number already exists. Resend with force=true to create anyway.', {
      existingId: existing[0].id,
      matches: existing,
    });
  }
}

router.get(
  '/',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    res.json(
      await paginate({
        select: 'p.id, p.*',
        from: 'patients p',
        where: [
          q.gender && ['p.gender = ?', q.gender],
          q.phone && ['p.phone = ?', normalizePhone(q.phone)],
        ],
        searchCols: ['p.mrn', 'p.first_name', 'p.last_name', "CONCAT(p.first_name, ' ', p.last_name)", 'p.phone', 'p.email'],
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
    const patient = await findOr404('patients', req.valid.params.id, { label: 'Patient' });
    const id = patient.id;
    const [appointments, admissions, bills, labOrders, prescriptions] = await Promise.all([
      query(
        `SELECT a.id, a.starts_at, a.ends_at, a.status, a.reason, d.name AS doctor_name
           FROM appointments a JOIN doctors d ON d.id = a.doctor_id
          WHERE a.patient_id = ? ORDER BY a.starts_at DESC LIMIT 20`,
        [id]
      ),
      query(
        `SELECT ad.id, ad.status, ad.admitted_at, ad.discharged_at, b.bed_number, w.name AS ward_name
           FROM admissions ad JOIN beds b ON b.id = ad.bed_id JOIN wards w ON w.id = b.ward_id
          WHERE ad.patient_id = ? ORDER BY ad.admitted_at DESC LIMIT 20`,
        [id]
      ),
      query('SELECT id, bill_number, total, paid, balance, status, created_at FROM bills WHERE patient_id = ? ORDER BY id DESC LIMIT 20', [id]),
      query('SELECT id, status, priority, is_critical, created_at FROM lab_orders WHERE patient_id = ? ORDER BY id DESC LIMIT 20', [id]),
      query('SELECT id, status, doctor_id, created_at FROM prescriptions WHERE patient_id = ? ORDER BY id DESC LIMIT 20', [id]),
    ]);
    res.json({ ...patient, appointments, admissions, bills, lab_orders: labOrders, prescriptions });
  })
);

router.post(
  '/',
  requireRole('receptionist', 'doctor'),
  validate(forceQuery, 'query'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { force, mrn, ...b } = req.valid.body;
    const id = await withTransaction(async (conn) => {
      await assertPhoneUnique(conn, b.phone, { force: force || req.valid.query.force });
      // Temporary unique MRN, replaced with one derived from the id when none is supplied.
      const [r] = await conn.query(
        `INSERT INTO patients (mrn, first_name, last_name, dob, gender, phone, email, address, blood_group, emergency_contact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [mrn ?? `TMP-${crypto.randomUUID().slice(0, 20)}`, b.first_name, b.last_name, b.dob ?? null, b.gender ?? null,
          b.phone, b.email ?? null, b.address ?? null, b.blood_group ?? null, b.emergency_contact ?? null]
      );
      if (!mrn) await conn.query('UPDATE patients SET mrn = ? WHERE id = ?', [`MRN${String(r.insertId).padStart(6, '0')}`, r.insertId]);
      return r.insertId;
    });
    res.status(201).json(await findOr404('patients', id, { label: 'Patient' }));
  })
);

router.patch(
  '/:id',
  requireRole('receptionist', 'doctor'),
  validate(idParamSchema, 'params'),
  validate(forceQuery, 'query'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const { force, ...b } = req.valid.body;
    await withTransaction(async (conn) => {
      const current = await findOr404('patients', id, { conn, label: 'Patient', lock: true });
      if (b.phone && b.phone !== current.phone) {
        await assertPhoneUnique(conn, b.phone, { force: force || req.valid.query.force, excludeId: id });
      }
      const set = buildSet(b);
      await conn.query(`UPDATE patients SET ${set.sql} WHERE id = ?`, [...set.params, id]);
    });
    res.json(await findOr404('patients', id, { label: 'Patient' }));
  })
);

router.delete(
  '/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await findOr404('patients', req.valid.params.id, { label: 'Patient' });
    await query('DELETE FROM patients WHERE id = ?', [req.valid.params.id]);
    res.status(204).end();
  })
);

export default router;

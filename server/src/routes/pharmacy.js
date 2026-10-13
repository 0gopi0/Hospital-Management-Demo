import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { buildSet, findOr404, idParamSchema, isoDate, money, qbool } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- medicines
const MED_SORT = { name: 'm.name', id: 'm.id', sku: 'm.sku', stock: 'm.stock_qty', expiry: 'm.expiry_date', price: 'm.unit_price' };
const medListQuery = listSchema(MED_SORT, { low_stock: qbool.optional(), expired: qbool.optional(), expiring_days: z.coerce.number().int().min(1).max(365).optional() }, 'asc');
const medSchema = z.object({
  sku: z.string().trim().min(2).max(40).toUpperCase(),
  name: z.string().trim().min(2).max(150),
  generic_name: z.string().trim().max(150).nullish(),
  form: z.string().trim().max(40).nullish(),
  strength: z.string().trim().max(40).nullish(),
  unit_price: money.default(0),
  stock_qty: z.coerce.number().int().min(0).max(10_000_000).default(0),
  reorder_level: z.coerce.number().int().min(0).max(1_000_000).default(10),
  batch_no: z.string().trim().max(40).nullish(),
  expiry_date: isoDate,
});
const medUpdateSchema = medSchema.omit({ stock_qty: true }).partial().refine((o) => Object.keys(o).length > 0, 'No fields to update');
const stockSchema = z.object({
  delta: z.coerce.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.string().trim().min(3).max(255),
});

const medFlags = (m) => ({ ...m, is_low_stock: m.stock_qty <= m.reorder_level, is_expired: m.expiry_date < today() });

router.get(
  '/medicines',
  requireRole('pharmacist', 'doctor'),
  validate(medListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    res.json(
      await paginate({
        select: 'm.id, m.*',
        from: 'medicines m',
        where: [
          q.low_stock !== undefined && [q.low_stock ? 'm.stock_qty <= m.reorder_level' : 'm.stock_qty > m.reorder_level'],
          q.expired !== undefined && [q.expired ? 'm.expiry_date < CURDATE()' : 'm.expiry_date >= CURDATE()'],
          q.expiring_days && ['m.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)', q.expiring_days],
        ],
        searchCols: ['m.sku', 'm.name', 'm.generic_name', 'm.batch_no'],
        sortMap: MED_SORT,
        q,
        map: medFlags,
      })
    );
  })
);

router.get(
  '/medicines/:id',
  requireRole('pharmacist', 'doctor'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => res.json(medFlags(await findOr404('medicines', req.valid.params.id, { label: 'Medicine' }))))
);

router.post(
  '/medicines',
  requireRole('pharmacist'),
  validate(medSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const r = await query(
      `INSERT INTO medicines (sku, name, generic_name, form, strength, unit_price, stock_qty, reorder_level, batch_no, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.sku, b.name, b.generic_name ?? null, b.form ?? null, b.strength ?? null, b.unit_price, b.stock_qty, b.reorder_level, b.batch_no ?? null, b.expiry_date]
    );
    res.status(201).json(medFlags(await findOr404('medicines', r.insertId, { label: 'Medicine' })));
  })
);

router.patch(
  '/medicines/:id',
  requireRole('pharmacist'),
  validate(idParamSchema, 'params'),
  validate(medUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await findOr404('medicines', id, { label: 'Medicine' });
    const set = buildSet(req.valid.body);
    await query(`UPDATE medicines SET ${set.sql} WHERE id = ?`, [...set.params, id]);
    res.json(medFlags(await findOr404('medicines', id, { label: 'Medicine' })));
  })
);

// Stock adjustments (restock / write-off) — never lets stock go negative.
router.post(
  '/medicines/:id/stock',
  requireRole('pharmacist'),
  validate(idParamSchema, 'params'),
  validate(stockSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const { delta } = req.valid.body;
    await withTransaction(async (conn) => {
      const med = await findOr404('medicines', id, { conn, label: 'Medicine', lock: true });
      if (med.stock_qty + delta < 0) {
        throw HttpError.conflict('Adjustment would make stock negative', { stock_qty: med.stock_qty, delta });
      }
      await conn.query('UPDATE medicines SET stock_qty = stock_qty + ? WHERE id = ?', [delta, id]);
    });
    res.json(medFlags(await findOr404('medicines', id, { label: 'Medicine' })));
  })
);

router.delete(
  '/medicines/:id',
  requireRole(),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    await findOr404('medicines', req.valid.params.id, { label: 'Medicine' });
    await query('DELETE FROM medicines WHERE id = ?', [req.valid.params.id]);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- prescriptions
const RX_SORT = { created: 'rx.created_at', id: 'rx.id', status: 'rx.status', patient: 'p.last_name' };
const rxListQuery = listSchema(RX_SORT, {
  status: z.enum(['pending', 'dispensed', 'cancelled']).optional(),
  patient_id: z.coerce.number().int().positive().optional(),
  doctor_id: z.coerce.number().int().positive().optional(),
});
const rxSchema = z.object({
  patient_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive().optional(),
  appointment_id: z.coerce.number().int().positive().nullish(),
  notes: z.string().trim().max(255).nullish(),
  items: z
    .array(
      z.object({
        medicine_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive().max(10_000),
        dosage: z.string().trim().max(60).nullish(),
        frequency: z.string().trim().max(60).nullish(),
        duration_days: z.coerce.number().int().positive().max(365).nullish(),
        instructions: z.string().trim().max(255).nullish(),
      })
    )
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.medicine_id)).size === items.length, 'Each medicine may appear only once'),
});

const RX_SELECT = `rx.id, rx.*, CONCAT(p.first_name, ' ', p.last_name) AS patient_name, p.mrn, d.name AS doctor_name`;
const RX_FROM = 'prescriptions rx JOIN patients p ON p.id = rx.patient_id JOIN doctors d ON d.id = rx.doctor_id';

async function getPrescription(id) {
  const [row] = await query(`SELECT ${RX_SELECT} FROM ${RX_FROM} WHERE rx.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Prescription ${id} not found`);
  const items = await query(
    `SELECT pi.*, m.sku, m.name AS medicine_name, m.stock_qty, m.expiry_date, m.unit_price
       FROM prescription_items pi JOIN medicines m ON m.id = pi.medicine_id
      WHERE pi.prescription_id = ? ORDER BY pi.id`,
    [id]
  );
  return { ...row, items };
}

router.get(
  '/prescriptions',
  requireRole('pharmacist', 'doctor'),
  validate(rxListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    res.json(
      await paginate({
        select: RX_SELECT,
        from: RX_FROM,
        where: [
          q.status && ['rx.status = ?', q.status],
          q.patient_id && ['rx.patient_id = ?', q.patient_id],
          q.doctor_id && ['rx.doctor_id = ?', q.doctor_id],
        ],
        searchCols: ['p.first_name', 'p.last_name', 'p.mrn', 'd.name'],
        sortMap: RX_SORT,
        q,
      })
    );
  })
);

router.get(
  '/prescriptions/:id',
  requireRole('pharmacist', 'doctor'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => res.json(await getPrescription(req.valid.params.id)))
);

router.post(
  '/prescriptions',
  requireRole('doctor'),
  validate(rxSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    let doctorId = b.doctor_id;
    if (req.user.role === 'doctor') {
      const [own] = await query('SELECT id FROM doctors WHERE user_id = ?', [req.user.id]);
      if (!own) throw HttpError.forbidden('Your user account is not linked to a doctor profile');
      doctorId = own.id;
    }
    if (!doctorId) throw HttpError.badRequest('doctor_id is required');

    const id = await withTransaction(async (conn) => {
      await findOr404('patients', b.patient_id, { conn, label: 'Patient' });
      await findOr404('doctors', doctorId, { conn, label: 'Doctor' });
      if (b.appointment_id) await findOr404('appointments', b.appointment_id, { conn, label: 'Appointment' });
      for (const i of b.items) await findOr404('medicines', i.medicine_id, { conn, label: 'Medicine' });

      const [r] = await conn.query(
        'INSERT INTO prescriptions (patient_id, doctor_id, appointment_id, notes) VALUES (?, ?, ?, ?)',
        [b.patient_id, doctorId, b.appointment_id ?? null, b.notes ?? null]
      );
      await conn.query(
        'INSERT INTO prescription_items (prescription_id, medicine_id, quantity, dosage, frequency, duration_days, instructions) VALUES ?',
        [b.items.map((i) => [r.insertId, i.medicine_id, i.quantity, i.dosage ?? null, i.frequency ?? null, i.duration_days ?? null, i.instructions ?? null])]
      );
      return r.insertId;
    });
    res.status(201).json(await getPrescription(id));
  })
);

/**
 * Dispense: locks the prescription and every medicine row (in id order to avoid deadlocks),
 * validates stock and expiry for ALL items, then decrements stock atomically.
 */
router.post(
  '/prescriptions/:id/dispense',
  requireRole('pharmacist'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const rx = await findOr404('prescriptions', id, { conn, label: 'Prescription', lock: true });
      if (rx.status !== 'pending') throw HttpError.conflict(`Prescription is already ${rx.status}`);

      const [items] = await conn.query('SELECT * FROM prescription_items WHERE prescription_id = ?', [id]);
      const [meds] = await conn.query(
        'SELECT id, sku, name, stock_qty, expiry_date FROM medicines WHERE id IN (?) ORDER BY id FOR UPDATE',
        [items.map((i) => i.medicine_id)]
      );
      const byId = new Map(meds.map((m) => [m.id, m]));
      const problems = [];
      for (const item of items) {
        const m = byId.get(item.medicine_id);
        if (m.expiry_date < today()) {
          problems.push({ medicine_id: m.id, sku: m.sku, name: m.name, reason: 'expired', expiry_date: m.expiry_date });
        } else if (m.stock_qty < item.quantity) {
          problems.push({ medicine_id: m.id, sku: m.sku, name: m.name, reason: 'insufficient_stock', requested: item.quantity, available: m.stock_qty });
        }
      }
      if (problems.length) throw HttpError.conflict('Cannot dispense prescription', { problems });

      for (const item of items) {
        await conn.query('UPDATE medicines SET stock_qty = stock_qty - ? WHERE id = ?', [item.quantity, item.medicine_id]);
      }
      await conn.query(
        "UPDATE prescriptions SET status = 'dispensed', dispensed_at = NOW(), dispensed_by = ? WHERE id = ?",
        [req.user.id, id]
      );
    });
    res.json(await getPrescription(id));
  })
);

router.post(
  '/prescriptions/:id/cancel',
  requireRole('doctor', 'pharmacist'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const rx = await findOr404('prescriptions', id, { conn, label: 'Prescription', lock: true });
      if (rx.status !== 'pending') throw HttpError.conflict(`Only pending prescriptions can be cancelled; status is ${rx.status}`);
      await conn.query("UPDATE prescriptions SET status = 'cancelled' WHERE id = ?", [id]);
    });
    res.json(await getPrescription(id));
  })
);

export default router;

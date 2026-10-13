import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { findOr404, idParamSchema, money, qbool } from '../lib/common.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

// ---------------------------------------------------------------- test catalog
const testSchema = z
  .object({
    code: z.string().trim().min(2).max(30).toUpperCase(),
    name: z.string().trim().min(2).max(150),
    sample_type: z.string().trim().max(40).nullish(),
    unit: z.string().trim().max(30).nullish(),
    reference_range: z.string().trim().max(60).nullish(),
    critical_low: z.coerce.number().nullish(),
    critical_high: z.coerce.number().nullish(),
    price: money.default(0),
  })
  .refine((t) => t.critical_low == null || t.critical_high == null || t.critical_low < t.critical_high, {
    message: 'critical_low must be less than critical_high',
    path: ['critical_low'],
  });

router.get(
  '/tests',
  asyncHandler(async (req, res) => {
    res.json({ data: await query('SELECT * FROM lab_tests WHERE is_active = 1 ORDER BY name') });
  })
);

router.post(
  '/tests',
  requireRole(),
  validate(testSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const r = await query(
      `INSERT INTO lab_tests (code, name, sample_type, unit, reference_range, critical_low, critical_high, price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.code, b.name, b.sample_type ?? null, b.unit ?? null, b.reference_range ?? null, b.critical_low ?? null, b.critical_high ?? null, b.price]
    );
    res.status(201).json(await findOr404('lab_tests', r.insertId, { label: 'Lab test' }));
  })
);

// ---------------------------------------------------------------- orders
const SORT = { created: 'o.created_at', id: 'o.id', status: 'o.status', priority: "FIELD(o.priority, 'routine', 'urgent', 'stat')" };
const listQuery = listSchema(SORT, {
  status: z.enum(['registered', 'collected', 'resulted', 'cancelled']).optional(),
  priority: z.enum(['routine', 'urgent', 'stat']).optional(),
  patient_id: z.coerce.number().int().positive().optional(),
  critical: qbool.optional(),
});
const createSchema = z.object({
  patient_id: z.coerce.number().int().positive(),
  doctor_id: z.coerce.number().int().positive().nullish(),
  priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
  notes: z.string().trim().max(255).nullish(),
  test_ids: z
    .array(z.coerce.number().int().positive())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate tests in order'),
});
const resultsSchema = z.object({
  results: z
    .array(
      z
        .object({
          lab_test_id: z.coerce.number().int().positive(),
          value: z.coerce.number().nullish(),
          text: z.string().trim().max(255).nullish(),
          is_critical: z.boolean().optional(),
        })
        .refine((r) => r.value != null || r.text, 'Provide a numeric value or a text result')
    )
    .min(1),
});

const SELECT = `o.id, o.*, CONCAT(p.first_name, ' ', p.last_name) AS patient_name, p.mrn, d.name AS doctor_name,
  (SELECT COUNT(*) FROM lab_order_items i WHERE i.lab_order_id = o.id) AS test_count`;
const FROM = 'lab_orders o JOIN patients p ON p.id = o.patient_id LEFT JOIN doctors d ON d.id = o.doctor_id';

async function getOrder(id) {
  const [row] = await query(`SELECT ${SELECT} FROM ${FROM} WHERE o.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Lab order ${id} not found`);
  const items = await query(
    `SELECT i.*, t.code, t.name AS test_name, t.unit, t.reference_range, t.critical_low, t.critical_high
       FROM lab_order_items i JOIN lab_tests t ON t.id = i.lab_test_id
      WHERE i.lab_order_id = ? ORDER BY i.id`,
    [id]
  );
  return { ...row, is_critical: !!row.is_critical, items: items.map((i) => ({ ...i, is_critical: !!i.is_critical })) };
}

router.get(
  '/orders',
  validate(listQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    res.json(
      await paginate({
        select: SELECT,
        from: FROM,
        where: [
          q.status && ['o.status = ?', q.status],
          q.priority && ['o.priority = ?', q.priority],
          q.patient_id && ['o.patient_id = ?', q.patient_id],
          q.critical !== undefined && ['o.is_critical = ?', q.critical ? 1 : 0],
        ],
        searchCols: ['p.first_name', 'p.last_name', 'p.mrn', 'd.name'],
        sortMap: SORT,
        q,
        map: (r) => ({ ...r, is_critical: !!r.is_critical }),
      })
    );
  })
);

router.get(
  '/orders/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => res.json(await getOrder(req.valid.params.id)))
);

router.post(
  '/orders',
  requireRole('doctor'),
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    let doctorId = b.doctor_id ?? null;
    if (req.user.role === 'doctor') {
      const [own] = await query('SELECT id FROM doctors WHERE user_id = ?', [req.user.id]);
      doctorId = own?.id ?? doctorId;
    }
    const id = await withTransaction(async (conn) => {
      await findOr404('patients', b.patient_id, { conn, label: 'Patient' });
      if (doctorId) await findOr404('doctors', doctorId, { conn, label: 'Doctor' });
      const [tests] = await conn.query('SELECT id FROM lab_tests WHERE id IN (?) AND is_active = 1', [b.test_ids]);
      const missing = b.test_ids.filter((t) => !tests.some((x) => x.id === t));
      if (missing.length) throw HttpError.notFound(`Lab test(s) not found: ${missing.join(', ')}`);

      const [r] = await conn.query(
        'INSERT INTO lab_orders (patient_id, doctor_id, priority, notes, created_by) VALUES (?, ?, ?, ?, ?)',
        [b.patient_id, doctorId, b.priority, b.notes ?? null, req.user.id]
      );
      await conn.query('INSERT INTO lab_order_items (lab_order_id, lab_test_id) VALUES ?', [b.test_ids.map((t) => [r.insertId, t])]);
      return r.insertId;
    });
    res.status(201).json(await getOrder(id));
  })
);

/** registered → collected */
router.post(
  '/orders/:id/collect',
  requireRole('labtech'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const order = await findOr404('lab_orders', id, { conn, label: 'Lab order', lock: true });
      if (order.status !== 'registered') {
        throw HttpError.conflict(`Sample can only be collected for registered orders; status is ${order.status}`);
      }
      await conn.query(
        "UPDATE lab_orders SET status = 'collected', collected_at = NOW(), collected_by = ? WHERE id = ?",
        [req.user.id, id]
      );
      await conn.query("UPDATE lab_order_items SET status = 'collected' WHERE lab_order_id = ? AND status = 'registered'", [id]);
    });
    res.json(await getOrder(id));
  })
);

/**
 * collected → resulted. Accepts results for some or all tests; the order becomes 'resulted'
 * once every test has a result. Critical = explicit flag OR value outside the test's critical range.
 */
router.post(
  '/orders/:id/results',
  requireRole('labtech'),
  validate(idParamSchema, 'params'),
  validate(resultsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const order = await findOr404('lab_orders', id, { conn, label: 'Lab order', lock: true });
      if (order.status === 'registered') throw HttpError.conflict('Cannot enter results before the sample is collected');
      if (order.status !== 'collected') throw HttpError.conflict(`Cannot enter results for a ${order.status} order`);

      const [items] = await conn.query(
        `SELECT i.id, i.lab_test_id, i.status, t.critical_low, t.critical_high, t.name
           FROM lab_order_items i JOIN lab_tests t ON t.id = i.lab_test_id
          WHERE i.lab_order_id = ? FOR UPDATE`,
        [id]
      );
      const byTest = new Map(items.map((i) => [i.lab_test_id, i]));
      for (const r of req.valid.body.results) {
        const item = byTest.get(r.lab_test_id);
        if (!item) throw HttpError.badRequest(`Test ${r.lab_test_id} is not part of this order`);
        if (item.status === 'resulted') throw HttpError.conflict(`Result for "${item.name}" already entered`);
        const outOfRange =
          r.value != null &&
          ((item.critical_low != null && r.value < item.critical_low) || (item.critical_high != null && r.value > item.critical_high));
        const critical = r.is_critical ?? outOfRange;
        await conn.query(
          "UPDATE lab_order_items SET status = 'resulted', result_value = ?, result_text = ?, is_critical = ?, resulted_at = NOW() WHERE id = ?",
          [r.value ?? null, r.text ?? null, critical ? 1 : 0, item.id]
        );
      }

      const [[agg]] = await conn.query(
        `SELECT SUM(status <> 'resulted') AS pending, MAX(is_critical) AS critical
           FROM lab_order_items WHERE lab_order_id = ? AND status <> 'cancelled'`,
        [id]
      );
      const done = Number(agg.pending) === 0;
      await conn.query(
        `UPDATE lab_orders SET is_critical = ?, status = ?, resulted_at = ?, resulted_by = ? WHERE id = ?`,
        [Number(agg.critical) ? 1 : 0, done ? 'resulted' : 'collected', done ? new Date() : null, done ? req.user.id : null, id]
      );
    });
    res.json(await getOrder(id));
  })
);

router.post(
  '/orders/:id/cancel',
  requireRole('doctor', 'labtech'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const order = await findOr404('lab_orders', id, { conn, label: 'Lab order', lock: true });
      if (order.status !== 'registered') throw HttpError.conflict(`Only registered orders can be cancelled; status is ${order.status}`);
      await conn.query("UPDATE lab_orders SET status = 'cancelled' WHERE id = ?", [id]);
      await conn.query("UPDATE lab_order_items SET status = 'cancelled' WHERE lab_order_id = ?", [id]);
    });
    res.json(await getOrder(id));
  })
);

export default router;

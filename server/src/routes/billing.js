import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { HttpError } from '../lib/httpError.js';
import { findOr404, idParamSchema, isoDate, money, positiveMoney } from '../lib/common.js';
import { computeTotals, fromCents, recalcBill, toCents } from '../lib/billing.js';
import { listSchema, paginate } from '../lib/list.js';

const router = Router();

const METHODS = ['cash', 'card', 'upi', 'insurance', 'bank_transfer', 'other'];
const SORT = { created: 'bl.created_at', id: 'bl.id', total: 'bl.total', balance: 'bl.balance', status: 'bl.status' };
const listQuery = listSchema(SORT, {
  status: z.enum(['unpaid', 'partial', 'paid', 'cancelled']).optional(),
  patient_id: z.coerce.number().int().positive().optional(),
  admission_id: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const itemSchema = z.object({
  item_type: z.enum(['consultation', 'bed', 'procedure', 'lab', 'pharmacy', 'other']).default('other'),
  description: z.string().trim().min(1).max(255),
  quantity: z.coerce.number().positive().max(10_000).default(1),
  unit_price: money,
});
// Any client-supplied subtotal/tax/total/paid/balance is stripped by zod and recomputed.
const createSchema = z.object({
  patient_id: z.coerce.number().int().positive(),
  admission_id: z.coerce.number().int().positive().nullish(),
  items: z.array(itemSchema).min(1).max(200),
  discount: money.default(0),
  tax_rate: z.coerce.number().min(0).max(100).default(0),
  notes: z.string().trim().max(255).nullish(),
});
const updateSchema = z
  .object({
    discount: money.optional(),
    tax_rate: z.coerce.number().min(0).max(100).optional(),
    notes: z.string().trim().max(255).nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, 'No fields to update');
const paymentSchema = z.object({
  amount: positiveMoney,
  method: z.enum(METHODS).default('cash'),
  reference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(255).nullish(),
});
const refundSchema = z.object({
  amount: positiveMoney,
  method: z.enum(METHODS).default('cash'),
  payment_id: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(255),
});
const itemParams = idParamSchema.extend({ itemId: z.coerce.number().int().positive() });

const SELECT = `bl.id, bl.*, CONCAT(p.first_name, ' ', p.last_name) AS patient_name, p.mrn`;
const FROM = 'bills bl JOIN patients p ON p.id = bl.patient_id';

async function getBill(id) {
  const [row] = await query(`SELECT ${SELECT} FROM ${FROM} WHERE bl.id = ?`, [id]);
  if (!row) throw HttpError.notFound(`Bill ${id} not found`);
  const [items, payments] = await Promise.all([
    query('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id', [id]),
    query(
      `SELECT pm.*, u.name AS created_by_name FROM payments pm LEFT JOIN users u ON u.id = pm.created_by
        WHERE pm.bill_id = ? ORDER BY pm.id`,
      [id]
    ),
  ]);
  return { ...row, items, payments };
}

/** Locks the bill row and rejects changes to cancelled bills. */
async function lockBill(conn, id) {
  const bill = await findOr404('bills', id, { conn, label: 'Bill', lock: true });
  if (bill.status === 'cancelled') throw HttpError.conflict('Bill is cancelled');
  return bill;
}

const insertItems = (conn, billId, lines) =>
  conn.query(
    'INSERT INTO bill_items (bill_id, item_type, description, quantity, unit_price, amount) VALUES ?',
    [lines.map((l) => [billId, l.item_type, l.description, l.quantity, l.unit_price, l.amount])]
  );

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
          q.status && ['bl.status = ?', q.status],
          q.patient_id && ['bl.patient_id = ?', q.patient_id],
          q.admission_id && ['bl.admission_id = ?', q.admission_id],
          q.from && ['bl.created_at >= ?', q.from],
          q.to && ['bl.created_at < DATE_ADD(?, INTERVAL 1 DAY)', q.to],
        ],
        searchCols: ['bl.bill_number', 'p.first_name', 'p.last_name', 'p.mrn', 'p.phone'],
        sortMap: SORT,
        q,
      })
    );
  })
);

router.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => res.json(await getBill(req.valid.params.id)))
);

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const t = computeTotals(b.items, { discount: b.discount, taxRate: b.tax_rate });
    if (toCents(b.discount) > toCents(t.subtotal)) {
      throw HttpError.badRequest('Discount cannot exceed subtotal', { subtotal: t.subtotal, discount: b.discount });
    }
    const id = await withTransaction(async (conn) => {
      await findOr404('patients', b.patient_id, { conn, label: 'Patient' });
      if (b.admission_id) {
        const adm = await findOr404('admissions', b.admission_id, { conn, label: 'Admission' });
        if (adm.patient_id !== b.patient_id) throw HttpError.badRequest('Admission does not belong to this patient');
      }
      const [r] = await conn.query(
        `INSERT INTO bills (bill_number, patient_id, admission_id, discount, tax_rate, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`TMP-${crypto.randomUUID().slice(0, 20)}`, b.patient_id, b.admission_id ?? null, b.discount, b.tax_rate, b.notes ?? null, req.user.id]
      );
      const billId = r.insertId;
      await conn.query('UPDATE bills SET bill_number = ? WHERE id = ?', [
        `INV-${new Date().getUTCFullYear()}-${String(billId).padStart(6, '0')}`, billId,
      ]);
      await insertItems(conn, billId, t.lines);
      await recalcBill(conn, billId);
      return billId;
    });
    res.status(201).json(await getBill(id));
  })
);

router.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    await withTransaction(async (conn) => {
      const bill = await lockBill(conn, id);
      await conn.query('UPDATE bills SET discount = ?, tax_rate = ?, notes = ? WHERE id = ?', [
        b.discount ?? bill.discount, b.tax_rate ?? bill.tax_rate, b.notes === undefined ? bill.notes : b.notes, id,
      ]);
      await assertTotalsValid(conn, id);
    });
    res.json(await getBill(id));
  })
);

/** Recalculates and rolls back if the new total is below what's already been paid or discount > subtotal. */
async function assertTotalsValid(conn, id) {
  const [[{ discount }]] = await conn.query('SELECT discount FROM bills WHERE id = ?', [id]);
  const t = await recalcBill(conn, id);
  if (toCents(discount) > toCents(t.subtotal)) {
    throw HttpError.badRequest('Discount cannot exceed subtotal', { subtotal: t.subtotal, discount });
  }
  if (t.balance < 0) {
    throw HttpError.conflict('Change would make the bill total less than the amount already paid; refund first', {
      total: t.total,
      paid: t.paid,
    });
  }
}

router.post(
  '/:id/items',
  validate(idParamSchema, 'params'),
  validate(z.object({ items: z.array(itemSchema).min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      await lockBill(conn, id);
      await insertItems(conn, id, computeTotals(req.valid.body.items).lines);
      await assertTotalsValid(conn, id);
    });
    res.status(201).json(await getBill(id));
  })
);

router.delete(
  '/:id/items/:itemId',
  validate(itemParams, 'params'),
  asyncHandler(async (req, res) => {
    const { id, itemId } = req.valid.params;
    await withTransaction(async (conn) => {
      await lockBill(conn, id);
      const [r] = await conn.query('DELETE FROM bill_items WHERE id = ? AND bill_id = ?', [itemId, id]);
      if (!r.affectedRows) throw HttpError.notFound(`Bill item ${itemId} not found on bill ${id}`);
      const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM bill_items WHERE bill_id = ?', [id]);
      if (!n) throw HttpError.conflict('A bill must keep at least one item; cancel the bill instead');
      await assertTotalsValid(conn, id);
    });
    res.json(await getBill(id));
  })
);

router.post(
  '/:id/payments',
  validate(idParamSchema, 'params'),
  validate(paymentSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    await withTransaction(async (conn) => {
      const bill = await lockBill(conn, id);
      const balanceC = toCents(bill.balance);
      if (balanceC <= 0) throw HttpError.conflict('Bill is already fully paid');
      if (toCents(b.amount) > balanceC) {
        throw HttpError.badRequest('Payment amount exceeds outstanding balance', { balance: fromCents(balanceC), amount: b.amount });
      }
      await conn.query(
        "INSERT INTO payments (bill_id, kind, amount, method, reference, notes, created_by) VALUES (?, 'payment', ?, ?, ?, ?, ?)",
        [id, b.amount, b.method, b.reference ?? null, b.notes ?? null, req.user.id]
      );
      await recalcBill(conn, id);
    });
    res.status(201).json(await getBill(id));
  })
);

router.post(
  '/:id/refunds',
  requireRole('accountant'),
  validate(idParamSchema, 'params'),
  validate(refundSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    await withTransaction(async (conn) => {
      const bill = await findOr404('bills', id, { conn, label: 'Bill', lock: true });
      const amountC = toCents(b.amount);
      if (amountC > toCents(bill.paid)) {
        throw HttpError.badRequest('Refund exceeds net amount paid', { paid: bill.paid, amount: b.amount });
      }
      if (b.payment_id) {
        const [[orig]] = await conn.query(
          "SELECT id, amount FROM payments WHERE id = ? AND bill_id = ? AND kind = 'payment'",
          [b.payment_id, id]
        );
        if (!orig) throw HttpError.notFound(`Payment ${b.payment_id} not found on bill ${id}`);
        const [[{ refunded }]] = await conn.query(
          'SELECT COALESCE(-SUM(amount), 0) AS refunded FROM payments WHERE refund_of = ?',
          [orig.id]
        );
        if (amountC > toCents(orig.amount) - toCents(refunded)) {
          throw HttpError.badRequest('Refund exceeds the refundable amount of that payment', {
            paymentAmount: orig.amount,
            alreadyRefunded: refunded,
          });
        }
      }
      await conn.query(
        "INSERT INTO payments (bill_id, kind, amount, method, refund_of, notes, created_by) VALUES (?, 'refund', ?, ?, ?, ?, ?)",
        [id, -b.amount, b.method, b.payment_id ?? null, b.reason, req.user.id]
      );
      await recalcBill(conn, id);
    });
    res.status(201).json(await getBill(id));
  })
);

router.post(
  '/:id/cancel',
  requireRole('accountant'),
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    await withTransaction(async (conn) => {
      const bill = await lockBill(conn, id);
      if (toCents(bill.paid) !== 0) throw HttpError.conflict('Refund all payments before cancelling the bill', { paid: bill.paid });
      await conn.query("UPDATE bills SET status = 'cancelled', balance = 0 WHERE id = ?", [id]);
    });
    res.json(await getBill(id));
  })
);

export default router;

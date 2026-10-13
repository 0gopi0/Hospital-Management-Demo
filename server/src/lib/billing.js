/** All bill arithmetic is done in integer cents to avoid float drift. */
export const toCents = (n) => Math.round(Number(n) * 100);
export const fromCents = (c) => c / 100;

/** Computes subtotal/discount/tax/total for a set of items — never trust client totals. */
export function computeTotals(items, { discount = 0, taxRate = 0 } = {}) {
  const lines = items.map((i) => ({ ...i, amountCents: Math.round(i.quantity * toCents(i.unit_price)) }));
  const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const disc = Math.min(toCents(discount), subtotal);
  const tax = Math.round(((subtotal - disc) * Number(taxRate)) / 100);
  return {
    lines: lines.map(({ amountCents, ...l }) => ({ ...l, amount: fromCents(amountCents) })),
    subtotal: fromCents(subtotal),
    discount: fromCents(disc),
    tax: fromCents(tax),
    total: fromCents(subtotal - disc + tax),
  };
}

export function billStatus(totalCents, paidCents, current) {
  if (current === 'cancelled') return 'cancelled';
  if (paidCents <= 0) return 'unpaid';
  return paidCents >= totalCents ? 'paid' : 'partial';
}

/**
 * Recomputes a bill's subtotal/tax/total from its items and paid/balance/status from its
 * payments. Must be called inside a transaction holding the bill row lock.
 */
export async function recalcBill(conn, billId) {
  const [[bill]] = await conn.query('SELECT * FROM bills WHERE id = ?', [billId]);
  const [items] = await conn.query('SELECT quantity, unit_price FROM bill_items WHERE bill_id = ?', [billId]);
  const [[{ paid }]] = await conn.query(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE bill_id = ?',
    [billId]
  );
  const t = computeTotals(items, { discount: bill.discount, taxRate: bill.tax_rate });
  const totalC = toCents(t.total);
  const paidC = toCents(paid);
  const status = billStatus(totalC, paidC, bill.status);
  await conn.query(
    `UPDATE bills SET subtotal = ?, discount = ?, tax = ?, total = ?, paid = ?, balance = ?, status = ?
      WHERE id = ?`,
    [t.subtotal, t.discount, t.tax, t.total, fromCents(paidC), fromCents(totalC - paidC), status, billId]
  );
  return { ...t, paid: fromCents(paidC), balance: fromCents(totalC - paidC), status };
}

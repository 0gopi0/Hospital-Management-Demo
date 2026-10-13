import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dt, money } from '../api.js';
import { clean, ErrorBox, Pager, PatientSelect, Status, useAction, useForm, useLoad } from '../ui.jsx';

const ITEM_TYPES = ['consultation', 'bed', 'procedure', 'lab', 'pharmacy', 'other'];
const METHODS = ['cash', 'card', 'upi', 'insurance', 'bank_transfer', 'other'];

function BillDetail({ id }) {
  const bill = useLoad(() => api.get(`/billing/${id}`), [id]);
  const pay = useAction();
  const refund = useAction();
  const [payForm, payBind, , resetPay] = useForm({ amount: '', method: 'upi', reference: '' });
  const [refundForm, refundBind, , resetRefund] = useForm({ amount: '', method: 'cash', reason: '' });

  const doPay = async (e) => {
    e.preventDefault();
    try {
      await pay.run(() => api.post(`/billing/${id}/payments`, clean({ ...payForm, amount: Number(payForm.amount) })));
      resetPay();
      bill.reload();
    } catch { /* 400 overpay */ }
  };
  const doRefund = async (e) => {
    e.preventDefault();
    if (!window.confirm('Record refund?')) return;
    try {
      await refund.run(() => api.post(`/billing/${id}/refunds`, clean({ ...refundForm, amount: Number(refundForm.amount) })));
      resetRefund();
      bill.reload();
    } catch { /* 400 exceeds paid */ }
  };

  if (bill.error) return <ErrorBox error={bill.error} />;
  if (!bill.data) return <p>Loading bill…</p>;
  const b = bill.data;

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>{b.bill_number} · <Status value={b.status} /></h2>
        <span className="muted small">{dt(b.created_at)} · {b.patient_name} ({b.mrn})</span>
      </div>
      <table className="compact">
        <thead><tr><th>Item</th><th>Type</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead>
        <tbody>
          {b.items.map((i) => (
            <tr key={i.id}><td>{i.description}</td><td>{i.item_type}</td><td>{i.quantity}</td><td>{money(i.unit_price)}</td><td>{money(i.amount)}</td></tr>
          ))}
        </tbody>
      </table>
      <p>
        Subtotal {money(b.subtotal)} · Discount {money(b.discount)} · Tax {money(b.tax_amount)} ({b.tax_rate}%) ·{' '}
        <strong>Total {money(b.total)}</strong> · Paid {money(b.paid)} · <strong>Balance {money(b.balance)}</strong>
      </p>
      <h3>Payments</h3>
      <table className="compact">
        <thead><tr><th>#</th><th>Kind</th><th>Amount</th><th>Method</th><th>By</th><th>When</th></tr></thead>
        <tbody>
          {b.payments.length === 0 && <tr><td colSpan={6} className="muted">No payments yet.</td></tr>}
          {b.payments.map((p) => (
            <tr key={p.id}><td>{p.id}</td><td>{p.kind}</td><td>{money(p.amount)}</td><td>{p.method}</td><td>{p.created_by_name ?? '—'}</td><td>{dt(p.created_at)}</td></tr>
          ))}
        </tbody>
      </table>

      {b.status !== 'paid' && b.status !== 'cancelled' && (
        <form className="row" onSubmit={doPay}>
          <strong>Pay</strong>
          <input style={{ maxWidth: 140 }} placeholder="amount" inputMode="decimal" {...payBind('amount')} required />
          <select style={{ maxWidth: 150 }} {...payBind('method')}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
          <input style={{ maxWidth: 180 }} placeholder="reference (optional)" {...payBind('reference')} />
          <button className="primary" disabled={pay.busy}>Record payment</button>
          <ErrorBox error={pay.error} />
        </form>
      )}
      <form className="row" onSubmit={doRefund} style={{ marginTop: 8 }}>
        <strong>Refund</strong>
        <input style={{ maxWidth: 140 }} placeholder="amount" inputMode="decimal" {...refundBind('amount')} required />
        <select style={{ maxWidth: 150 }} {...refundBind('method')}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select>
        <input style={{ maxWidth: 220 }} placeholder="reason (min 3 chars)" {...refundBind('reason')} required />
        <button className="danger" disabled={refund.busy}>Record refund</button>
        <ErrorBox error={refund.error} />
      </form>
    </div>
  );
}

export default function Billing() {
  const { id } = useParams();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get('/billing', { page, limit: 15, status: status || undefined }), [page, status]);

  const [form, bind, setForm, resetForm] = useForm({ patient_id: '', discount: '0', tax_rate: '5', item_desc: '', item_qty: '1', item_price: '', item_type: 'consultation' });
  const [extraItems, setExtraItems] = useState([]);
  const act = useAction();
  const [showForm, setShowForm] = useState(false);

  const addItem = () => {
    if (!form.item_desc || !form.item_price) return;
    setExtraItems((xs) => [...xs, {
      item_type: form.item_type, description: form.item_desc,
      quantity: Number(form.item_qty) || 1, unit_price: Number(form.item_price),
    }]);
    setForm((f) => ({ ...f, item_desc: '', item_qty: '1', item_price: '' }));
  };

  const create = async (e) => {
    e.preventDefault();
    if (!extraItems.length) return;
    try {
      await act.run(() => api.post('/billing', {
        patient_id: Number(form.patient_id),
        discount: Number(form.discount) || 0,
        tax_rate: Number(form.tax_rate) || 0,
        items: extraItems,
      }));
      resetForm();
      setExtraItems([]);
      setShowForm(false);
      setPage(1);
      list.reload();
    } catch { /* 400 discount > subtotal */ }
  };

  return (
    <>
      <div className="row between">
        <h1>Billing</h1>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ New bill'}</button>
      </div>

      {id && <BillDetail id={id} />}

      {showForm && (
        <form className="card form-grid" onSubmit={create}>
          <label>Patient*<PatientSelect value={form.patient_id} onChange={(v) => setForm((f) => ({ ...f, patient_id: v }))} /></label>
          <label>Discount<input inputMode="decimal" {...bind('discount')} /></label>
          <label>Tax %<input inputMode="decimal" {...bind('tax_rate')} /></label>
          <div className="full card" style={{ margin: 0 }}>
            <strong>Items (totals computed server-side)</strong>
            <div className="row" style={{ marginTop: 6 }}>
              <select style={{ maxWidth: 150 }} {...bind('item_type')}>{ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              <input style={{ flex: 2 }} placeholder="description" {...bind('item_desc')} />
              <input style={{ maxWidth: 90 }} placeholder="qty" inputMode="numeric" {...bind('item_qty')} />
              <input style={{ maxWidth: 140 }} placeholder="unit price" inputMode="decimal" {...bind('item_price')} />
              <button type="button" onClick={addItem}>Add</button>
            </div>
            {extraItems.map((i, k) => (
              <div key={k} className="row small" style={{ marginTop: 4 }}>
                <span>{i.item_type} · {i.description} · {i.quantity} × {money(i.unit_price)}</span>
                <button type="button" className="link" onClick={() => setExtraItems((xs) => xs.filter((_, j) => j !== k))}>remove</button>
              </div>
            ))}
          </div>
          <div className="full">
            <ErrorBox error={act.error} />
            <button className="primary" disabled={act.busy || !extraItems.length || !form.patient_id}>Create bill</button>
          </div>
        </form>
      )}

      <div className="row">
        <label style={{ minWidth: 200 }}>Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option>unpaid</option><option>partial</option><option>paid</option><option>cancelled</option>
          </select>
        </label>
        <button onClick={list.reload}>Refresh</button>
      </div>

      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>Bill #</th><th>Patient</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={7} className="muted">No bills.</td></tr>}
          {list.data?.data.map((b) => (
            <tr key={b.id}>
              <td><Link to={`/billing/${b.id}`}>{b.bill_number}</Link></td>
              <td>{b.patient_name}<br /><span className="muted small">{b.mrn}</span></td>
              <td>{money(b.total)}</td><td>{money(b.paid)}</td><td>{money(b.balance)}</td>
              <td><Status value={b.status} /></td>
              <td>{dt(b.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pagination={list.data?.pagination} onPage={setPage} />
    </>
  );
}

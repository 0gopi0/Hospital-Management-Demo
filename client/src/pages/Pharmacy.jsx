import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, d } from '../api.js';
import { Badge, DoctorSelect, ErrorBox, Pager, PatientSelect, Status, useAction, useForm, useLoad } from '../ui.jsx';

function MedicineStock() {
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('all');
  const list = useLoad(() => api.get('/pharmacy/medicines', {
    page, limit: 20,
    low_stock: filter === 'low' ? 'true' : undefined,
    expired: filter === 'expired' ? 'true' : undefined,
  }), [page, filter]);

  return (
    <>
      <div className="tabs">
        {[['all', 'All'], ['low', 'Low stock'], ['expired', 'Expired']].map(([v, label]) => (
          <button key={v} className={filter === v ? 'active' : ''} onClick={() => { setFilter(v); setPage(1); }}>{label}</button>
        ))}
        <button onClick={list.reload}>Refresh</button>
      </div>
      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>SKU</th><th>Name</th><th>Stock</th><th>Expiry</th><th>Flags</th><th>Price</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={6} className="muted">No medicines.</td></tr>}
          {list.data?.data.map((m) => (
            <tr key={m.id}>
              <td>{m.sku}</td>
              <td>{m.name}<br /><span className="muted small">{m.generic_name} · {m.strength} · batch {m.batch_no ?? '—'}</span></td>
              <td>{m.stock_qty} <span className="muted">(reorder ≤ {m.reorder_level})</span></td>
              <td>{d(m.expiry_date)}</td>
              <td>
                {m.is_low_stock && <span><Badge kind="orange">low stock</Badge> </span>}
                {m.is_expired && <Badge kind="red">expired</Badge>}
                {!m.is_low_stock && !m.is_expired && <span className="muted">ok</span>}
              </td>
              <td>{m.unit_price}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pagination={list.data?.pagination} onPage={setPage} />
    </>
  );
}

function Prescriptions() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('pending');
  const list = useLoad(() => api.get('/pharmacy/prescriptions', { page, limit: 10, status: status || undefined }), [page, status]);
  const act = useAction();

  const [form, bind, setForm, resetForm] = useForm({ patient_id: '', doctor_id: '', med_id: '', qty: '10', dosage: '', notes: '' });
  const [lines, setLines] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState(null);

  const addLine = () => {
    if (!form.med_id || !form.qty) return;
    if (lines.some((l) => l.medicine_id === Number(form.med_id))) return;
    setLines((xs) => [...xs, {
      medicine_id: Number(form.med_id), quantity: Number(form.qty),
      dosage: form.dosage || undefined, instructions: undefined,
    }]);
    setForm((f) => ({ ...f, med_id: '', qty: '10', dosage: '' }));
  };

  const create = async (e) => {
    e.preventDefault();
    if (!lines.length) return;
    try {
      const rx = await act.run(() => api.post('/pharmacy/prescriptions', {
        patient_id: Number(form.patient_id),
        doctor_id: form.doctor_id ? Number(form.doctor_id) : undefined,
        notes: form.notes || undefined,
        items: lines,
      }));
      resetForm();
      setLines([]);
      setShowForm(false);
      setDetail(rx);
      list.reload();
    } catch { /* 400/403 */ }
  };

  const view = async (id) => {
    try {
      setDetail(await act.run(() => api.get(`/pharmacy/prescriptions/${id}`)));
    } catch { /* shown */ }
  };

  const dispense = async (id) => {
    if (!window.confirm('Dispense this prescription? Stock will be decremented.')) return;
    try {
      setDetail(await act.run(() => api.post(`/pharmacy/prescriptions/${id}/dispense`)));
      list.reload();
    } catch { /* 409 expired/insufficient */ }
  };

  return (
    <>
      <div className="row between">
        <h2 style={{ margin: 0 }}>Prescriptions</h2>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ New prescription'}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={create}>
          <label>Patient*<PatientSelect value={form.patient_id} onChange={(v) => setForm((f) => ({ ...f, patient_id: v }))} /></label>
          <label>Doctor<DoctorSelect value={form.doctor_id} onChange={(v) => setForm((f) => ({ ...f, doctor_id: v }))} required={false} /></label>
          <label>Notes<input {...bind('notes')} /></label>
          <div className="full card" style={{ margin: 0 }}>
            <strong>Medicines</strong>
            <div className="row" style={{ marginTop: 6 }}>
              <input style={{ maxWidth: 120 }} placeholder="medicine id" inputMode="numeric" {...bind('med_id')} />
              <input style={{ maxWidth: 90 }} placeholder="qty" inputMode="numeric" {...bind('qty')} />
              <input style={{ flex: 1 }} placeholder="dosage e.g. 500mg twice daily" {...bind('dosage')} />
              <button type="button" onClick={addLine}>Add</button>
            </div>
            <div className="small muted">Find ids in the stock table above.</div>
            {lines.map((l, k) => (
              <div key={k} className="row small" style={{ marginTop: 4 }}>
                <span>med #{l.medicine_id} × {l.quantity} {l.dosage ? `(${l.dosage})` : ''}</span>
                <button type="button" className="link" onClick={() => setLines((xs) => xs.filter((_, j) => j !== k))}>remove</button>
              </div>
            ))}
          </div>
          <div className="full">
            <ErrorBox error={act.error} />
            <button className="primary" disabled={act.busy || !lines.length || !form.patient_id}>Create prescription</button>
          </div>
        </form>
      )}

      <div className="row">
        <label style={{ minWidth: 200 }}>Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="dispensed">Dispensed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>

      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>#</th><th>Patient</th><th>Doctor</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={5} className="muted">No prescriptions.</td></tr>}
          {list.data?.data.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td><td>{r.patient_name}<br /><span className="muted small">{r.mrn}</span></td>
              <td>{r.doctor_name ?? '—'}</td><td><Status value={r.status} /></td>
              <td>
                <span className="actions">
                  <button onClick={() => view(r.id)}>View</button>
                  {r.status === 'pending' && <button className="primary" onClick={() => dispense(r.id)}>Dispense</button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pagination={list.data?.pagination} onPage={setPage} />

      {act.error?.status === 409 && act.error?.details?.problems && (
        <div className="alert error">
          <strong>409 — Cannot dispense.</strong>
          <ul>
            {act.error.details.problems.map((p, i) => (
              <li key={i}>{p.name}: {p.reason === 'expired' ? `expired ${p.expiry_date}` : `needs ${p.requested}, only ${p.available} in stock`}</li>
            ))}
          </ul>
        </div>
      )}

      {detail && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Prescription #{detail.id} · <Status value={detail.status} /></h3>
          <table className="compact">
            <thead><tr><th>Medicine</th><th>Qty</th><th>Dosage</th><th>Stock</th><th>Expiry</th></tr></thead>
            <tbody>
              {detail.items.map((i) => (
                <tr key={i.id}><td>{i.medicine_name} ({i.sku})</td><td>{i.quantity}</td><td>{i.dosage ?? '—'}</td><td>{i.stock_qty}</td><td>{d(i.expiry_date)}</td></tr>
              ))}
            </tbody>
          </table>
          <button onClick={() => setDetail(null)}>Close</button>
        </div>
      )}
    </>
  );
}

export default function Pharmacy() {
  return (
    <>
      <h1>Pharmacy</h1>
      <p className="muted">Demo seed: Amoxicillin is low-stock, ExpiredDrug is expired — dispensing either is blocked with a 409. <Link to="/lab">Lab →</Link></p>
      <h2>Stock</h2>
      <MedicineStock />
      <Prescriptions />
    </>
  );
}

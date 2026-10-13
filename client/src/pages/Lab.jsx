import { useState } from 'react';
import { api, dt } from '../api.js';
import { Badge, clean, DoctorSelect, ErrorBox, Pager, PatientSelect, Status, useAction, useForm, useLoad } from '../ui.jsx';

function ResultForm({ order, onDone }) {
  const [values, setValues] = useState({});
  const act = useAction();
  const set = (testId, patch) => setValues((v) => ({ ...v, [testId]: { ...(v[testId] ?? {}), ...patch } }));

  const submit = async (e) => {
    e.preventDefault();
    const results = order.items
      .filter((i) => i.status !== 'resulted')
      .map((i) => ({
        lab_test_id: i.lab_test_id,
        value: values[i.lab_test_id]?.value ? Number(values[i.lab_test_id].value) : undefined,
        text: values[i.lab_test_id]?.text || undefined,
        is_critical: values[i.lab_test_id]?.critical || undefined,
      }))
      .filter((r) => r.value != null || r.text);
    if (!results.length) return;
    try {
      await act.run(() => api.post(`/lab/orders/${order.id}/results`, { results }));
      onDone();
    } catch { /* 409 wrong status */ }
  };

  const pending = order.items.filter((i) => i.status !== 'resulted');
  if (!pending.length) return <p className="muted">All results entered.</p>;

  return (
    <form className="card" onSubmit={submit}>
      <strong>Enter results</strong>
      {pending.map((i) => (
        <div key={i.id} className="row" style={{ marginTop: 6 }}>
          <span style={{ minWidth: 180 }}>{i.test_name} <span className="muted small">({i.status})</span></span>
          <input style={{ maxWidth: 120 }} placeholder="numeric" inputMode="decimal"
            value={values[i.lab_test_id]?.value ?? ''} onChange={(e) => set(i.lab_test_id, { value: e.target.value })} />
          <input style={{ flex: 1 }} placeholder="or text result"
            value={values[i.lab_test_id]?.text ?? ''} onChange={(e) => set(i.lab_test_id, { text: e.target.value })} />
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 'auto' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!values[i.lab_test_id]?.critical}
              onChange={(e) => set(i.lab_test_id, { critical: e.target.checked || undefined })} /> critical
          </label>
        </div>
      ))}
      <div className="small muted" style={{ marginTop: 4 }}>
        Critical is auto-detected when a value falls outside the test's critical range — no flag needed.
      </div>
      <ErrorBox error={act.error} />
      <button className="primary" disabled={act.busy} style={{ marginTop: 6 }}>Save results</button>
    </form>
  );
}

export default function Lab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const list = useLoad(() => api.get('/lab/orders', { page, limit: 10, status: status || undefined }), [page, status]);
  const tests = useLoad(() => api.get('/lab/tests'), []);
  const act = useAction();

  const [form, bind, setForm, resetForm] = useForm({ patient_id: '', doctor_id: '', priority: 'routine', notes: '' });
  const [picked, setPicked] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [detail, setDetail] = useState(null);

  const create = async (e) => {
    e.preventDefault();
    if (!picked.length) return;
    try {
      const o = await act.run(() => api.post('/lab/orders', clean({
        patient_id: Number(form.patient_id),
        doctor_id: form.doctor_id ? Number(form.doctor_id) : undefined,
        priority: form.priority, notes: form.notes || undefined, test_ids: picked,
      })));
      resetForm();
      setPicked([]);
      setShowForm(false);
      setDetail(o);
      list.reload();
    } catch { /* shown */ }
  };

  const view = async (id) => {
    try {
      setDetail(await act.run(() => api.get(`/lab/orders/${id}`)));
    } catch { /* shown */ }
  };

  const collect = async (id) => {
    try {
      setDetail(await act.run(() => api.post(`/lab/orders/${id}/collect`)));
      list.reload();
    } catch { /* 409 already collected */ }
  };

  return (
    <>
      <div className="row between">
        <h1>Lab</h1>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ New order'}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={create}>
          <label>Patient*<PatientSelect value={form.patient_id} onChange={(v) => setForm((f) => ({ ...f, patient_id: v }))} /></label>
          <label>Doctor<DoctorSelect value={form.doctor_id} onChange={(v) => setForm((f) => ({ ...f, doctor_id: v }))} required={false} /></label>
          <label>Priority
            <select {...bind('priority')}><option>routine</option><option>urgent</option><option>stat</option></select>
          </label>
          <label>Notes<input {...bind('notes')} /></label>
          <div className="full">
            <strong>Tests</strong>
            <div className="row" style={{ marginTop: 4 }}>
              {(tests.data?.data ?? []).map((t) => (
                <label key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, width: 'auto' }}>
                  <input type="checkbox" style={{ width: 'auto' }}
                    checked={picked.includes(t.id)}
                    onChange={(e) => setPicked((p) => e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id))} />
                  {t.name} ({t.code})
                </label>
              ))}
            </div>
          </div>
          <div className="full">
            <ErrorBox error={act.error} />
            <button className="primary" disabled={act.busy || !picked.length || !form.patient_id}>Create order</button>
          </div>
        </form>
      )}

      <div className="row">
        <label style={{ minWidth: 200 }}>Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option>registered</option><option>collected</option><option>resulted</option><option>cancelled</option>
          </select>
        </label>
        <button onClick={list.reload}>Refresh</button>
      </div>

      <ErrorBox error={act.error?.status === 409 && detail ? null : act.error} />
      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>#</th><th>Patient</th><th>Tests</th><th>Priority</th><th>Status</th><th>Critical</th><th>Actions</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={7} className="muted">No lab orders.</td></tr>}
          {list.data?.data.map((o) => (
            <tr key={o.id}>
              <td>{o.id}</td>
              <td>{o.patient_name}<br /><span className="muted small">{o.mrn}</span></td>
              <td>{o.test_count}</td>
              <td>{o.priority}</td>
              <td><Status value={o.status} /></td>
              <td>{o.is_critical ? <Badge kind="red">critical</Badge> : <span className="muted">—</span>}</td>
              <td>
                <span className="actions">
                  <button onClick={() => view(o.id)}>View</button>
                  {o.status === 'registered' && <button onClick={() => collect(o.id)}>Collect sample</button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pagination={list.data?.pagination} onPage={setPage} />

      {detail && (
        <div className="card">
          <div className="row between">
            <h3 style={{ margin: 0 }}>Order #{detail.id} · <Status value={detail.status} /> {detail.is_critical && <Badge kind="red">critical</Badge>}</h3>
            <button onClick={() => setDetail(null)}>Close</button>
          </div>
          <table className="compact">
            <thead><tr><th>Test</th><th>Status</th><th>Value</th><th>Text</th><th>Range</th><th>Critical</th></tr></thead>
            <tbody>
              {detail.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.test_name} ({i.code})</td><td><Status value={i.status} /></td>
                  <td>{i.result_value ?? '—'}</td><td>{i.result_text ?? '—'}</td>
                  <td className="small muted">{i.reference_range ?? '—'}</td>
                  <td>{i.is_critical ? <Badge kind="red">critical</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="small muted">Registered {dt(detail.created_at)}{detail.collected_at ? ` · collected ${dt(detail.collected_at)}` : ''}{detail.resulted_at ? ` · resulted ${dt(detail.resulted_at)}` : ''}</div>
          {(detail.status === 'collected') && <ResultForm order={detail} onDone={() => { view(detail.id); list.reload(); }} />}
          {detail.status === 'registered' && <p className="muted small">Collect the sample before entering results (entering results first returns 409).</p>}
        </div>
      )}
    </>
  );
}

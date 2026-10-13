import { useState } from 'react';
import { api, dt } from '../api.js';
import { clean, DoctorSelect, ErrorBox, Pager, PatientSelect, Status, useAction, useForm, useLoad } from '../ui.jsx';

export default function Admissions() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('admitted');
  const list = useLoad(
    () => api.get('/admissions', { page, limit: 15, status: status || undefined, sort: 'admitted', order: 'desc' }),
    [page, status]
  );
  const wards = useLoad(() => api.get('/beds/wards'), []);

  const [wardId, setWardId] = useState('');
  const beds = useLoad(
    () => api.get('/beds', { ward_id: wardId || undefined, limit: 100, sort: 'id', order: 'asc' }),
    [wardId]
  );

  const [form, bind, setForm, resetForm] = useForm({ patient_id: '', bed_id: '', doctor_id: '', reason: '' });
  const act = useAction();
  const [showForm, setShowForm] = useState(false);

  const admit = async (e) => {
    e.preventDefault();
    try {
      await act.run(() =>
        api.post('/admissions', clean({
          patient_id: Number(form.patient_id),
          bed_id: Number(form.bed_id),
          doctor_id: form.doctor_id ? Number(form.doctor_id) : undefined,
          reason: form.reason || undefined,
        }))
      );
      resetForm();
      setShowForm(false);
      setPage(1);
      list.reload();
      beds.reload();
    } catch { /* 409 occupied / already admitted */ }
  };

  const discharge = async (id, force = false) => {
    const msg = force ? 'Force-discharge with unpaid bills?' : 'Discharge patient?';
    if (!window.confirm(msg)) return;
    try {
      await act.run(() => api.post(`/admissions/${id}/discharge`, {}, force ? { force: 'true' } : undefined));
      list.reload();
      beds.reload();
    } catch { /* 402 unpaid -> shown with force option */ }
  };

  return (
    <>
      <div className="row between">
        <h1>Admissions &amp; Beds</h1>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ Admit patient'}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={admit}>
          <label>Patient*<PatientSelect value={form.patient_id} onChange={(v) => setForm((f) => ({ ...f, patient_id: v }))} /></label>
          <label>Bed #*<input {...bind('bed_id')} placeholder="bed id (see grid below)" required inputMode="numeric" /></label>
          <label>Doctor<DoctorSelect value={form.doctor_id} onChange={(v) => setForm((f) => ({ ...f, doctor_id: v }))} required={false} /></label>
          <label>Reason<input {...bind('reason')} placeholder="Chest pain, fracture…" /></label>
          <div className="full">
            <ErrorBox error={act.error} />
            <button className="primary" disabled={act.busy}>Admit</button>
          </div>
        </form>
      )}

      <h2>Bed map</h2>
      <div className="row">
        <label style={{ minWidth: 220 }}>Ward
          <select value={wardId} onChange={(e) => setWardId(e.target.value)}>
            <option value="">All wards</option>
            {wards.data?.data.map((w) => (
              <option key={w.id} value={w.id}>{w.name} ({w.available}/{w.total_beds} free)</option>
            ))}
          </select>
        </label>
        <button onClick={beds.reload}>Refresh</button>
      </div>
      <ErrorBox error={beds.error} />
      <div className="bedgrid">
        {beds.data?.data.map((b) => (
          <div key={b.id} className={`bed ${b.status}`} title={b.patient_name ? `Patient: ${b.patient_name}` : b.status}>
            <strong>#{b.id} {b.bed_number}</strong>
            <div>{b.ward_name}</div>
            <div><Status value={b.status} /></div>
            {b.patient_name && <div className="small">{b.patient_name}</div>}
          </div>
        ))}
      </div>

      <h2>Admissions</h2>
      <div className="row">
        <label style={{ minWidth: 200 }}>Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="admitted">Admitted</option>
            <option value="discharged">Discharged</option>
          </select>
        </label>
        {!showForm && <ErrorBox error={act.error} />}
      </div>
      {act.error?.status === 402 && (
        <div className="alert warn">
          <strong>402 — Unpaid bills block discharge.</strong>{' '}
          Balance {act.error.details?.balance ?? ''}. Settle the bill in Billing, or force-discharge anyway.
        </div>
      )}

      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>#</th><th>Patient</th><th>Bed</th><th>Doctor</th><th>Admitted</th><th>Status</th><th>Bills</th><th>Actions</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={8} className="muted">No admissions.</td></tr>}
          {list.data?.data.map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td>{a.patient_name}<br /><span className="muted small">{a.mrn}</span></td>
              <td>{a.bed_number} ({a.ward_name})</td>
              <td>{a.doctor_name ?? '—'}</td>
              <td>{dt(a.admitted_at)}</td>
              <td><Status value={a.status} /></td>
              <td>{a.bill_count ?? a.bills?.length ?? '—'}</td>
              <td>
                {a.status === 'admitted' && (
                  <span className="actions">
                    <button onClick={() => discharge(a.id)}>Discharge</button>
                    <button className="danger" onClick={() => discharge(a.id, true)}>Force</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pagination={list.data?.pagination} onPage={setPage} />
    </>
  );
}

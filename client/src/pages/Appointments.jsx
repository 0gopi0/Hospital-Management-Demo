import { useState } from 'react';
import { api, dt } from '../api.js';
import { clean, DoctorSelect, ErrorBox, Pager, PatientSelect, Status, useAction, useForm, useLoad } from '../ui.jsx';

/** datetime-local -> "YYYY-MM-DDTHH:mm" (zod coerces). */
const toLocal = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const plus30 = () => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (d.getMinutes() === 0) d.setHours(d.getHours() + 1);
  return toLocal(d);
};

const EMPTY = { patient_id: '', doctor_id: '', starts_at: '', reason: '', notes: '' };

export default function Appointments() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const list = useLoad(
    () => api.get('/appointments', { page, limit: 15, status: status || undefined, sort: 'starts', order: 'asc' }),
    [page, status]
  );

  const [form, bind, setForm, resetForm] = useForm({ ...EMPTY, starts_at: plus30() });
  const act = useAction();
  const [showForm, setShowForm] = useState(false);

  const book = async (e) => {
    e.preventDefault();
    try {
      await act.run(() =>
        api.post('/appointments', clean({ ...form, patient_id: Number(form.patient_id), doctor_id: Number(form.doctor_id) }))
      );
      resetForm();
      setShowForm(false);
      setPage(1);
      list.reload();
    } catch { /* shown in ErrorBox (409 overlap, 400 past) */ }
  };

  const transition = async (id, action) => {
    try {
      await act.run(() => api.post(`/appointments/${id}/${action}`));
      list.reload();
    } catch { /* shown in ErrorBox */ }
  };

  return (
    <>
      <div className="row between">
        <h1>Appointments</h1>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ Book appointment'}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={book}>
          <label>Patient*<PatientSelect value={form.patient_id} onChange={(v) => setForm((f) => ({ ...f, patient_id: v }))} /></label>
          <label>Doctor*<DoctorSelect value={form.doctor_id} onChange={(v) => setForm((f) => ({ ...f, doctor_id: v }))} /></label>
          <label>Starts at*<input type="datetime-local" {...bind('starts_at')} required /></label>
          <label>Reason<input {...bind('reason')} placeholder="Follow-up, fever…" /></label>
          <label className="full">Notes<textarea {...bind('notes')} rows={2} /></label>
          <div className="full">
            <ErrorBox error={act.error}>
              {act.error?.status === 409 && act.error?.details?.conflictingAppointment && (
                <div className="small">
                  Clash: {dt(act.error.details.conflictingAppointment.starts_at)} → {dt(act.error.details.conflictingAppointment.ends_at)}
                </div>
              )}
            </ErrorBox>
            <button className="primary" disabled={act.busy}>Book (30 min slot)</button>
          </div>
        </form>
      )}

      <div className="row">
        <label style={{ minWidth: 200 }}>Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option>scheduled</option><option>completed</option><option>cancelled</option><option>no_show</option>
          </select>
        </label>
        <button onClick={list.reload}>Refresh</button>
        {!showForm && <ErrorBox error={act.error} />}
      </div>

      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>#</th><th>Starts</th><th>Patient</th><th>Doctor</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={6} className="muted">No appointments.</td></tr>}
          {list.data?.data.map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td>{dt(a.starts_at)}</td>
              <td>{a.patient_name}<br /><span className="muted small">{a.mrn}</span></td>
              <td>{a.doctor_name}<br /><span className="muted small">{a.department_name}</span></td>
              <td><Status value={a.status} /></td>
              <td>
                {a.status === 'scheduled' && (
                  <span className="actions">
                    <button onClick={() => transition(a.id, 'complete')}>Complete</button>
                    <button onClick={() => transition(a.id, 'cancel')}>Cancel</button>
                    <button onClick={() => transition(a.id, 'no-show')}>No-show</button>
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

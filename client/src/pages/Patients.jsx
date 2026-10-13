import { useState } from 'react';
import { api, d } from '../api.js';
import { clean, ErrorBox, Pager, useAction, useForm, useLoad } from '../ui.jsx';

const EMPTY = { first_name: '', last_name: '', phone: '', dob: '', gender: '', email: '', blood_group: '', address: '' };

export default function Patients() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const list = useLoad(() => api.get('/patients', { page, limit: 15, search: term || undefined }), [page, term]);

  const [showForm, setShowForm] = useState(false);
  const [form, bind, , resetForm] = useForm(EMPTY);
  const act = useAction();
  const [dup, setDup] = useState(null); // 409 duplicate-phone payload
  const [created, setCreated] = useState(null);

  const save = async (force = false) => {
    setDup(null);
    setCreated(null);
    try {
      const p = await act.run(() => api.post('/patients', { ...clean(form), force }));
      setCreated(p);
      resetForm();
      setShowForm(false);
      list.reload();
    } catch (e) {
      if (e.status === 409 && e.details?.matches) {
        setDup(e);
        act.setError(null);
      }
    }
  };

  return (
    <>
      <div className="row between">
        <h1>Patients</h1>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ Add patient'}</button>
      </div>

      {created && <div className="alert ok">Created patient {created.mrn} — {created.first_name} {created.last_name}</div>}

      {showForm && (
        <form className="card form-grid" onSubmit={(e) => { e.preventDefault(); save(false); }}>
          <label>First name*<input {...bind('first_name')} required /></label>
          <label>Last name*<input {...bind('last_name')} required /></label>
          <label>Phone*<input {...bind('phone')} required /></label>
          <label>Date of birth<input type="date" {...bind('dob')} /></label>
          <label>Gender
            <select {...bind('gender')}><option value="">—</option><option>male</option><option>female</option><option>other</option></select>
          </label>
          <label>Blood group
            <select {...bind('blood_group')}><option value="">—</option>{['A+','A-','B+','B-','AB+','AB-','O+','O-'].map((b) => <option key={b}>{b}</option>)}</select>
          </label>
          <label>Email<input type="email" {...bind('email')} /></label>
          <label>Address<input {...bind('address')} /></label>
          <div className="full">
            <ErrorBox error={act.error} />
            {dup && (
              <div className="alert warn">
                <strong>409 — Possible duplicate.</strong> {dup.message}
                <table className="compact">
                  <thead><tr><th>MRN</th><th>Name</th><th>Phone</th></tr></thead>
                  <tbody>
                    {dup.details.matches.map((m) => (
                      <tr key={m.id}><td>{m.mrn}</td><td>{m.first_name} {m.last_name}</td><td>{m.phone}</td></tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" onClick={() => save(true)} disabled={act.busy}>Create anyway</button>{' '}
                <button type="button" onClick={() => setDup(null)}>Cancel</button>
              </div>
            )}
            <button className="primary" disabled={act.busy}>Save patient</button>
          </div>
        </form>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); setPage(1); setTerm(search.trim()); }}>
        <input placeholder="Search name, MRN, phone, email…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} />
        <button>Search</button>
        {term && <button type="button" onClick={() => { setSearch(''); setTerm(''); setPage(1); }}>Clear</button>}
      </form>

      <ErrorBox error={list.error} />
      <table>
        <thead><tr><th>MRN</th><th>Name</th><th>Phone</th><th>DOB</th><th>Gender</th><th>Blood</th><th>Email</th></tr></thead>
        <tbody>
          {list.data?.data.length === 0 && <tr><td colSpan={7} className="muted">No patients found.</td></tr>}
          {list.data?.data.map((p) => (
            <tr key={p.id}>
              <td>{p.mrn}</td><td>{p.first_name} {p.last_name}</td><td>{p.phone}</td><td>{d(p.dob)}</td>
              <td>{p.gender ?? '—'}</td><td>{p.blood_group ?? '—'}</td><td>{p.email ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager pagination={list.data?.pagination} onPage={setPage} />
    </>
  );
}

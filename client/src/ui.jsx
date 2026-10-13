import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Shows an ApiError with its status code and any detail payload. */
export function ErrorBox({ error, children }) {
  if (!error) return null;
  return (
    <div className="alert error">
      <strong>{error.status ? `${error.status} — ` : ''}{error.message}</strong>
      {Array.isArray(error.details) && error.details.every((x) => x.field !== undefined) ? (
        <ul>
          {error.details.map((x, i) => (
            <li key={i}>{x.field ? `${x.field}: ` : ''}{x.message}</li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  );
}

export const Badge = ({ kind = 'grey', children }) => <span className={`badge ${kind}`}>{children}</span>;

const STATUS_KIND = {
  scheduled: 'blue', completed: 'green', cancelled: 'grey', no_show: 'orange',
  admitted: 'blue', discharged: 'grey',
  unpaid: 'red', partial: 'orange', paid: 'green',
  pending: 'orange', dispensed: 'green',
  registered: 'blue', collected: 'orange', resulted: 'green',
  available: 'green', occupied: 'red', maintenance: 'grey',
};
export const Status = ({ value }) => <Badge kind={STATUS_KIND[value] ?? 'grey'}>{value?.replace('_', ' ')}</Badge>;

export function Pager({ pagination, onPage }) {
  if (!pagination) return null;
  const { page, totalPages, total } = pagination;
  return (
    <div className="pager">
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
      <span>Page {page} of {totalPages} · {total} records</span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next ›</button>
    </div>
  );
}

/** Runs `fn` whenever deps change; returns { data, error, loading, reload }. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    return run()
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error) => setState({ data: null, error, loading: false }));
  }, [run]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}

/** Wraps an async action so the caller gets busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Controlled-form helper: [values, bind(name), set, reset]. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const bind = (name) => ({
    name,
    value: values[name] ?? '',
    onChange: (e) => setValues((v) => ({ ...v, [name]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })),
  });
  return [values, bind, setValues, () => setValues(initial)];
}

/** Drops empty-string fields so optional API fields are omitted. */
export const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));

/** Simple patient picker: search box + select. */
export function PatientSelect({ value, onChange }) {
  const [search, setSearch] = useState('');
  const [opts, setOpts] = useState([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get('/patients', { search: search || undefined, limit: 20, sort: 'name', order: 'asc' })
        .then((r) => setOpts(r.data))
        .catch(() => setOpts([]));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  return (
    <span className="picker">
      <input placeholder="Search patient…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <select value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">— select patient —</option>
        {opts.map((p) => (
          <option key={p.id} value={p.id}>{p.mrn} · {p.first_name} {p.last_name} · {p.phone}</option>
        ))}
      </select>
    </span>
  );
}

export function DoctorSelect({ value, onChange, required = true }) {
  const [opts, setOpts] = useState([]);
  useEffect(() => {
    api.get('/doctors', { limit: 100, active: 'true' }).then((r) => setOpts(r.data)).catch(() => setOpts([]));
  }, []);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">— select doctor —</option>
      {opts.map((d) => (
        <option key={d.id} value={d.id}>{d.name} ({d.department_name})</option>
      ))}
    </select>
  );
}

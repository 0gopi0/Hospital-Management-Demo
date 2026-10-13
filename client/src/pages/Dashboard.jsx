import { api, dt, money } from '../api.js';
import { ErrorBox, useLoad } from '../ui.jsx';

const Card = ({ title, value, sub, tone }) => (
  <div className={`stat ${tone ?? ''}`}>
    <div className="stat-title">{title}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

export default function Dashboard() {
  const { data: s, error, loading, reload } = useLoad(() => api.get('/dashboard/summary'), []);

  if (error) return <ErrorBox error={error} />;
  if (!s) return <p>Loading…</p>;

  return (
    <>
      <div className="row between">
        <h1>Dashboard</h1>
        <button onClick={reload} disabled={loading}>Refresh</button>
      </div>
      <div className="stats">
        <Card title="Patients" value={s.patients.total} sub={`${s.patients.new_today} new today`} />
        <Card title="Appointments today" value={s.appointmentsToday.today}
          sub={`${s.appointmentsToday.scheduled} scheduled · ${s.appointmentsToday.completed} done · ${s.appointmentsToday.no_show} no-show`} />
        <Card title="Bed occupancy" value={`${s.beds.occupancyPct}%`}
          sub={`${s.beds.occupied}/${s.beds.total} occupied · ${s.beds.available} free`} tone={s.beds.occupancyPct > 85 ? 'warn' : ''} />
        <Card title="Admitted now" value={s.admissions.current}
          sub={`${s.admissions.admitted_today} in · ${s.admissions.discharged_today} out today`} />
        <Card title="Outstanding" value={money(s.billing.outstanding)} sub={`${s.billing.open_bills} open bills`} tone={s.billing.outstanding > 0 ? 'warn' : ''} />
        <Card title="Collected today" value={money(s.billing.collected_today)} sub={`Month: ${money(s.billing.collected_month)}`} />
        <Card title="Pharmacy alerts" value={s.pharmacy.low_stock + s.pharmacy.expired}
          sub={`${s.pharmacy.low_stock} low · ${s.pharmacy.expired} expired · ${s.pharmacy.expiring_30d} expiring 30d`}
          tone={s.pharmacy.expired > 0 ? 'bad' : s.pharmacy.low_stock > 0 ? 'warn' : ''} />
        <Card title="Pending Rx" value={s.pharmacy.pending_prescriptions} />
        <Card title="Lab queue" value={s.lab.registered + s.lab.collected}
          sub={`${s.lab.registered} registered · ${s.lab.collected} collected · ${s.lab.resulted_today} resulted today`} />
        <Card title="Critical results (7d)" value={s.lab.critical_7d} tone={s.lab.critical_7d > 0 ? 'bad' : ''} />
      </div>

      <h2>Upcoming appointments</h2>
      <table>
        <thead><tr><th>#</th><th>Starts</th><th>Ends</th><th>Patient</th><th>Doctor</th></tr></thead>
        <tbody>
          {s.upcomingAppointments.length === 0 && <tr><td colSpan={5} className="muted">No upcoming appointments.</td></tr>}
          {s.upcomingAppointments.map((a) => (
            <tr key={a.id}><td>{a.id}</td><td>{dt(a.starts_at)}</td><td>{dt(a.ends_at)}</td><td>{a.patient_name}</td><td>{a.doctor_name}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Generated {dt(s.generatedAt)}</p>
    </>
  );
}

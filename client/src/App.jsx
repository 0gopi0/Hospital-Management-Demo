import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Patients from './pages/Patients.jsx';
import Appointments from './pages/Appointments.jsx';
import Admissions from './pages/Admissions.jsx';
import Billing from './pages/Billing.jsx';
import Pharmacy from './pages/Pharmacy.jsx';
import Lab from './pages/Lab.jsx';

const NAV = [
  ['/', 'Dashboard'],
  ['/patients', 'Patients'],
  ['/appointments', 'Appointments'],
  ['/admissions', 'Admissions / Beds'],
  ['/billing', 'Billing'],
  ['/pharmacy', 'Pharmacy'],
  ['/lab', 'Lab'],
];

function Layout({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Hospital ERP</div>
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <div>{user.name}</div>
          <div className="muted">{user.role}</div>
          <button className="link" onClick={logout}>Log out</button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div className="center">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname }} />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/patients" element={<Patients />} />
        <Route path="/appointments" element={<Appointments />} />
        <Route path="/admissions" element={<Admissions />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/billing/:id" element={<Billing />} />
        <Route path="/pharmacy" element={<Pharmacy />} />
        <Route path="/lab" element={<Lab />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Routes>
    </Layout>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Dashboard } from './pages/Dashboard';
import { Grants } from './pages/Grants';
import { GrantDetail } from './pages/GrantDetail';
import { Questions } from './pages/Questions';
import { Knowledge } from './pages/Knowledge';
import { Documents } from './pages/Documents';
import { Applications } from './pages/Applications';
import { Settings } from './pages/Settings';

function Login({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState(localStorage.getItem('gp:name') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ name: string }>('/login', { body: { name, password } });
      localStorage.setItem('gp:name', res.name);
      onDone(res.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="brand big"><span className="logo">✓</span> Grants Portal</div>
        <p className="muted">One place for company knowledge, grant questions and applications.</p>
        <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex" autoComplete="name" required /></label>
        <label>Team password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

const NAV = [
  { to: '/', label: 'Home', icon: '◉', end: true },
  { to: '/grants', label: 'Grants', icon: '▤' },
  { to: '/questions', label: 'Questions', icon: '?' },
  { to: '/knowledge', label: 'Company knowledge', icon: '✦' },
  { to: '/documents', label: 'Documents', icon: '▣' },
  { to: '/applications', label: 'Applications', icon: '➤' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [sso, setSso] = useState(false);
  useEffect(() => {
    api<{ name: string; sso?: boolean }>('/me').then((r) => { setUser(r.name); setSso(!!r.sso); }).catch(() => setUser(null));
    const out = () => setUser(null);
    window.addEventListener('gp:signed-out', out);
    return () => window.removeEventListener('gp:signed-out', out);
  }, []);

  if (user === undefined) return <div className="empty"><span className="spinner" /></div>;
  if (user === null) return <Login onDone={setUser} />;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><span className="logo">✓</span><span className="brand-name">Grants Portal</span></div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon" aria-hidden>{n.icon}</span>
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <span>Signed in as <b>{user}</b></span>
          {sso ? <a className="linkish" href="/cdn-cgi/access/logout">Sign out</a> : <button className="linkish" onClick={() => api('/logout', { method: 'POST' }).finally(() => setUser(null))}>Sign out</button>}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard user={user} />} />
          <Route path="/grants" element={<Grants />} />
          <Route path="/grants/:id" element={<GrantDetail />} />
          <Route path="/questions" element={<Questions />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/applications" element={<Applications />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

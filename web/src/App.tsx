import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, api } from './api';
import { AgentDock } from './components/AgentDock';
import { Dashboard } from './pages/Dashboard';
import { Grants } from './pages/Grants';
import { GrantDetail } from './pages/GrantDetail';
import { Questions } from './pages/Questions';
import { Knowledge } from './pages/Knowledge';
import { Documents } from './pages/Documents';
import { Applications } from './pages/Applications';
import { Settings } from './pages/Settings';

interface Me { name: string; email: string; dev?: boolean }
type Gate = { kind: 'loading' } | { kind: 'in'; me: Me } | { kind: 'out'; public_url: string | null; dev_login: boolean; token_seen: boolean } | { kind: 'denied'; email: string };

function DevLogin({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/login', { body: { name: 'Developer', password } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    }
  }
  return (
    <form className="form" onSubmit={submit}>
      <label>Development password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required /></label>
      {error && <div className="error-box">{error}</div>}
      <button className="btn primary wide">Sign in</button>
    </form>
  );
}

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/grants', label: 'Grants' },
  { to: '/questions', label: 'Questions' },
  { to: '/knowledge', label: 'Company knowledge' },
  { to: '/documents', label: 'Documents' },
  { to: '/applications', label: 'Applications' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  const [gate, setGate] = useState<Gate>({ kind: 'loading' });

  const check = () => api<Me>('/me').then((me) => setGate({ kind: 'in', me })).catch((e) => {
    const data = (e instanceof ApiError ? e.data : null) as { email?: string; public_url?: string | null; dev_login?: boolean; token_seen?: boolean } | null;
    if (e instanceof ApiError && e.status === 403 && data?.email) setGate({ kind: 'denied', email: data.email });
    else setGate({ kind: 'out', public_url: data?.public_url ?? null, dev_login: !!data?.dev_login, token_seen: !!data?.token_seen });
  });
  useEffect(() => {
    check();
    window.addEventListener('gp:signed-out', check);
    return () => window.removeEventListener('gp:signed-out', check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (gate.kind === 'loading') return <div className="login-wrap"><span className="spinner" /></div>;
  if (gate.kind === 'denied') {
    return (
      <div className="login-wrap">
        <div className="login">
          <div className="brand big">Grants Portal</div>
          <p><b>{gate.email}</b> does not have access.</p>
          <a className="btn wide" href="/cdn-cgi/access/logout">Use a different account</a>
        </div>
      </div>
    );
  }
  if (gate.kind === 'out') {
    return (
      <div className="login-wrap">
        <div className="login">
          <div className="brand big">Grants Portal</div>
          {gate.token_seen && <div className="error-box">Google sign-in worked, but the portal could not verify it. Try again, and tell the developer if it keeps happening.</div>}
          {gate.dev_login ? <DevLogin onDone={check} /> : <a className="btn primary wide" href={gate.public_url ?? '/'}>Sign in with Google</a>}
        </div>
      </div>
    );
  }

  const me = gate.me;
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Grants Portal</div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>{n.label}</NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <span>{me.name}</span>
          {me.dev
            ? <button className="linkish" onClick={() => api('/logout', { method: 'POST' }).finally(check)}>Sign out</button>
            : <a href="/cdn-cgi/access/logout">Sign out</a>}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard user={me.name} />} />
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
      <AgentDock />
    </div>
  );
}

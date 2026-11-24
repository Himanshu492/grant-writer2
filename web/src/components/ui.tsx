import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Grant } from '../api';

// ---------- toasts ----------
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- data loading ----------
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(async () => {
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    setData(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => { if (!document.hidden) reload(); }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, reload]);
  return { data, error, reload, setData };
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <div className="empty error-box">Could not load this: {error}</div>;
  return <div className="empty"><span className="spinner" /> Loading…</div>;
}

// ---------- small pieces ----------
export function Pill({ tone = 'muted', children, title }: { tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'info' | 'accent'; children: ReactNode; title?: string }) {
  return <span className={`pill ${tone}`} title={title}>{children}</span>;
}

export function ProgressBar({ p }: { p: Grant['progress'] }) {
  if (!p.total) return <div className="bar empty-bar" title="No questions loaded yet" />;
  const pct = (n: number) => `${(n / p.total) * 100}%`;
  return (
    <div className="bar" title={`${p.done} of ${p.total} answered${p.suggested ? `, ${p.suggested} to confirm` : ''}`}>
      <span className="seg done" style={{ width: pct(p.done) }} />
      <span className="seg suggested" style={{ width: pct(p.suggested) }} />
      <span className="seg draft" style={{ width: pct(p.draft) }} />
    </div>
  );
}

export function progressText(g: Grant): string {
  const p = g.progress;
  if (!p.total) return g.questions_verification === 'not_accessible' ? 'Questions are behind a login — scan needed' : 'No questions loaded yet';
  if (g.ready) return `All ${p.total} answered — ready to apply`;
  const bits = [`${p.done} of ${p.total} answered`];
  if (p.suggested) bits.push(`${p.suggested} to confirm`);
  if (p.empty + p.draft) bits.push(`${p.empty + p.draft} need you`);
  return bits.join(' · ');
}

const VERIFY: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info'; explain: string }> = {
  live_form: { label: 'Verified on live form', tone: 'ok', explain: 'These questions were read directly from the funder\'s live application form.' },
  agent_scan: { label: 'Scanned from live form', tone: 'ok', explain: 'The browser agent read these questions off the live application form.' },
  official_document: { label: 'From official guidance', tone: 'info', explain: 'These come from the funder\'s own published guidance or preview, not the form itself.' },
  third_party_copy: { label: 'Unofficial copy', tone: 'warn', explain: 'Taken from a third-party copy because the funder does not publish the questions. Scan the live form to confirm.' },
  not_accessible: { label: 'Behind login — not verified', tone: 'danger', explain: 'The real form is behind a login, so its questions could not be read. Run "Scan the live form" after signing in.' },
  manual: { label: 'Added by hand', tone: 'muted', explain: 'This grant was added by hand.' },
  unverified: { label: 'Not verified', tone: 'danger', explain: 'No verified questions yet.' },
};
export function verification(v: string) {
  return VERIFY[v] ?? VERIFY.unverified;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { todoText, type Grant } from '../api';

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
  if (error) return <div className="error-box">Could not load this. {error}</div>;
  return <div className="empty"><span className="spinner" /> Loading…</div>;
}

// ---------- small pieces ----------
export function Pill({ tone = 'muted', children, title }: { tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`pill ${tone}`} title={title}>{children}</span>;
}

export function ProgressBar({ p }: { p: Grant['progress'] }) {
  if (!p.total) return <div className="bar" />;
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
  if (!p.total) return g.questions_verification === 'not_accessible' ? 'Form is behind a login. Scan it to load the questions.' : 'No questions yet';
  if (g.ready) return 'Ready to apply';
  return todoText(p) || `${p.done} of ${p.total} answered`;
}

const VERIFY: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' }> = {
  live_form: { label: 'Read from the live form', tone: 'ok' },
  agent_scan: { label: 'Scanned from the live form', tone: 'ok' },
  official_document: { label: 'From official guidance', tone: 'info' },
  third_party_copy: { label: 'Unofficial copy', tone: 'warn' },
  not_accessible: { label: 'Behind a login', tone: 'danger' },
  manual: { label: 'Added by hand', tone: 'muted' },
  unverified: { label: 'Not verified', tone: 'danger' },
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
          <button className="btn quiet" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

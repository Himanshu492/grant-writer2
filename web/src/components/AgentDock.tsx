import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtAgo, plain } from '../api';
import { useToast } from './ui';

interface DockRun {
  id: string; grant_id: string; grant_title: string; mode: 'test' | 'live' | 'scan'; status: string; note: string;
  human_reason: string | null; progress_done: number; progress_total: number; resume_requested: number; cancel_requested: number;
}
interface DockState { online: boolean; last_seen: string | null; screen_url: string | null; run: DockRun | null }

const ACTIVE = ['queued', 'running', 'needs_human'];

/** Ask the floating agent window to open (used by the Apply button and anywhere else the agent is mentioned). */
export function openAgentDock(big = false) {
  window.dispatchEvent(new CustomEvent('gp:agent-open', { detail: { big } }));
}

/**
 * The agent's browser, always one click away in the corner. It opens by itself when a run starts or when the
 * agent needs a person; expanded, the browser is fully usable so a login or CAPTCHA can be done right here.
 */
export function AgentDock() {
  const toast = useToast();
  const [mode, setMode] = useState<'min' | 'open' | 'big'>('min');
  const [state, setState] = useState<DockState | null>(null);
  const seen = useRef<{ id: string | null; status: string | null }>({ id: null, status: null });

  const load = () => api<DockState>('/dock').then((s) => {
    setState(s);
    const run = s.run;
    const was = seen.current;
    if (run && ACTIVE.includes(run.status)) {
      // A new run, or the agent just asked for a person: bring the window forward.
      if (was.id !== null && run.id !== was.id) setMode((m) => (m === 'min' ? 'open' : m));
      if (run.status === 'needs_human' && was.status !== 'needs_human') setMode((m) => (m === 'min' ? 'open' : m));
    }
    seen.current = { id: run?.id ?? '', status: run?.status ?? '' };
  }).catch(() => {});

  const active = !!state?.run && ACTIVE.includes(state.run.status);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, active || mode !== 'min' ? 3000 : 12000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode]);

  useEffect(() => {
    const open = (e: Event) => { setMode((e as CustomEvent).detail?.big ? 'big' : 'open'); load(); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMode((m) => (m === 'big' ? 'open' : m));
    window.addEventListener('gp:agent-open', open);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('gp:agent-open', open); window.removeEventListener('keydown', esc); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return null;
  const run = state.run;
  const needs = run?.status === 'needs_human';
  const dot = needs ? 'needs' : active ? 'busy' : state.online ? 'on' : '';
  const label = needs ? 'Agent needs you'
    : active && run ? `${run.grant_title}${run.mode !== 'scan' && run.progress_total ? ` ${run.progress_done}/${run.progress_total}` : ''}`
    : state.online ? 'Agent' : 'Agent offline';

  async function act(path: string, ok: string) {
    try {
      await api(`/runs/${run!.id}/${path}`, { method: 'POST' });
      toast(ok);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work', 'error');
    }
  }

  if (mode === 'min') {
    return (
      <div className="dock">
        <button className={`dock-pill ${needs ? 'needs' : ''}`} onClick={() => setMode('open')} aria-label="Open the agent's browser">
          <span className={`dot ${dot}`} /><span className="label">{label}</span>
        </button>
      </div>
    );
  }

  const big = mode === 'big';
  const pct = run && run.progress_total ? Math.min(100, Math.round((run.progress_done / run.progress_total) * 100)) : 0;
  const modeLabel = run ? (run.mode === 'scan' ? 'Scanning' : run.mode === 'live' ? 'Applying' : 'Test run') : '';
  return (
    <div className="dock">
      <div className={`dock-win ${big ? 'big' : ''}`} role="dialog" aria-label="Agent browser">
        <div className="dock-bar">
          <span className={`dot ${dot}`} />
          <span className="dock-title">{active && run ? `${modeLabel}: ${run.grant_title}` : 'Agent browser'}</span>
          <button className="btn quiet small" onClick={() => setMode(big ? 'open' : 'big')}>{big ? 'Shrink' : 'Expand'}</button>
          <button className="btn quiet small" onClick={() => setMode('min')}>Minimize</button>
        </div>
        <div className="dock-screen">
          {state.screen_url ? (
            <>
              <iframe src={state.screen_url} title="The agent's browser" allow="clipboard-read; clipboard-write" />
              {!big && <button className="cover" onClick={() => setMode('big')} aria-label="Expand to use the browser" title="Expand to use the browser" />}
            </>
          ) : (
            <div className="blank">{state.online ? 'Connecting to the screen' : state.last_seen ? `The agent is offline. Last seen ${fmtAgo(state.last_seen)}.` : 'The agent is offline.'}</div>
          )}
        </div>
        <div className="dock-foot">
          {needs && run ? (
            <>
              <div className="needs">{plain(run.human_reason) || 'The agent needs you to step in.'}</div>
              <div className="row">
                {!big && <button className="btn" onClick={() => setMode('big')}>Take over</button>}
                <button className="btn primary" disabled={!!run.resume_requested} onClick={() => act('resume', 'Continuing.')}>{run.resume_requested ? 'Continuing' : "I'm done, continue"}</button>
                <button className="btn quiet danger-text" disabled={!!run.cancel_requested} onClick={() => act('cancel', 'Cancelling.')}>Cancel</button>
              </div>
            </>
          ) : active && run ? (
            <>
              {run.mode !== 'scan' && run.progress_total > 0 && <div className="bar"><span className="seg done" style={{ width: `${pct}%` }} /></div>}
              <div className="row">
                <span className="grow clamp1 muted">{run.status === 'queued' ? (state.online ? 'Starting' : 'Waiting for the agent to come online') : plain(run.note) || 'Working'}</span>
                <button className="btn quiet small danger-text" disabled={!!run.cancel_requested} onClick={() => act('cancel', 'Cancelling.')}>Cancel</button>
              </div>
            </>
          ) : run ? (
            <div className="row">
              <span className="grow">{run.status === 'review' ? 'Filled in, not submitted.' : run.status === 'submitted' ? 'Submitted.' : run.status === 'completed' ? 'Scan finished.' : run.status === 'failed' ? 'Run failed.' : 'Run cancelled.'}</span>
              <Link className="btn small" to={`/grants/${run.grant_id}`}>Open grant</Link>
            </div>
          ) : (
            <span className="muted">{state.online ? 'Idle. Press Apply on a grant to start.' : 'Offline.'}</span>
          )}
        </div>
      </div>
    </div>
  );
}

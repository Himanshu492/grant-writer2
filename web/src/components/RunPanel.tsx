import { useState } from 'react';
import { api, fmtAgo, plain, type Run } from '../api';
import { openAgentDock } from './AgentDock';
import { Pill, useLoad } from './ui';

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' }> = {
  queued: { label: 'Starting', tone: 'info' },
  running: { label: 'Working', tone: 'info' },
  needs_human: { label: 'Needs you', tone: 'danger' },
  review: { label: 'Filled, not submitted', tone: 'ok' },
  submitted: { label: 'Submitted', tone: 'ok' },
  completed: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};
const MODE: Record<string, string> = { test: 'Test run', live: 'Application', scan: 'Form scan' };

interface Detail {
  run: Run;
  events: { id: number; at: string; level: string; message: string; has_screenshot: number }[];
}

/** What the agent did on its latest run for this grant. The live screen itself is in the floating window. */
export function RunPanel({ runId, onFinished }: { runId: string; onFinished?: () => void }) {
  const [shot, setShot] = useState<number | null>(null);
  const [wasActive, setWasActive] = useState(false);
  const { data } = useLoad<Detail>(async () => {
    const d = await api<Detail>(`/runs/${runId}`);
    const active = ['queued', 'running', 'needs_human'].includes(d.run.status);
    if (active) setWasActive(true);
    else if (wasActive) { setWasActive(false); onFinished?.(); }
    return d;
  }, [runId], 4000);
  if (!data) return null;
  const { run, events } = data;
  const st = STATUS[run.status] ?? STATUS.queued;
  const active = ['queued', 'running', 'needs_human'].includes(run.status);

  return (
    <details className="panel fold events" open={active}>
      <summary>
        <span className="row">{MODE[run.mode]} <Pill tone={st.tone}>{st.label}</Pill> <span className="muted small">{fmtAgo(run.created_at)}</span></span>
      </summary>
      {run.note && !active && <p>{plain(run.note)}</p>}
      {active && <p><button className="btn" onClick={() => openAgentDock(run.status === 'needs_human')}>{run.status === 'needs_human' ? 'Take over the browser' : 'Watch the agent'}</button></p>}
      <ul>
        {events.map((e) => (
          <li key={e.id} className={e.level}>
            <span className="ev-time">{new Date(e.at.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="ev-msg">{plain(e.message)}</span>
            {e.has_screenshot ? <button className="linkish" onClick={() => setShot(shot === e.id ? null : e.id)}>{shot === e.id ? 'Hide' : 'Screenshot'}</button> : null}
            {shot === e.id && <a href={`/api/runs/${run.id}/screenshots/${e.id}`} target="_blank" rel="noreferrer"><img className="shot" src={`/api/runs/${run.id}/screenshots/${e.id}`} alt="The agent's browser at this step" /></a>}
          </li>
        ))}
      </ul>
    </details>
  );
}

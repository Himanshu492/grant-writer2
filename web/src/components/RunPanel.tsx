import { useState } from 'react';
import { api, fmtAgo, type AgentStatus, type Run } from '../api';
import { Pill, useLoad, useToast } from './ui';

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' }> = {
  queued: { label: 'Waiting for the agent', tone: 'info' },
  running: { label: 'Agent is working', tone: 'info' },
  needs_human: { label: 'Needs you', tone: 'danger' },
  review: { label: 'Filled — not submitted (test)', tone: 'ok' },
  submitted: { label: 'Submitted', tone: 'ok' },
  completed: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};
const MODE: Record<string, string> = { test: 'Test run', live: 'Real application', scan: 'Form scan' };

interface Detail {
  run: Run;
  events: { id: number; at: string; level: string; message: string; has_screenshot: number }[];
  agent: AgentStatus;
}

export function RunPanel({ runId, onFinished }: { runId: string; onFinished?: () => void }) {
  const toast = useToast();
  const [shot, setShot] = useState<number | null>(null);
  const [wasActive, setWasActive] = useState(false);
  const { data, reload } = useLoad<Detail>(async () => {
    const d = await api<Detail>(`/runs/${runId}`);
    const active = ['queued', 'running', 'needs_human'].includes(d.run.status);
    if (active) setWasActive(true);
    else if (wasActive) { setWasActive(false); onFinished?.(); }
    return d;
  }, [runId], 3000);
  if (!data) return null;
  const { run, events, agent } = data;
  const st = STATUS[run.status] ?? STATUS.queued;
  const active = ['queued', 'running', 'needs_human'].includes(run.status);
  const pct = run.progress_total ? Math.min(100, Math.round((run.progress_done / run.progress_total) * 100)) : 0;

  async function act(path: string, ok: string) {
    try {
      await api(`/runs/${run.id}/${path}`, { method: 'POST' });
      toast(ok);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work', 'error');
    }
  }

  return (
    <div className={`runpanel ${run.status}`}>
      <div className="sec-head">
        <h3>{MODE[run.mode]} <span className="muted small">· started {fmtAgo(run.created_at)}{run.started_by ? ` by ${run.started_by}` : ''}</span></h3>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>

      {run.status === 'queued' && !agent.online && (
        <div className="q-note warn">The browser agent is offline (last seen {fmtAgo(agent.last_seen)}). This run will start as soon as it is back.</div>
      )}

      {run.status === 'needs_human' && (
        <div className="handover">
          <div className="handover-title">The agent needs you to step in</div>
          <p>{run.human_reason}</p>
          <ol>
            <li>Open the agent's browser{run.live_view_url ? '' : ' (no live view link was reported — check the agent on the VM)'}.</li>
            <li>Do the step yourself (log in, create the account, solve the CAPTCHA…). Leave the page where the form continues.</li>
            <li>Come back here and press <b>I'm done — continue</b>.</li>
          </ol>
          <div className="row">
            {run.live_view_url && <a className="btn primary" href={run.live_view_url} target="_blank" rel="noreferrer">Open the agent's browser ↗</a>}
            <button className="btn" disabled={!!run.resume_requested} onClick={() => act('resume', 'Told the agent to continue.')}>
              {run.resume_requested ? 'Continuing…' : "I'm done — continue"}
            </button>
          </div>
        </div>
      )}

      {run.mode !== 'scan' && run.progress_total > 0 && (
        <div className="run-progress">
          <div className="bar"><span className="seg done" style={{ width: `${pct}%` }} /></div>
          <span className="muted small">{run.progress_done} of {run.progress_total} fields</span>
        </div>
      )}
      {run.note && <p className="run-note">{run.note}</p>}

      {run.status === 'review' && (
        <div className="q-note accent">Test mode: the form was filled in but <b>not submitted</b>. Check the screenshots below{run.live_view_url ? <> or <a href={run.live_view_url} target="_blank" rel="noreferrer">look at the agent's browser</a></> : null}. When you are happy, allow real submission and run it for real.</div>
      )}

      <details className="events" open={active || events.some((e) => e.has_screenshot)}>
        <summary>Activity ({events.length})</summary>
        <ul>
          {events.map((e) => (
            <li key={e.id} className={e.level}>
              <span className="ev-time">{new Date(e.at.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="ev-msg">{e.message}</span>
              {e.has_screenshot ? <button className="linkish" onClick={() => setShot(shot === e.id ? null : e.id)}>{shot === e.id ? 'hide' : 'screenshot'}</button> : null}
              {shot === e.id && <a href={`/api/runs/${run.id}/screenshots/${e.id}`} target="_blank" rel="noreferrer"><img className="shot" src={`/api/runs/${run.id}/screenshots/${e.id}`} alt="Screenshot from the agent's browser" /></a>}
            </li>
          ))}
        </ul>
      </details>

      <div className="row">
        {active && run.live_view_url && run.status !== 'needs_human' && <a className="btn ghost" href={run.live_view_url} target="_blank" rel="noreferrer">Watch live ↗</a>}
        {active && <button className="btn ghost danger-text" disabled={!!run.cancel_requested} onClick={() => act('cancel', 'Cancelling the run.')}>{run.cancel_requested ? 'Cancelling…' : 'Cancel run'}</button>}
      </div>
    </div>
  );
}

import { Link } from 'react-router-dom';
import { api, fmtAgo, type AgentStatus, type Run } from '../api';
import { Loading, Pill, useLoad } from '../components/ui';

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'info'> = {
  queued: 'info', running: 'info', needs_human: 'danger', review: 'ok', submitted: 'ok', completed: 'ok', failed: 'danger', cancelled: 'muted',
};
const LABEL: Record<string, string> = {
  queued: 'Waiting for agent', running: 'Agent working', needs_human: 'Needs you', review: 'Filled, not submitted', submitted: 'Submitted',
  completed: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};

export function Applications() {
  const { data, error } = useLoad<{ runs: (Run & { grant_title: string })[]; agent: AgentStatus }>(() => api('/runs'), [], 5000);
  if (!data) return <Loading error={error} />;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Applications</h1>
          <p className="muted">Everything the browser agent has done or is doing. Press Apply on a grant to start one.</p>
        </div>
        <Pill tone={data.agent.online ? 'ok' : 'muted'}>Browser agent {data.agent.online ? 'online' : `offline · last seen ${fmtAgo(data.agent.last_seen)}`}</Pill>
      </header>
      {data.runs.length === 0 ? <div className="empty">No runs yet. Open a grant and press <b>Apply</b> — start with the practice grant to see how it works.</div> : (
        <div className="table">
          {data.runs.map((r) => (
            <Link key={r.id} to={`/grants/${r.grant_id}`} className="trow">
              <div className="grow">
                <div className="fact-title">{r.grant_title}</div>
                <div className="muted small">{r.mode === 'scan' ? 'Form scan' : r.mode === 'live' ? 'Real application' : 'Test run'} · started {fmtAgo(r.created_at)}{r.started_by ? ` by ${r.started_by}` : ''}{r.note ? ` · ${r.note}` : ''}</div>
              </div>
              {r.progress_total > 0 && r.mode !== 'scan' && <span className="muted small">{r.progress_done}/{r.progress_total} fields</span>}
              <Pill tone={TONE[r.status] ?? 'muted'}>{LABEL[r.status] ?? r.status}</Pill>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

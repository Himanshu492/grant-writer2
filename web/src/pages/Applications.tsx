import { Link } from 'react-router-dom';
import { api, fmtAgo, type Run } from '../api';
import { Loading, Pill, useLoad } from '../components/ui';

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'info'> = {
  queued: 'info', running: 'info', needs_human: 'danger', review: 'ok', submitted: 'ok', completed: 'ok', failed: 'danger', cancelled: 'muted',
};
const LABEL: Record<string, string> = {
  queued: 'Starting', running: 'Working', needs_human: 'Needs you', review: 'Filled, not submitted', submitted: 'Submitted',
  completed: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};
const MODE: Record<string, string> = { scan: 'Form scan', live: 'Application', test: 'Test run' };

export function Applications() {
  const { data, error } = useLoad<{ runs: (Run & { grant_title: string })[] }>(() => api('/runs'), [], 6000);
  if (!data) return <Loading error={error} />;
  return (
    <div className="page">
      <header className="page-head"><h1>Applications</h1></header>
      {data.runs.length === 0 ? <div className="empty">Nothing yet. Open a grant and press Apply.</div> : (
        <div className="table">
          {data.runs.map((r) => (
            <Link key={r.id} to={`/grants/${r.grant_id}`} className="trow">
              <div className="grow">
                <div className="fact-title">{r.grant_title}</div>
                <div className="muted small">{MODE[r.mode]} · {fmtAgo(r.created_at)}{r.started_by ? ` · ${r.started_by}` : ''}</div>
              </div>
              <Pill tone={TONE[r.status] ?? 'muted'}>{LABEL[r.status] ?? r.status}</Pill>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

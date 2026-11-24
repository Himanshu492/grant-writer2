import { Link } from 'react-router-dom';
import { api, fmtAgo, type AgentStatus, type Grant, type Question, type Run } from '../api';
import { GrantCard } from '../components/GrantCard';
import { QuestionCard } from '../components/QuestionCard';
import { Loading, Pill, useLoad } from '../components/ui';

interface Dash {
  grants: Grant[];
  queue: { question: Question; grants: { id: string; title: string; deadline: string | null }[] }[];
  queue_total: number;
  counts: { knowledge: number; documents: number; suggested: number };
  agent: AgentStatus;
  runs: (Run & { grant_title: string })[];
}

export function Dashboard({ user }: { user: string }) {
  const { data, error, reload } = useLoad<Dash>(() => api('/dashboard'), [], 20000);
  if (!data) return <Loading error={error} />;

  const active = data.grants.filter((g) => g.pipeline === 'active' && !g.is_sandbox);
  const open = (g: Grant) => g.days_left === null || g.days_left >= 0;
  const dueSoon = active.filter((g) => g.days_left !== null && g.days_left >= 0 && g.days_left <= 45).sort((a, b) => a.days_left! - b.days_left!);
  const urgent = dueSoon.filter((g) => g.days_left! <= 14 && !g.ready);
  const ready = active.filter((g) => g.ready && open(g));
  const almost = active
    .filter((g) => !g.ready && open(g) && g.progress.total > 0 && (g.remaining <= 8 || g.progress.done / g.progress.total >= 0.7))
    .sort((a, b) => a.remaining - b.remaining);
  const needInput = active.reduce((n, g) => n + g.progress.empty + g.progress.draft, 0);
  const waiting = data.runs.filter((r) => r.status === 'needs_human');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Hi {user.split(' ')[0]} — here's what needs you</h1>
          <p className="muted">Answer something once and every grant that asks it is filled in. Your only job is to supply what the company hasn't told us yet.</p>
        </div>
      </header>

      {waiting.map((r) => (
        <Link key={r.id} to={`/grants/${r.grant_id}`} className="callout danger">
          <b>The browser agent is waiting for you on {r.grant_title}.</b> {r.human_reason} <span className="callout-cta">Step in →</span>
        </Link>
      ))}

      <section className="tiles">
        <Link to="/questions?filter=needs_input" className="tile">
          <div className="tile-num danger-text">{data.queue_total}</div>
          <div className="tile-label">questions need your input</div>
          <div className="tile-sub">{needInput} form fields across {active.length} grants</div>
        </Link>
        <Link to="/questions?filter=to_confirm" className="tile">
          <div className="tile-num accent-text">{data.counts.suggested}</div>
          <div className="tile-label">answers to confirm</div>
          <div className="tile-sub">already filled from company knowledge</div>
        </Link>
        <Link to="/grants" className="tile">
          <div className="tile-num ok-text">{ready.length}</div>
          <div className="tile-label">grants ready to apply</div>
          <div className="tile-sub">{almost.length} more are close</div>
        </Link>
        <Link to="/grants" className="tile">
          <div className="tile-num">{dueSoon.length}</div>
          <div className="tile-label">due in the next 45 days</div>
          <div className="tile-sub">{urgent.length ? `${urgent.length} within two weeks` : 'nothing within two weeks'}</div>
        </Link>
      </section>

      {urgent.length > 0 && (
        <section>
          <h2>Urgent — due within two weeks</h2>
          <div className="grid">{urgent.map((g) => <GrantCard key={g.id} g={g} cta={g.remaining ? `Answer ${g.remaining} question${g.remaining > 1 ? 's' : ''}` : 'Open'} />)}</div>
        </section>
      )}

      {ready.length > 0 && (
        <section>
          <h2>Ready to apply</h2>
          <div className="grid">{ready.map((g) => <GrantCard key={g.id} g={g} cta="Review and apply" />)}</div>
        </section>
      )}

      <section>
        <div className="sec-head">
          <h2>Answer next</h2>
          <Link to="/questions" className="linkish">See all {data.queue_total} →</Link>
        </div>
        <p className="muted sec-sub">Ordered by deadline. Each one is asked once, no matter how many grants need it.</p>
        {data.queue.length === 0 ? (
          <div className="empty">Nothing is waiting on you. 🎉</div>
        ) : (
          <div className="stack">
            {data.queue.slice(0, 6).map((item) => (
              <QuestionCard key={item.question.id} q={{ ...item.question, grant_title: item.grants[0].title }} showGrant alsoAskedBy={item.grants} onChange={() => reload()} />
            ))}
          </div>
        )}
      </section>

      {almost.length > 0 && (
        <section>
          <h2>Almost there — a few answers from done</h2>
          <div className="grid">{almost.slice(0, 6).map((g) => <GrantCard key={g.id} g={g} cta={`${g.remaining} to go`} />)}</div>
        </section>
      )}

      {dueSoon.length > 0 && (
        <section>
          <h2>Due soon</h2>
          <div className="grid">{dueSoon.map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}

      <section className="two-col">
        <div className="panel">
          <div className="sec-head">
            <h3>Browser agent</h3>
            <Pill tone={data.agent.online ? 'ok' : 'muted'}>{data.agent.online ? 'Online' : 'Offline'}</Pill>
          </div>
          <p className="muted">{data.agent.online ? 'Ready to fill applications.' : `Last seen ${fmtAgo(data.agent.last_seen)}. Runs will wait in the queue until it is back.`}</p>
          {data.runs.length === 0 ? <p className="muted">No recent runs.</p> : (
            <ul className="runlist">
              {data.runs.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <Link to={`/grants/${r.grant_id}`}>{r.grant_title}</Link>
                  <span className="muted"> · {r.mode} · {r.status.replace('_', ' ')} · {fmtAgo(r.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h3>What the portal knows</h3>
          <p className="muted">{data.counts.knowledge} company facts and {data.counts.documents} document{data.counts.documents === 1 ? '' : 's'} on file. Every approved answer is added automatically.</p>
          <div className="row"><Link className="btn" to="/knowledge">Company knowledge</Link><Link className="btn" to="/documents">Documents</Link></div>
        </div>
      </section>
    </div>
  );
}

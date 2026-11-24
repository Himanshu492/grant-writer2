import { Link } from 'react-router-dom';
import { api, type Grant, type Question } from '../api';
import { GrantCard } from '../components/GrantCard';
import { QuestionCard } from '../components/QuestionCard';
import { Loading, useLoad } from '../components/ui';

interface Dash {
  grants: Grant[];
  queue: { question: Question; grants: { id: string; title: string; deadline: string | null }[] }[];
  queue_total: number;
  counts: { knowledge: number; documents: number; suggested: number };
}

export function Dashboard({ user }: { user: string }) {
  const { data, error, reload } = useLoad<Dash>(() => api('/dashboard'), [], 30000);
  if (!data) return <Loading error={error} />;

  const active = data.grants.filter((g) => g.pipeline === 'active' && !g.is_sandbox);
  const open = (g: Grant) => g.days_left === null || g.days_left >= 0;
  const dueSoon = active.filter((g) => g.days_left !== null && g.days_left >= 0 && g.days_left <= 45).sort((a, b) => a.days_left! - b.days_left!);
  const urgent = dueSoon.filter((g) => g.days_left! <= 14 && !g.ready);
  const later = dueSoon.filter((g) => !urgent.includes(g));
  const ready = active.filter((g) => g.ready && open(g));
  const almost = active
    .filter((g) => !g.ready && open(g) && g.status !== 'closed' && g.progress.total > 0 && !urgent.includes(g) && g.progress.empty + g.progress.draft <= 12)
    .sort((a, b) => a.progress.empty + a.progress.draft - (b.progress.empty + b.progress.draft));

  return (
    <div className="page">
      <header className="page-head"><h1>Hi {user.split(' ')[0]}</h1></header>

      <section className="tiles">
        <Link to="/questions?filter=needs_input" className="tile">
          <div className="tile-num danger-text">{data.queue_total}</div>
          <div className="tile-label">need your input</div>
        </Link>
        <Link to="/questions?filter=to_confirm" className="tile">
          <div className="tile-num info-text">{data.counts.suggested}</div>
          <div className="tile-label">to confirm</div>
        </Link>
        <Link to="/grants" className="tile">
          <div className="tile-num ok-text">{ready.length}</div>
          <div className="tile-label">ready to apply</div>
        </Link>
        <Link to="/grants" className="tile">
          <div className="tile-num">{dueSoon.length}</div>
          <div className="tile-label">due in 45 days</div>
        </Link>
      </section>

      {urgent.length > 0 && (
        <section>
          <h2>Due within two weeks</h2>
          <div className="grid">{urgent.map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}

      {ready.length > 0 && (
        <section>
          <h2>Ready to apply</h2>
          <div className="grid">{ready.map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}

      <section>
        <div className="sec-head">
          <h2>Answer next</h2>
          {data.queue_total > 5 && <Link to="/questions">All {data.queue_total}</Link>}
        </div>
        {data.queue.length === 0 ? <div className="empty">Nothing is waiting on you.</div> : (
          <div className="stack">
            {data.queue.slice(0, 5).map((item) => (
              <QuestionCard key={item.question.id} q={{ ...item.question, grant_title: item.grants[0].title }} showGrant alsoAskedBy={item.grants} onChange={() => reload()} />
            ))}
          </div>
        )}
      </section>

      {almost.length > 0 && (
        <section>
          <h2>Almost done</h2>
          <div className="grid">{almost.slice(0, 6).map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}

      {later.length > 0 && (
        <section>
          <h2>Due soon</h2>
          <div className="grid">{later.map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}
    </div>
  );
}

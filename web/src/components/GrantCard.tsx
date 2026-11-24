import { Link } from 'react-router-dom';
import { dueLabel, type Grant } from '../api';
import { Pill, ProgressBar, progressText } from './ui';

export function GrantCard({ g }: { g: Grant }) {
  const due = dueLabel(g);
  const needsYou = g.last_run?.status === 'needs_human';
  const working = g.last_run && ['queued', 'running'].includes(g.last_run.status);
  return (
    <Link to={`/grants/${g.id}`} className="gcard">
      <div className="gcard-top">
        <div className="gcard-title">{g.title}</div>
        {g.pipeline === 'submitted' ? <Pill tone="ok">Submitted</Pill>
          : needsYou ? <Pill tone="danger">Agent needs you</Pill>
          : working ? <Pill tone="info">Agent working</Pill>
          : g.ready && g.pipeline === 'active' ? <Pill tone="ok">Ready</Pill>
          : g.pipeline === 'not_pursuing' ? <Pill>Not pursuing</Pill> : null}
      </div>
      <div className={`due ${due.tone}`}>{due.text}</div>
      <ProgressBar p={g.progress} />
      <div className="gcard-foot">{progressText(g)}</div>
    </Link>
  );
}

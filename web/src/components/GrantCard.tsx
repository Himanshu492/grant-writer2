import { Link } from 'react-router-dom';
import { dueLabel, type Grant } from '../api';
import { Pill, ProgressBar, progressText, verification } from './ui';

export function GrantCard({ g, cta }: { g: Grant; cta?: string }) {
  const due = dueLabel(g);
  const v = verification(g.questions_verification);
  return (
    <Link to={`/grants/${g.id}`} className="gcard">
      <div className="gcard-top">
        <div>
          <div className="gcard-title">{g.title}</div>
          {g.amount && <div className="gcard-sub">{g.amount}</div>}
        </div>
        <div className="gcard-pills">
          {g.pipeline === 'submitted' && <Pill tone="ok">Submitted</Pill>}
          {g.pipeline === 'not_pursuing' && <Pill>Not pursuing</Pill>}
          {g.ready && g.pipeline === 'active' && <Pill tone="ok">Ready to apply</Pill>}
          {g.last_run && ['queued', 'running'].includes(g.last_run.status) && <Pill tone="info">Agent working</Pill>}
          {g.last_run?.status === 'needs_human' && <Pill tone="danger">Agent needs you</Pill>}
        </div>
      </div>
      <div className={`due ${due.tone}`}>{due.text}</div>
      <ProgressBar p={g.progress} />
      <div className="gcard-foot">
        <span>{progressText(g)}</span>
        {g.progress.total > 0 && v.tone !== 'ok' && <Pill tone={v.tone} title={v.explain}>{v.label}</Pill>}
      </div>
      {cta && <div className="gcard-cta">{cta} →</div>}
    </Link>
  );
}

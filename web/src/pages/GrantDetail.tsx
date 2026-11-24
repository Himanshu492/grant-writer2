import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dueLabel, fmtDate, type AgentStatus, type Doc, type Grant, type Question, type Run } from '../api';
import { QuestionCard } from '../components/QuestionCard';
import { RunPanel } from '../components/RunPanel';
import { Loading, Modal, Pill, ProgressBar, progressText, useLoad, useToast, verification } from '../components/ui';

interface Detail { grant: Grant; questions: Question[]; runs: Run[]; documents: Doc[]; agent: AgentStatus; default_mode: string; sandbox_password?: string }

const SUMMARY: [string, string][] = [
  ['what_theyre_looking_for', 'What they are looking for'],
  ['what_they_offer', 'What they offer'],
  ['who_can_apply', 'Who can apply'],
  ['how_to_apply', 'How the application works'],
  ['worth_noting', 'Worth noting'],
];

export function GrantDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, reload, setData } = useLoad<Detail>(() => api(`/grants/${id}`), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [show, setShow] = useState<'todo' | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  if (!data) return <Loading error={error} />;
  const { grant: g, questions, documents } = data;
  const due = dueLabel(g);
  const v = verification(g.questions_verification);
  const activeRun = data.runs.find((r) => ['queued', 'running', 'needs_human'].includes(r.status));
  const latestRun = data.runs[0];
  const suggested = questions.filter((q) => q.status === 'suggested').length;
  const todo = questions.filter((q) => q.status !== 'approved' && q.status !== 'skipped');
  const list = show === 'todo' ? todo : questions;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'That did not work', 'error'); } finally { setBusy(null); }
  }
  const patchGrant = (body: Record<string, unknown>, msg?: string) => run('patch', async () => { await api(`/grants/${g.id}`, { method: 'PATCH', body }); if (msg) toast(msg); await reload(); });
  const apply = (mode: 'test' | 'live' | 'scan') => run(mode, async () => {
    await api(`/grants/${g.id}/apply`, { body: { mode } });
    toast(mode === 'scan' ? 'The agent will read the live form.' : mode === 'live' ? 'The agent will fill in and submit the application.' : 'Test run started — the agent will fill the form and stop before submitting.');
    setConfirmLive(false);
    await reload();
  });
  const infer = () => run('infer', async () => {
    const r = await api<{ suggested: number; approved: number; reused: number; still_missing: number; errors: string[] }>('/infer', { body: { grant_id: g.id } });
    if (r.errors.length) toast(`AI problem: ${r.errors[0]}`, 'error');
    else toast(`Filled ${r.suggested + r.approved + r.reused} answer${r.suggested + r.approved + r.reused === 1 ? '' : 's'} from company knowledge. ${r.still_missing} still need new information.`);
    await reload();
  });
  const acceptAll = () => run('accept', async () => {
    const r = await api<{ accepted: number }>(`/grants/${g.id}/accept-suggestions`, { method: 'POST' });
    toast(`Confirmed ${r.accepted} suggested answer${r.accepted === 1 ? '' : 's'}.`);
    await reload();
  });

  function onQuestionChange(q: Question, info?: { reused: number }) {
    setData({ ...data!, questions: data!.questions.map((x) => (x.id === q.id ? q : x)) });
    if (info?.reused || q.type === 'file') reload(); else api<Detail>(`/grants/${g.id}`).then((d) => setData((cur) => (cur ? { ...cur, grant: d.grant } : cur))).catch(() => {});
  }

  async function addQuestion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run('add', async () => {
      await api(`/grants/${g.id}/questions`, { body: { text: f.get('text'), type: f.get('type'), section: f.get('section'), required: f.get('required') === 'on' } });
      setAdding(false);
      await reload();
    });
  }
  async function saveGrant(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    await patchGrant(body, 'Saved.');
    setEditing(false);
  }

  let lastSection = '';
  return (
    <div className="page">
      <Link to="/grants" className="back">← All grants</Link>
      <header className="page-head grant-head">
        <div>
          <h1>{g.title}</h1>
          <div className="head-meta">
            <span className={`due ${due.tone}`}>{due.text}</span>
            {g.rating && <span>· Fit rating {g.rating}</span>}
          </div>
          {g.amount && <div><b>Award:</b> {g.amount}</div>}
          {g.deadline_note && <div className="muted">{g.deadline_note}</div>}
          <div className="links">
            {g.program_url && <a href={g.program_url} target="_blank" rel="noreferrer">Program page ↗</a>}
            {g.application_url && <a href={g.application_url} target="_blank" rel="noreferrer">Application form ↗</a>}
            <button className="linkish" onClick={() => setEditing(true)}>Edit details</button>
          </div>
        </div>
        <div className="head-actions">
          <select value={g.pipeline} onChange={(e) => patchGrant({ pipeline: e.target.value }, 'Updated.')} aria-label="Pipeline status">
            <option value="active">Pursuing</option>
            <option value="submitted">Submitted</option>
            <option value="not_pursuing">Not pursuing</option>
          </select>
        </div>
      </header>

      {/* Apply */}
      <section className="panel apply">
        <div className="apply-left">
          <ProgressBar p={g.progress} />
          <div className="apply-status">{progressText(g)}</div>
          {g.progress.optional_open > 0 && <div className="muted small">{g.progress.optional_open} optional question{g.progress.optional_open > 1 ? 's' : ''} left blank.</div>}
          <label className="check">
            <input type="checkbox" checked={g.live_enabled} onChange={(e) => patchGrant({ live_enabled: e.target.checked }, e.target.checked ? 'Real submission is now allowed for this grant.' : 'Back to test-only.')} />
            <span>Allow real submission for this grant <span className="muted">(off = test mode only: the agent fills the form but never presses Submit)</span></span>
          </label>
        </div>
        <div className="apply-right">
          <button className="btn primary big" disabled={!!busy || !!activeRun || g.progress.done === 0 || !g.application_url} onClick={() => (g.live_enabled ? setConfirmLive(true) : apply('test'))}
            title={!g.application_url ? 'Add the application link first' : g.progress.done === 0 ? 'Approve some answers first' : ''}>
            {busy === 'test' || busy === 'live' ? 'Starting…' : g.live_enabled ? 'Apply' : 'Apply (test run)'}
          </button>
          {g.live_enabled && <button className="btn" disabled={!!busy || !!activeRun || g.progress.done === 0} onClick={() => apply('test')}>Test run only</button>}
          <button className="btn ghost" disabled={!!busy || !!activeRun || !(g.application_url || g.program_url)} onClick={() => apply('scan')} title="The agent opens the real form and reads its questions into the portal">Scan the live form</button>
          <div className="muted small">Browser agent: <b className={data.agent.online ? 'ok-text' : ''}>{data.agent.online ? 'online' : 'offline'}</b></div>
        </div>
      </section>

      {g.is_sandbox && data.sandbox_password && (
        <div className="callout">Practice login for the sandbox form: any email, password <code>{data.sandbox_password}</code>, and tick “I'm not a robot”. The agent will stop at that page and ask you to do it.</div>
      )}

      {latestRun && <RunPanel key={latestRun.id} runId={latestRun.id} onFinished={reload} />}

      {/* About */}
      <section className="panel">
        <h3>About this grant</h3>
        {g.summary.at_a_glance && <p className="lead">{g.summary.at_a_glance}</p>}
        <div className="about-grid">
          {SUMMARY.filter(([k]) => g.summary[k]).map(([k, label]) => (
            <div key={k} className={k === 'what_theyre_looking_for' ? 'about wide' : 'about'}>
              <h4>{label}</h4>
              <p>{g.summary[k]}</p>
            </div>
          ))}
        </div>
        {(g.portal?.platform || g.portal?.notes) && (
          <div className="portal-facts">
            {g.portal.platform && <Pill>{String(g.portal.platform)}</Pill>}
            {g.portal.requires_login === true && <Pill tone="warn">Login required</Pill>}
            {g.portal.may_have_captcha === true && <Pill tone="warn">CAPTCHA likely</Pill>}
            {g.portal.needs_file_uploads === true && <Pill tone="info">File uploads</Pill>}
            {g.portal.notes && <p className="muted small">{String(g.portal.notes)}</p>}
          </div>
        )}
      </section>

      {/* Questions */}
      <section>
        <div className="sec-head">
          <h2>Application questions <span className="muted">({questions.length})</span></h2>
          <div className="row">
            {suggested > 0 && <button className="btn" disabled={!!busy} onClick={acceptAll}>{busy === 'accept' ? 'Confirming…' : `Confirm all ${suggested} suggestions`}</button>}
            {todo.length > 0 && <button className="btn" disabled={!!busy} onClick={infer}>{busy === 'infer' ? <><span className="spinner" /> Checking…</> : '✨ Fill from company knowledge'}</button>}
          </div>
        </div>
        <div className={`verify ${v.tone}`}>
          <Pill tone={v.tone}>{v.label}</Pill>
          <span>
            {v.explain}{' '}
            {g.questions_verified_on && <>Checked {fmtDate(g.questions_verified_on)}. </>}
            {g.questions_source_url && <a href={g.questions_source_url} target="_blank" rel="noreferrer">Source ↗</a>}
          </span>
          {g.questions_note && <details><summary>How these questions were obtained</summary><p>{g.questions_note}</p></details>}
        </div>

        {questions.length > 0 && (
          <div className="tabs">
            <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>In form order <span className="count">{questions.length}</span></button>
            <button className={show === 'todo' ? 'on' : ''} onClick={() => setShow('todo')}>Still to do <span className="count">{todo.length}</span></button>
          </div>
        )}

        {questions.length === 0 ? (
          <div className="empty">
            <p><b>No questions loaded for this grant.</b></p>
            <p>{g.questions_verification === 'not_accessible' ? 'The real form is behind a login, so nothing was made up.' : 'Nothing verified yet.'} Use <b>Scan the live form</b> above — the agent opens the form, asks you to log in if needed, and reads the real questions in.</p>
          </div>
        ) : list.length === 0 ? (
          <div className="empty">Everything is answered. 🎉</div>
        ) : (
          <div className="stack">
            {list.map((q) => {
              const header = q.section && q.section !== lastSection ? <h3 className="section-title" key={`s-${q.id}`}>{q.section}</h3> : null;
              lastSection = q.section || lastSection;
              return (
                <div key={q.id}>
                  {header}
                  <QuestionCard q={q} number={q.position} documents={documents} onChange={onQuestionChange} onDocsChanged={reload}
                    onDelete={q.origin === 'manual' ? () => run('del', async () => { await api(`/questions/${q.id}`, { method: 'DELETE' }); await reload(); }) : undefined} />
                </div>
              );
            })}
          </div>
        )}
        <button className="btn ghost add-q" onClick={() => setAdding(true)}>+ Add a question by hand</button>
      </section>

      {data.runs.length > 1 && (
        <section className="panel">
          <h3>Earlier runs</h3>
          <ul className="runlist">
            {data.runs.slice(1).map((r) => <li key={r.id}>{r.mode} · {r.status.replace('_', ' ')} · {fmtDate(r.created_at)} {r.note && <span className="muted">— {r.note}</span>}</li>)}
          </ul>
        </section>
      )}

      {g.sources.length > 0 && (
        <details className="panel sources">
          <summary>Sources ({g.sources.length})</summary>
          <ul>{g.sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.url}</a>{s.note && <span className="muted"> — {s.note}</span>}</li>)}</ul>
        </details>
      )}

      {confirmLive && (
        <Modal title="Submit this application for real?" onClose={() => setConfirmLive(false)}>
          <p>The browser agent will open <b>{g.title}</b>, fill in {g.progress.done} approved answers and <b>press Submit</b>. This cannot be undone.</p>
          {!g.ready && <div className="error-box">{g.remaining} required question(s) are not answered yet, so a real submission is blocked. Run a test instead, or finish the answers.</div>}
          <div className="row">
            <button className="btn primary" disabled={!!busy || !g.ready} onClick={() => apply('live')}>Yes, fill in and submit</button>
            <button className="btn" disabled={!!busy} onClick={() => apply('test')}>Do a test run instead</button>
          </div>
        </Modal>
      )}
      {adding && (
        <Modal title="Add a question" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={addQuestion}>
            <label>Question, exactly as the form words it<textarea name="text" required autoFocus rows={3} /></label>
            <div className="row">
              <label>Type<select name="type" defaultValue="long_text">
                <option value="short_text">Short text</option><option value="long_text">Long text</option><option value="yes_no">Yes / No</option>
                <option value="number">Number</option><option value="url">Link</option><option value="date">Date</option><option value="file">File upload</option>
              </select></label>
              <label>Section (optional)<input name="section" /></label>
            </div>
            <label className="check"><input type="checkbox" name="required" defaultChecked /> <span>Required</span></label>
            <button className="btn primary" disabled={!!busy}>Add question</button>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title="Edit grant details" onClose={() => setEditing(false)}>
          <form className="form" onSubmit={saveGrant}>
            <label>Name<input name="title" defaultValue={g.title} required /></label>
            <label>Program page<input name="program_url" type="text" defaultValue={g.program_url ?? ''} /></label>
            <label>Application link (where the agent starts)<input name="application_url" type="text" defaultValue={g.application_url ?? ''} /></label>
            <div className="row">
              <label>Deadline<input name="deadline" type="date" defaultValue={g.deadline ?? ''} /></label>
              <label>Award<input name="amount" defaultValue={g.amount ?? ''} /></label>
            </div>
            <label>Deadline note<input name="deadline_note" defaultValue={g.deadline_note} /></label>
            <button className="btn primary" disabled={!!busy}>Save</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

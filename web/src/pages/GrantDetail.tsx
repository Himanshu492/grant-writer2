import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dueLabel, fmtDate, plain, type Doc, type Grant, type Question, type Run } from '../api';
import { openAgentDock } from '../components/AgentDock';
import { QuestionCard } from '../components/QuestionCard';
import { RunPanel } from '../components/RunPanel';
import { Loading, Modal, Pill, ProgressBar, progressText, useLoad, useToast, verification } from '../components/ui';

interface Detail { grant: Grant; questions: Question[]; runs: Run[]; documents: Doc[]; sandbox_password?: string }

const SUMMARY: [string, string][] = [
  ['what_theyre_looking_for', 'What they look for'],
  ['what_they_offer', 'What they offer'],
  ['who_can_apply', 'Who can apply'],
  ['how_to_apply', 'How to apply'],
  ['worth_noting', 'Worth noting'],
];

export function GrantDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, reload, setData } = useLoad<Detail>(() => api(`/grants/${id}`), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [show, setShow] = useState<'todo' | 'optional' | 'all'>('todo');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  if (!data) return <Loading error={error} />;
  const { grant: g, questions, documents } = data;
  const due = dueLabel(g);
  const v = verification(g.questions_verification);
  const activeRun = data.runs.find((r) => ['queued', 'running', 'needs_human'].includes(r.status));
  const suggested = questions.filter((q) => q.status === 'suggested').length;
  const applicable = questions.filter((q) => !q.not_applicable);
  const hidden = questions.length - applicable.length;
  const open = applicable.filter((q) => q.status !== 'approved' && q.status !== 'skipped');
  const todo = open.filter((q) => q.required !== false);
  const optional = open.filter((q) => q.required === false);
  const list = show === 'todo' ? todo : show === 'optional' ? optional : questions;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'That did not work', 'error'); } finally { setBusy(null); }
  }
  const patchGrant = (body: Record<string, unknown>) => run('patch', async () => { await api(`/grants/${g.id}`, { method: 'PATCH', body }); await reload(); });
  const apply = (mode: 'test' | 'live' | 'scan') => run(mode, async () => {
    await api(`/grants/${g.id}/apply`, { body: { mode } });
    setConfirmLive(false);
    openAgentDock();
    await reload();
  });
  const infer = () => run('infer', async () => {
    const r = await api<{ suggested: number; approved: number; reused: number; still_missing: number; errors: string[] }>('/infer', { body: { grant_id: g.id } });
    if (r.errors.length) toast(r.errors[0], 'error');
    else toast(`Filled ${r.suggested + r.approved + r.reused}. ${r.still_missing} still need you.`);
    await reload();
  });
  const acceptAll = () => run('accept', async () => {
    const r = await api<{ accepted: number }>(`/grants/${g.id}/accept-suggestions`, { method: 'POST' });
    toast(`Confirmed ${r.accepted}.`);
    await reload();
  });

  function onQuestionChange(q: Question, info?: { reused: number; revealed: number }) {
    setData({ ...data!, questions: data!.questions.map((x) => (x.id === q.id ? q : x)) });
    // The answer may have filled other questions, or decided that some now apply: refresh quietly.
    if (info?.reused || info?.revealed || q.type === 'file') reload();
    else api<Detail>(`/grants/${g.id}`).then((d) => setData((cur) => (cur ? { ...cur, grant: d.grant } : cur))).catch(() => {});
  }

  async function addQuestion(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run('add', async () => {
      await api(`/grants/${g.id}/questions`, { body: { text: f.get('text'), type: f.get('type'), required: f.get('required') === 'on' } });
      setAdding(false);
      await reload();
    });
  }
  async function saveGrant(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await patchGrant(Object.fromEntries(new FormData(e.currentTarget).entries()));
    setEditing(false);
  }

  const canRun = !busy && !activeRun && !!(g.application_url || g.program_url);
  const hasAbout = !!g.summary.at_a_glance || SUMMARY.some(([k]) => g.summary[k]);
  let lastSection = '';
  return (
    <div className="page">
      <Link to="/grants" className="back">All grants</Link>
      <header className="page-head">
        <div>
          <h1>{g.title}</h1>
          <div className="head-meta">
            <span className={`due ${due.tone}`}>{due.text}{g.deadline && g.days_left !== null && g.days_left >= 0 ? `, ${fmtDate(g.deadline)}` : ''}</span>
            {g.amount && <span className="muted">{g.amount}</span>}
            {g.application_url && <a href={g.application_url} target="_blank" rel="noreferrer">Application form</a>}
            {g.program_url && <a href={g.program_url} target="_blank" rel="noreferrer">Program page</a>}
            <button className="linkish" onClick={() => setEditing(true)}>Edit</button>
          </div>
        </div>
        <select value={g.pipeline} onChange={(e) => patchGrant({ pipeline: e.target.value })} aria-label="Status" style={{ width: 'auto' }}>
          <option value="active">Pursuing</option>
          <option value="submitted">Submitted</option>
          <option value="not_pursuing">Not pursuing</option>
        </select>
      </header>

      <section className="panel apply" style={{ marginTop: 0 }}>
        <div className="apply-left">
          <ProgressBar p={g.progress} />
          <b>{progressText(g)}</b>
          <label className="check small">
            <input type="checkbox" checked={g.live_enabled} onChange={(e) => patchGrant({ live_enabled: e.target.checked })} />
            <span>{g.live_enabled ? `Approved to submit by ${g.live_enabled_by ?? 'the team'}` : 'Approve for real submission'}</span>
          </label>
        </div>
        <div className="apply-right">
          <button className="btn quiet" disabled={!canRun} onClick={() => apply('scan')} title="The agent opens the real form and reads its questions in">Scan form</button>
          {g.live_enabled && <button className="btn" disabled={!canRun || g.progress.done === 0} onClick={() => apply('test')}>Test run</button>}
          <button className="btn primary big" disabled={!canRun || g.progress.done === 0 || !g.application_url} onClick={() => (g.live_enabled ? setConfirmLive(true) : apply('test'))}
            title={g.live_enabled ? 'Fill in and submit' : 'Fills the form and stops before Submit'}>
            {activeRun ? 'Agent working' : g.live_enabled ? 'Apply' : 'Apply (test)'}
          </button>
        </div>
      </section>

      {g.is_sandbox && data.sandbox_password && (
        <div className="callout" style={{ marginTop: 14 }}>Practice login: any email, password <code>{data.sandbox_password}</code>, tick the robot box.</div>
      )}

      {data.runs[0] && <section style={{ marginTop: 14 }}><RunPanel key={data.runs[0].id} runId={data.runs[0].id} onFinished={reload} /></section>}

      {hasAbout && (
        <section style={{ marginTop: 14 }}>
          <details className="panel fold">
            <summary>About this grant</summary>
            {g.summary.at_a_glance && <p>{plain(g.summary.at_a_glance)}</p>}
            <div className="about-grid">
              {SUMMARY.filter(([k]) => g.summary[k]).map(([k, label]) => (
                <div key={k} className={k === 'what_theyre_looking_for' ? 'about wide' : 'about'}>
                  <h4>{label}</h4>
                  <p>{plain(g.summary[k])}</p>
                </div>
              ))}
              {g.amount_detail && <div className="about wide"><h4>Award</h4><p>{plain(g.amount_detail)}</p></div>}
              {g.deadline_note && <div className="about wide"><h4>Deadline</h4><p>{plain(g.deadline_note)}</p></div>}
              {g.portal?.notes && <div className="about wide"><h4>Application portal</h4><p>{plain(String(g.portal.notes))}</p></div>}
            </div>
            {g.sources.length > 0 && (
              <div className="sources" style={{ marginTop: 14 }}>
                <h4>Sources</h4>
                <ul>{g.sources.slice(0, 12).map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.url}</a></li>)}</ul>
              </div>
            )}
          </details>
        </section>
      )}

      <section>
        <div className="sec-head">
          <div className="row">
            <h2>Questions</h2>
            <Pill tone={v.tone} title={plain(g.questions_note)}>{v.label}</Pill>
          </div>
          <div className="row">
            {suggested > 0 && <button className="btn" disabled={!!busy} onClick={acceptAll}>{busy === 'accept' ? 'Confirming' : 'Confirm all'}</button>}
            {open.length > 0 && <button className="btn" disabled={!!busy} onClick={infer}>{busy === 'infer' ? <><span className="spinner" /> Filling</> : 'Fill from knowledge'}</button>}
          </div>
        </div>

        {questions.length === 0 ? (
          <div className="empty">
            {g.questions_verification === 'not_accessible' ? 'This form is behind a login, so its questions have not been read yet.' : 'No questions yet.'}
            <div style={{ marginTop: 12 }}><button className="btn primary" disabled={!canRun} onClick={() => apply('scan')}>Scan the form</button></div>
          </div>
        ) : (
          <>
            <div className="tabs">
              <button className={show === 'todo' ? 'on' : ''} onClick={() => setShow('todo')}>To do<span className="count">{todo.length}</span></button>
              {optional.length > 0 && <button className={show === 'optional' ? 'on' : ''} onClick={() => setShow('optional')}>Optional<span className="count">{optional.length}</span></button>}
              <button className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All<span className="count">{questions.length}</span></button>
            </div>
            {list.length === 0 ? <div className="empty">{show === 'todo' ? 'Every required question is answered.' : 'Nothing here.'}</div> : (
              <div className="stack">
                {list.map((q) => {
                  const header = q.section && q.section !== lastSection ? <h3 className="section-title">{q.section}</h3> : null;
                  lastSection = q.section || lastSection;
                  return (
                    <div key={q.id}>
                      {header}
                      <QuestionCard q={{ ...q, section: '' }} documents={documents} onChange={onQuestionChange} onDocsChanged={reload}
                        onDelete={q.origin === 'manual' ? () => run('del', async () => { await api(`/questions/${q.id}`, { method: 'DELETE' }); await reload(); }) : undefined} />
                    </div>
                  );
                })}
              </div>
            )}
            {show !== 'all' && hidden > 0 && <p className="muted small" style={{ marginTop: 12 }}>{hidden} question{hidden > 1 ? 's' : ''} hidden because they do not apply to your answers.</p>}
          </>
        )}
        <button className="btn quiet" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>Add a question</button>
      </section>

      {confirmLive && (
        <Modal title="Submit for real?" onClose={() => setConfirmLive(false)}>
          <p>The agent will fill in <b>{g.title}</b> and press Submit. This cannot be undone.</p>
          {!g.ready && <div className="error-box" style={{ marginBottom: 12 }}>{g.remaining} required question{g.remaining > 1 ? 's are' : ' is'} not answered yet.</div>}
          <div className="row">
            <button className="btn primary" disabled={!!busy || !g.ready} onClick={() => apply('live')}>Submit</button>
            <button className="btn" disabled={!!busy} onClick={() => apply('test')}>Test run instead</button>
          </div>
        </Modal>
      )}
      {adding && (
        <Modal title="Add a question" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={addQuestion}>
            <label>Question<textarea name="text" required autoFocus rows={3} /></label>
            <label>Type<select name="type" defaultValue="long_text">
              <option value="short_text">Short text</option><option value="long_text">Long text</option><option value="yes_no">Yes or No</option>
              <option value="number">Number</option><option value="url">Link</option><option value="date">Date</option><option value="file">File upload</option>
            </select></label>
            <label className="check"><input type="checkbox" name="required" defaultChecked /> <span>Required</span></label>
            <button className="btn primary" disabled={!!busy}>Add</button>
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title="Edit grant" onClose={() => setEditing(false)}>
          <form className="form" onSubmit={saveGrant}>
            <label>Name<input name="title" defaultValue={g.title} required /></label>
            <label>Application link<input name="application_url" type="text" defaultValue={g.application_url ?? ''} /></label>
            <label>Program page<input name="program_url" type="text" defaultValue={g.program_url ?? ''} /></label>
            <div className="row">
              <label>Deadline<input name="deadline" type="date" defaultValue={g.deadline ?? ''} /></label>
              <label>Award<input name="amount" defaultValue={g.amount ?? ''} /></label>
            </div>
            <button className="btn primary" disabled={!!busy}>Save</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

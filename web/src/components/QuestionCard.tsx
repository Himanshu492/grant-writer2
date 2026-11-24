import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, conditionText, DOC_KIND_LABELS, plain, splitHelp, type Doc, type Question } from '../api';
import { Pill, useToast } from './ui';

const STATUS: Record<Question['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' }> = {
  empty: { label: 'Needs your input', tone: 'danger' },
  draft: { label: 'Draft', tone: 'warn' },
  suggested: { label: 'Confirm', tone: 'info' },
  approved: { label: 'Answered', tone: 'ok' },
  skipped: { label: 'Skipped', tone: 'muted' },
};

const SHORT = new Set(['short_text', 'number', 'date', 'url', 'email', 'phone']);

function count(text: string, unit: string) {
  if (unit === 'words') return text.trim() ? text.trim().split(/\s+/).length : 0;
  return text.length;
}

interface Props {
  q: Question;
  documents?: Doc[];
  /** Every grant that asks this same question (dashboard and Questions page). */
  alsoAskedBy?: { id: string; title: string }[];
  showGrant?: boolean;
  onChange: (q: Question, info?: { reused: number; revealed: number }) => void;
  onDelete?: () => void;
  onDocsChanged?: () => void;
}

export function QuestionCard({ q, documents, alsoAskedBy, showGrant, onChange, onDelete, onDocsChanged }: Props) {
  const toast = useToast();
  const [text, setText] = useState(q.answer);
  const [editing, setEditing] = useState(q.status !== 'approved' && q.status !== 'skipped');
  const [busy, setBusy] = useState<string | null>(null);
  const [guidance, setGuidance] = useState('');
  const [showGuidance, setShowGuidance] = useState(false);
  const [more, setMore] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(q.answer);
    setEditing(q.status !== 'approved' && q.status !== 'skipped');
  }, [q.id, q.answer, q.status]);

  const st = STATUS[q.status];
  const isFile = q.type === 'file';
  const dirty = text !== q.answer;
  const over = q.limit && q.limit.unit !== 'pages' ? count(text, q.limit.unit) > q.limit.max : false;
  const help = splitHelp(q.help);
  const hasMore = help.text.length > 110 || help.notes.length > 0;
  const others = (alsoAskedBy ?? []).filter((g) => g.id !== q.grant_id);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const res = await api<{ question: Question; reused: number; revealed: number }>(`/questions/${q.id}`, { method: 'PATCH', body });
      onChange({ ...q, ...res.question }, { reused: res.reused, revealed: res.revealed });
      if (res.reused > 0) toast(`Saved. Filled the same question on ${res.reused} other grant${res.reused > 1 ? 's' : ''}.`);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (over) return toast(`Over the ${q.limit!.max} ${q.limit!.unit} limit.`, 'error');
    await patch({ answer: text, status: 'approved' }, 'approve');
  }

  async function draft() {
    setBusy('draft');
    try {
      const res = await api<{ question: Question; drafted: boolean; missing: string[] }>(`/questions/${q.id}/draft`, { body: { guidance } });
      onChange({ ...q, ...res.question });
      setShowGuidance(false);
      if (!res.drafted) toast('Not enough company knowledge to draft this yet.', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Draft failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setBusy('upload');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('kind', q.doc_kind ?? 'other');
      form.set('question_id', q.id);
      const res = await api<{ id: string; linked: number }>('/documents', { form });
      onChange({ ...q, document_id: res.id, status: 'approved' });
      onDocsChanged?.();
      toast(res.linked > 0 ? `Uploaded. Also attached to ${res.linked} other question${res.linked > 1 ? 's' : ''}.` : 'Uploaded.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  // Not on this company's form (depends on another answer): one quiet line, nothing to do.
  if (q.not_applicable) {
    return (
      <div className="na-line">
        <span className="clamp1">{q.text}</span>
        <span>{q.show_if ? conditionText(q.show_if) : 'Not applicable'}</span>
      </div>
    );
  }

  const doc = documents?.find((d) => d.id === q.document_id);
  let field;
  if (isFile) {
    field = q.document_id ? (
      <div className="file-attached">
        <span>{doc ? doc.label || doc.filename : 'Document attached'}</span>
        <a className="btn quiet small" href={`/api/documents/${q.document_id}/download`} target="_blank" rel="noreferrer">View</a>
        <button className="btn quiet small" onClick={() => patch({ document_id: null }, 'detach')}>Remove</button>
      </div>
    ) : (
      <div className="file-field">
        <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>{busy === 'upload' ? 'Uploading…' : 'Upload file'}</button>
        {documents && documents.length > 0 && (
          <select defaultValue="" onChange={(e) => e.target.value && patch({ document_id: e.target.value }, 'attach')} aria-label="Use a document already uploaded">
            <option value="">Or use an uploaded document</option>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.label || d.filename} ({DOC_KIND_LABELS[d.kind] ?? d.kind})</option>)}
          </select>
        )}
      </div>
    );
  } else if (!editing) {
    field = <div className={`answer-read ${q.status === 'skipped' ? 'muted' : ''}`}>{q.status === 'skipped' ? 'Left blank' : q.answer}</div>;
  } else if ((q.type === 'single_select' || q.type === 'yes_no') && (q.options.length > 0 || q.type === 'yes_no')) {
    const options = q.options.length ? q.options : ['Yes', 'No'];
    field = options.length <= 5 ? (
      <div className="options">
        {options.map((o) => (
          <label key={o} className={`opt ${text === o ? 'on' : ''}`}>
            <input type="radio" name={q.id} checked={text === o} onChange={() => setText(o)} /> {o}
          </label>
        ))}
      </div>
    ) : (
      <select value={options.includes(text) ? text : ''} onChange={(e) => setText(e.target.value)}>
        <option value="">Choose</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  } else if (q.type === 'multi_select' && q.options.length > 0) {
    const chosen = new Set(text.split(';').map((s) => s.trim()).filter(Boolean));
    field = (
      <div className="options">
        {q.options.map((o) => (
          <label key={o} className={`opt ${chosen.has(o) ? 'on' : ''}`}>
            <input type="checkbox" checked={chosen.has(o)} onChange={() => {
              const next = new Set(chosen);
              next.has(o) ? next.delete(o) : next.add(o);
              setText(q.options.filter((x) => next.has(x)).join('; '));
            }} /> {o}
          </label>
        ))}
      </div>
    );
  } else if (SHORT.has(q.type) || q.type === 'single_select') {
    field = <input className={q.type === 'short_text' || q.type === 'url' || q.type === 'email' ? '' : 'short'} type="text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && approve()} />;
  } else {
    field = (
      <textarea value={text} rows={Math.min(12, Math.max(3, Math.ceil(text.length / 90) + 1))} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim() && approve()} />
    );
  }

  const optional = q.required === false;
  return (
    <div className={`qcard status-${q.status}`}>
      <div className="q-meta">
        <span className="clamp1">
          {showGrant && q.grant_title ? <Link to={`/grants/${q.grant_id}`}>{q.grant_title}</Link> : q.section || null}
          {others.length > 0 && <span title={others.map((g) => g.title).join(', ')}>{showGrant ? ' and ' : ''}{others.length} other grant{others.length > 1 ? 's' : ''}</span>}
          {optional && <span>{(showGrant && q.grant_title) || q.section || others.length ? ' · ' : ''}Optional</span>}
        </span>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>
      <div className="q-text">{q.text}</div>
      {help.text && <div className={`q-help ${more ? '' : 'closed'}`}>{help.text}</div>}
      {more && help.notes.map((n, i) => <div key={i} className="q-help">{n}</div>)}
      {more && q.show_if && <div className="q-help">{conditionText(q.show_if)}</div>}
      {hasMore && <button className="linkish q-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}

      <div className="q-field">{field}</div>

      {q.status === 'suggested' && q.basis && <div className="q-note clamp1">From your knowledge: {plain(q.basis)}</div>}
      {q.missing_info && (q.status === 'empty' || q.status === 'draft') && <div className="q-note needed">Needed: {plain(q.missing_info)}</div>}

      {showGuidance && (
        <div className="guidance">
          <input type="text" autoFocus value={guidance} placeholder="Anything to emphasise? (optional)" onChange={(e) => setGuidance(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && draft()} />
          <button className="btn" disabled={!!busy} onClick={draft}>{busy === 'draft' ? 'Writing…' : 'Write'}</button>
        </div>
      )}

      <div className="q-actions">
        {isFile ? (
          <>
            {!q.document_id && q.status !== 'skipped' && <button className="btn quiet" onClick={() => patch({ status: 'skipped' }, 'skip')}>Skip</button>}
            {q.status === 'skipped' && <button className="btn quiet" onClick={() => patch({ status: 'empty' }, 'unskip')}>Undo skip</button>}
          </>
        ) : editing ? (
          <>
            <button className="btn primary" disabled={!!busy || !text.trim()} onClick={approve}>
              {busy === 'approve' ? 'Saving…' : q.status === 'suggested' && !dirty ? 'Confirm' : 'Save'}
            </button>
            {q.type === 'long_text' && q.options.length === 0 && (
              <button className="btn" disabled={!!busy} onClick={() => (showGuidance || !text.trim() ? draft() : setShowGuidance(true))}>
                {busy === 'draft' ? <><span className="spinner" /> Drafting</> : text.trim() ? 'Redraft with AI' : 'Draft with AI'}
              </button>
            )}
            {q.status === 'approved' && <button className="btn quiet" onClick={() => { setText(q.answer); setEditing(false); }}>Cancel</button>}
            {q.status !== 'approved' && <button className="btn quiet" disabled={!!busy} onClick={() => patch({ status: 'skipped' }, 'skip')}>Skip</button>}
          </>
        ) : (
          <button className="btn quiet" onClick={() => (q.status === 'skipped' ? patch({ status: 'empty' }, 'unskip') : setEditing(true))}>{q.status === 'skipped' ? 'Undo skip' : 'Edit'}</button>
        )}
        <span className="spacer" />
        {q.limit && q.limit.unit !== 'pages' && editing && !isFile && (
          <span className={`counter ${over ? 'over' : ''}`}>{count(text, q.limit.unit)} / {q.limit.max} {q.limit.unit}</span>
        )}
        {onDelete && <button className="btn quiet small danger-text" onClick={onDelete}>Remove</button>}
      </div>
    </div>
  );
}

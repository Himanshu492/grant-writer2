import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, DOC_KIND_LABELS, type Doc, type Question } from '../api';
import { Pill, useToast } from './ui';

const STATUS: Record<Question['status'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' | 'accent' }> = {
  empty: { label: 'Needs your input', tone: 'danger' },
  draft: { label: 'Draft — not approved', tone: 'warn' },
  suggested: { label: 'Suggested — confirm', tone: 'accent' },
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
  /** Other grants that ask the same thing (dashboard / questions view). */
  alsoAskedBy?: { id: string; title: string }[];
  showGrant?: boolean;
  number?: number;
  onChange: (q: Question, info?: { reused: number }) => void;
  onDelete?: () => void;
  onDocsChanged?: () => void;
}

export function QuestionCard({ q, documents, alsoAskedBy, showGrant, number, onChange, onDelete, onDocsChanged }: Props) {
  const toast = useToast();
  const [text, setText] = useState(q.answer);
  const [editing, setEditing] = useState(q.status !== 'approved' && q.status !== 'skipped');
  const [busy, setBusy] = useState<string | null>(null);
  const [guidance, setGuidance] = useState('');
  const [showGuidance, setShowGuidance] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(q.answer);
    setEditing(q.status !== 'approved' && q.status !== 'skipped');
  }, [q.id, q.answer, q.status]);

  const st = STATUS[q.status];
  const isFile = q.type === 'file';
  const dirty = text !== q.answer;
  const over = q.limit && q.limit.unit !== 'pages' ? count(text, q.limit.unit) > q.limit.max : false;

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label);
    try {
      const res = await api<{ question: Question; reused: number }>(`/questions/${q.id}`, { method: 'PATCH', body });
      onChange({ ...q, ...res.question }, { reused: res.reused });
      if (res.reused > 0) toast(`Saved. The same question on ${res.reused} other grant${res.reused > 1 ? 's' : ''} was filled in too.`);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (over) return toast(`This is over the ${q.limit!.max} ${q.limit!.unit} limit — shorten it first.`, 'error');
    await patch({ answer: text, status: 'approved' }, 'approve');
  }

  async function draft() {
    setBusy('draft');
    try {
      const res = await api<{ question: Question; drafted: boolean; missing: string[] }>(`/questions/${q.id}/draft`, { body: { guidance } });
      onChange({ ...q, ...res.question });
      setShowGuidance(false);
      if (!res.drafted) toast('The knowledge base does not have this yet — it needs your input.', 'error');
      else if (res.missing.length) toast(`Draft written. ${res.missing.length} fact${res.missing.length > 1 ? 's are' : ' is'} missing — see the note under the answer.`);
      else toast('Draft written — review it, then approve.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'AI draft failed', 'error');
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
      toast(res.linked > 0 ? `Uploaded. It was also attached to ${res.linked} other question${res.linked > 1 ? 's' : ''} asking for the same document.` : 'Uploaded and attached.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  const doc = documents?.find((d) => d.id === q.document_id);
  const optional = q.required === false;

  let field;
  if (isFile) {
    field = (
      <div className="file-field">
        {q.document_id ? (
          <div className="file-attached">
            <span>📎 {doc ? doc.label || doc.filename : 'Document attached'}</span>
            <a className="btn ghost small" href={`/api/documents/${q.document_id}/download`} target="_blank" rel="noreferrer">View</a>
            <button className="btn ghost small" onClick={() => patch({ document_id: null }, 'detach')}>Remove</button>
          </div>
        ) : (
          <>
            {documents && documents.length > 0 && (
              <select defaultValue="" onChange={(e) => e.target.value && patch({ document_id: e.target.value }, 'attach')} aria-label="Choose an uploaded document">
                <option value="">Use a document already uploaded…</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>{d.label || d.filename} ({DOC_KIND_LABELS[d.kind] ?? d.kind})</option>
                ))}
              </select>
            )}
            <input ref={fileRef} type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === 'upload' ? 'Uploading…' : `Upload ${q.doc_kind && q.doc_kind !== 'other' ? (DOC_KIND_LABELS[q.doc_kind] ?? 'file').toLowerCase() : 'file'}`}
            </button>
          </>
        )}
      </div>
    );
  } else if (!editing) {
    field = <div className={`answer-read ${q.status === 'skipped' ? 'muted' : ''}`}>{q.status === 'skipped' ? 'Skipped — will be left blank.' : q.answer}</div>;
  } else if ((q.type === 'single_select' || q.type === 'yes_no') && (q.options.length > 0 || q.type === 'yes_no')) {
    const options = q.options.length ? q.options : ['Yes', 'No'];
    field = options.length <= 6 ? (
      <div className="options">
        {options.map((o) => (
          <label key={o} className={`opt ${text === o ? 'on' : ''}`}>
            <input type="radio" name={q.id} checked={text === o} onChange={() => setText(o)} /> {o}
          </label>
        ))}
      </div>
    ) : (
      <select value={options.includes(text) ? text : ''} onChange={(e) => setText(e.target.value)}>
        <option value="">Choose…</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  } else if (q.type === 'multi_select' && q.options.length > 0) {
    const chosen = new Set(text.split(';').map((s) => s.trim()).filter(Boolean));
    field = (
      <div className="options">
        {q.options.map((o) => (
          <label key={o} className={`opt ${chosen.has(o) ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={chosen.has(o)}
              onChange={() => {
                const next = new Set(chosen);
                next.has(o) ? next.delete(o) : next.add(o);
                setText(q.options.filter((x) => next.has(x)).join('; '));
              }}
            /> {o}
          </label>
        ))}
      </div>
    );
  } else if (SHORT.has(q.type)) {
    field = <input type="text" value={text} placeholder="Type the answer…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && approve()} />;
  } else {
    const rows = Math.min(14, Math.max(3, Math.ceil(text.length / 90) + 1));
    field = (
      <textarea
        value={text}
        rows={rows}
        placeholder="Type the answer, or let AI draft it from what the company has already told us…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim() && approve()}
      />
    );
  }

  return (
    <div className={`qcard status-${q.status}`}>
      <div className="q-meta">
        <span className="q-tags">
          {number !== undefined && <span className="q-num">Q{number}</span>}
          {showGrant && q.grant_title && <Link to={`/grants/${q.grant_id}`} className="q-grant">{q.grant_title}</Link>}
          {optional ? <span className="tag">Optional</span> : q.required === true ? <span className="tag">Required</span> : null}
          {q.limit && <span className="tag">Max {q.limit.max} {q.limit.unit}</span>}
          {q.origin === 'agent_scan' && <span className="tag" title="The browser agent found this field on the live form">Found on live form</span>}
        </span>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>
      <div className="q-text">{q.text}</div>
      {q.help && <div className="q-help">{q.help}</div>}
      {alsoAskedBy && alsoAskedBy.length > 1 && (
        <div className="q-also">Answer once — fills {alsoAskedBy.length} grants: {alsoAskedBy.map((g) => g.title).join(', ')}</div>
      )}

      <div className="q-field">{field}</div>

      {q.status === 'suggested' && q.basis && <div className="q-note accent">Filled from what you already told us · {q.basis}</div>}
      {q.status === 'draft' && q.answer_origin === 'ai_draft' && <div className="q-note">AI draft{q.basis ? ` · based on ${q.basis}` : ''} — check it before approving.</div>}
      {q.missing_info && q.status !== 'approved' && q.status !== 'skipped' && <div className="q-note warn"><b>Still needed from you:</b> {q.missing_info}</div>}

      {showGuidance && (
        <div className="guidance">
          <input type="text" autoFocus value={guidance} placeholder="Optional: tell the AI what to emphasise (e.g. 'focus on the clinic pilot')" onChange={(e) => setGuidance(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && draft()} />
          <button className="btn" disabled={!!busy} onClick={draft}>{busy === 'draft' ? 'Writing…' : 'Write draft'}</button>
        </div>
      )}

      {!isFile && (
        <div className="q-actions">
          {editing ? (
            <>
              <button className="btn primary" disabled={!!busy || !text.trim()} onClick={approve}>
                {busy === 'approve' ? 'Saving…' : q.status === 'suggested' && !dirty ? 'Confirm' : 'Save answer'}
              </button>
              <button className="btn" disabled={!!busy} onClick={() => (showGuidance || !text.trim() ? draft() : setShowGuidance(true))} title="Write a draft from the company knowledge base, tailored to this funder">
                {busy === 'draft' ? <><span className="spinner" /> Drafting…</> : text.trim() ? '✨ Redraft with AI' : '✨ Draft with AI'}
              </button>
              {dirty && text.trim() && q.status !== 'approved' && <button className="btn ghost" disabled={!!busy} onClick={() => patch({ answer: text }, 'save')}>Save as draft</button>}
              {q.status === 'approved' || (q.answer && dirty) ? <button className="btn ghost" onClick={() => { setText(q.answer); setEditing(q.status !== 'approved'); }}>Cancel</button> : null}
              {q.status !== 'approved' && <button className="btn ghost" disabled={!!busy} onClick={() => patch({ status: 'skipped' }, 'skip')} title="Leave this field blank on the application">Skip</button>}
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => (q.status === 'skipped' ? patch({ status: 'empty' }, 'unskip') : setEditing(true))}>{q.status === 'skipped' ? 'Answer it after all' : 'Edit'}</button>
              {q.updated_by && <span className="q-by">{q.answer_origin === 'reused' ? 'Reused from another grant' : q.answer_origin === 'inferred' ? 'From knowledge base' : `by ${q.updated_by}`}</span>}
            </>
          )}
          <span className="spacer" />
          {q.limit && q.limit.unit !== 'pages' && editing && (
            <span className={`counter ${over ? 'over' : ''}`}>{count(text, q.limit.unit)} / {q.limit.max} {q.limit.unit}</span>
          )}
          {onDelete && <button className="btn ghost small danger-text" onClick={onDelete} title="Remove this question from the grant">Remove</button>}
        </div>
      )}
      {isFile && (
        <div className="q-actions">
          {!q.document_id && q.status !== 'skipped' && <button className="btn ghost" onClick={() => patch({ status: 'skipped' }, 'skip')}>Skip</button>}
          {q.status === 'skipped' && <button className="btn ghost" onClick={() => patch({ status: 'empty' }, 'unskip')}>Attach after all</button>}
          <span className="spacer" />
          {onDelete && <button className="btn ghost small danger-text" onClick={onDelete}>Remove</button>}
        </div>
      )}
    </div>
  );
}

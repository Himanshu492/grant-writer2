import { useRef, useState } from 'react';
import { api, DOC_KIND_LABELS, fmtDate, type Doc } from '../api';
import { Loading, useLoad, useToast } from '../components/ui';

function size(n: number) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function Documents() {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ documents: Doc[]; kinds: string[]; wanted: { doc_kind: string; n: number }[] }>(() => api('/documents'));
  const [kind, setKind] = useState('pitch_deck');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (!data) return <Loading error={error} />;

  async function upload(files: FileList | File[], k = kind) {
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set('file', file);
        form.set('kind', k);
        const res = await api<{ linked: number }>('/documents', { form });
        toast(res.linked ? `Uploaded ${file.name} and attached it to ${res.linked} question${res.linked > 1 ? 's' : ''} that ask for it.` : `Uploaded ${file.name}.`);
      }
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  const wanted = data.wanted.filter((w) => w.doc_kind && w.doc_kind !== 'other');
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Documents</h1>
          <p className="muted">Upload a file once. Any grant that asks for that kind of document uses it automatically, and the browser agent attaches it when applying.</p>
        </div>
      </header>

      {wanted.length > 0 && (
        <div className="callout">
          <b>Grants are asking for:</b>{' '}
          {wanted.map((w) => (
            <button key={w.doc_kind} className="chip" onClick={() => { setKind(w.doc_kind); input.current?.click(); }}>
              {DOC_KIND_LABELS[w.doc_kind] ?? w.doc_kind} · {w.n} question{w.n > 1 ? 's' : ''} — upload
            </button>
          ))}
        </div>
      )}

      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
      >
        <input ref={input} type="file" hidden multiple onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
        <label>This is a <select value={kind} onChange={(e) => setKind(e.target.value)}>{data.kinds.map((k) => <option key={k} value={k}>{DOC_KIND_LABELS[k] ?? k}</option>)}</select></label>
        <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Choose file'}</button>
        <span className="muted">or drop files here</span>
      </div>

      {data.documents.length === 0 ? <div className="empty">No documents yet.</div> : (
        <div className="table">
          {data.documents.map((d) => (
            <div key={d.id} className="trow">
              <div className="grow">
                <div className="fact-title">📎 {d.label || d.filename}</div>
                <div className="muted small">{d.filename} · {size(d.size)} · uploaded {fmtDate(d.uploaded_at)} · used by {d.used_by ?? 0} question{d.used_by === 1 ? '' : 's'}</div>
              </div>
              <select value={d.kind} aria-label="Document type" onChange={async (e) => { await api(`/documents/${d.id}`, { method: 'PATCH', body: { kind: e.target.value } }); reload(); }}>
                {data.kinds.map((k) => <option key={k} value={k}>{DOC_KIND_LABELS[k] ?? k}</option>)}
              </select>
              <a className="btn ghost small" href={`/api/documents/${d.id}/download`} target="_blank" rel="noreferrer">View</a>
              <button className="btn ghost small danger-text" onClick={async () => { if (confirm(`Delete ${d.filename}? Questions using it will need a new file.`)) { await api(`/documents/${d.id}`, { method: 'DELETE' }); reload(); } }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

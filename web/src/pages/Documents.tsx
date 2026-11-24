import { useRef, useState } from 'react';
import { api, DOC_KIND_LABELS, type Doc } from '../api';
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

  async function upload(files: FileList | File[]) {
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set('file', file);
        form.set('kind', kind);
        const res = await api<{ linked: number }>('/documents', { form });
        toast(res.linked ? `Uploaded. Attached to ${res.linked} question${res.linked > 1 ? 's' : ''}.` : 'Uploaded.');
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
      <header className="page-head"><h1>Documents</h1></header>

      {wanted.length > 0 && (
        <p className="muted">
          Grants are asking for:{' '}
          {wanted.map((w) => <button key={w.doc_kind} className="chip" onClick={() => { setKind(w.doc_kind); input.current?.click(); }}>{DOC_KIND_LABELS[w.doc_kind] ?? w.doc_kind}</button>)}
        </p>
      )}

      <div className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}>
        <input ref={input} type="file" hidden multiple onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Document type">{data.kinds.map((k) => <option key={k} value={k}>{DOC_KIND_LABELS[k] ?? k}</option>)}</select>
        <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading' : 'Upload'}</button>
        <span className="muted">or drop a file here</span>
      </div>

      {data.documents.length === 0 ? <div className="empty">No documents yet.</div> : (
        <div className="table">
          {data.documents.map((d) => (
            <div key={d.id} className="trow">
              <div className="grow">
                <div className="fact-title">{d.label || d.filename}</div>
                <div className="muted small">{size(d.size)} · used by {d.used_by ?? 0} question{d.used_by === 1 ? '' : 's'}</div>
              </div>
              <select value={d.kind} aria-label="Document type" onChange={async (e) => { await api(`/documents/${d.id}`, { method: 'PATCH', body: { kind: e.target.value } }); reload(); }}>
                {data.kinds.map((k) => <option key={k} value={k}>{DOC_KIND_LABELS[k] ?? k}</option>)}
              </select>
              <a className="btn quiet small" href={`/api/documents/${d.id}/download`} target="_blank" rel="noreferrer">View</a>
              <button className="btn quiet small danger-text" onClick={async () => { if (confirm(`Delete ${d.filename}?`)) { await api(`/documents/${d.id}`, { method: 'DELETE' }); reload(); } }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

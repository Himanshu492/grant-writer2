import { useState } from 'react';
import { api, fmtAgo, type AgentStatus } from '../api';
import { Loading, Pill, useLoad, useToast } from '../components/ui';

interface S {
  default_mode: string; auto_approve_facts: boolean; kb_version: number; agent: AgentStatus; legacy_available: boolean;
  ai_configured: boolean; agent_configured: boolean; seed_grants: number; sandbox_submissions: { id: number; at: string; payload_json: string }[];
}

export function Settings() {
  const toast = useToast();
  const { data, error, reload } = useLoad<S>(() => api('/settings'));
  const [busy, setBusy] = useState<string | null>(null);
  if (!data) return <Loading error={error} />;

  async function act(label: string, fn: () => Promise<string>) {
    setBusy(label);
    try { toast(await fn()); reload(); } catch (e) { toast(e instanceof Error ? e.message : 'That did not work', 'error'); } finally { setBusy(null); }
  }

  return (
    <div className="page narrow">
      <header className="page-head"><div><h1>Settings</h1></div></header>

      <section className="panel">
        <h3>Answering</h3>
        <label className="check">
          <input type="checkbox" checked={data.auto_approve_facts} onChange={(e) => act('auto', async () => { await api('/settings', { method: 'PATCH', body: { auto_approve_facts: e.target.checked } }); return 'Saved.'; })} />
          <span>Approve short factual answers automatically when the knowledge base states them directly <span className="muted">(names, dates, links, yes/no). Off = everything the AI fills in waits for a one-click confirm.</span></span>
        </label>
        <p className="muted small">AI drafting: {data.ai_configured ? 'connected (DeepSeek)' : 'not configured — set the DEEPSEEK_API_KEY secret'}.</p>
      </section>

      <section className="panel">
        <div className="sec-head"><h3>Browser agent</h3><Pill tone={data.agent.online ? 'ok' : 'muted'}>{data.agent.online ? 'Online' : 'Offline'}</Pill></div>
        <p className="muted">Last seen {fmtAgo(data.agent.last_seen)}{data.agent.info?.hostname ? ` on ${data.agent.info.hostname}` : ''}{data.agent.info?.version ? ` · runner ${data.agent.info.version}` : ''}{data.agent.info?.hermes ? ` · ${data.agent.info.hermes}` : ''}.</p>
        <p className="muted small">Every grant starts in test mode: the agent fills the form and stops before Submit. Real submission is switched on per grant, on the grant's page.</p>
        {!data.agent_configured && <div className="error-box">The AGENT_TOKEN secret is not set, so the VM runner cannot connect.</div>}
      </section>

      <section className="panel">
        <h3>Data</h3>
        <div className="row">
          <button className="btn" disabled={!!busy} onClick={() => act('seed', async () => { const r = await api<{ result: Record<string, string> }>('/admin/seed', { method: 'POST' }); const v = Object.values(r.result); return `Verified grant data applied: ${v.filter((x) => x === 'created').length} added, ${v.filter((x) => x === 'updated').length} updated, ${v.filter((x) => x === 'unchanged').length} unchanged.`; })}>
            {busy === 'seed' ? 'Applying…' : `Re-apply verified grant data (${data.seed_grants} grants)`}
          </button>
          {data.legacy_available && (
            <button className="btn" disabled={!!busy} onClick={() => act('legacy', async () => { const r = await api<{ imported: Record<string, number> }>('/admin/import-legacy', { method: 'POST' }); return `Imported from the old system: ${r.imported.grants} grants, ${r.imported.knowledge} knowledge entries, ${r.imported.documents} documents.`; })}>
              {busy === 'legacy' ? 'Importing…' : 'Import from the old system'}
            </button>
          )}
        </div>
        <p className="muted small">Knowledge base version {data.kb_version}. Open questions are re-checked against it every five minutes.</p>
      </section>

      {data.sandbox_submissions.length > 0 && (
        <section className="panel">
          <h3>Practice form submissions</h3>
          <p className="muted small">What the sandbox form received — use it to check exactly what the agent typed.</p>
          {data.sandbox_submissions.map((s) => (
            <details key={s.id}><summary>{fmtAgo(s.at)}</summary><pre>{JSON.stringify(JSON.parse(s.payload_json), null, 2)}</pre></details>
          ))}
        </section>
      )}
    </div>
  );
}

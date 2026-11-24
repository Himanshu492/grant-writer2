import { useState, type FormEvent } from 'react';
import { api, fmtAgo, type AgentStatus } from '../api';
import { Loading, Pill, useLoad, useToast } from '../components/ui';

interface S {
  auto_approve_facts: boolean; agent_engine: string; agent: AgentStatus; legacy_available: boolean; ai_configured: boolean;
  seed_grants: number; sandbox_submissions: { id: number; at: string; payload_json: string }[]; people: string[]; me: string;
}

export function Settings() {
  const toast = useToast();
  const { data, error, reload } = useLoad<S>(() => api('/settings'));
  const [busy, setBusy] = useState<string | null>(null);
  const [install, setInstall] = useState('');
  if (!data) return <Loading error={error} />;

  async function act(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    try { const msg = await fn(); if (msg) toast(msg); reload(); } catch (e) { toast(e instanceof Error ? e.message : 'That did not work', 'error'); } finally { setBusy(null); }
  }
  const setPeople = (emails: string[]) => act('people', async () => { await api('/settings/people', { method: 'PUT', body: { emails } }); });
  function addPerson(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem('email') as HTMLInputElement;
    const email = input.value.trim().toLowerCase();
    if (email) setPeople([...data!.people, email]);
    input.value = '';
  }

  return (
    <div className="page narrow">
      <header className="page-head"><h1>Settings</h1></header>

      <section className="panel" style={{ marginTop: 0 }}>
        <h3>People</h3>
        <p className="muted small">Only these people can sign in, with Google. Any of them can approve a grant for submission.</p>
        <div className="people">
          {data.people.map((p) => (
            <div key={p} className="person">
              <span>{p}</span>
              {p !== data.me && <button className="btn quiet small danger-text" disabled={!!busy} onClick={() => confirm(`Remove ${p}?`) && setPeople(data.people.filter((x) => x !== p))}>Remove</button>}
            </div>
          ))}
        </div>
        <form className="row" onSubmit={addPerson}>
          <input name="email" type="email" placeholder="name@freehealth.ai" style={{ maxWidth: 280 }} />
          <button className="btn" disabled={!!busy}>Add</button>
        </form>
      </section>

      <section className="panel">
        <div className="sec-head">
          <h3>Browser agent</h3>
          <Pill tone={data.agent.online ? 'ok' : 'muted'}>{data.agent.online ? 'Online' : `Offline, seen ${fmtAgo(data.agent.last_seen)}`}</Pill>
        </div>
        <label>Engine
          <select value={data.agent_engine} style={{ maxWidth: 360 }} onChange={(e) => act('engine', async () => { await api('/settings', { method: 'PATCH', body: { agent_engine: e.target.value } }); })}>
            <option value="builtin">Built-in</option>
            <option value="hermes">Hermes{data.agent.info?.hermes ? '' : ' (not found on the VM)'}</option>
          </select>
        </label>
        <details className="fold" style={{ marginTop: 14 }}>
          <summary>Install on the VM</summary>
          <p className="muted small">Run this as root on the VM. It contains the agent's access token.</p>
          {install ? (
            <>
              <pre className="cmd">{install}</pre>
              <button className="btn" onClick={() => navigator.clipboard.writeText(install).then(() => toast('Copied.'))}>Copy</button>
            </>
          ) : (
            <button className="btn" onClick={() => api<{ command: string }>('/admin/agent-install').then((r) => setInstall(r.command)).catch((e) => toast(e.message, 'error'))}>Show command</button>
          )}
        </details>
      </section>

      <section className="panel">
        <h3>Answers</h3>
        <label className="check">
          <input type="checkbox" checked={data.auto_approve_facts} onChange={(e) => act('auto', async () => { await api('/settings', { method: 'PATCH', body: { auto_approve_facts: e.target.checked } }); })} />
          <span>Approve simple facts automatically (names, dates, links)</span>
        </label>
        {!data.ai_configured && <div className="error-box" style={{ marginTop: 10 }}>AI is not connected.</div>}
      </section>

      <section className="panel">
        <h3>Data</h3>
        <div className="row">
          <button className="btn" disabled={!!busy} onClick={() => act('seed', async () => { await api('/admin/seed', { method: 'POST' }); return 'Grant data refreshed.'; })}>{busy === 'seed' ? 'Refreshing' : 'Refresh grant data'}</button>
          {data.legacy_available && <button className="btn" disabled={!!busy} onClick={() => act('legacy', async () => { await api('/admin/import-legacy', { method: 'POST' }); return 'Imported.'; })}>Import from the old system</button>}
        </div>
      </section>

      {data.sandbox_submissions.length > 0 && (
        <section className="panel">
          <h3>Practice submissions</h3>
          {data.sandbox_submissions.map((s) => (
            <details key={s.id}><summary>{fmtAgo(s.at)}</summary><pre>{JSON.stringify(JSON.parse(s.payload_json), null, 2)}</pre></details>
          ))}
        </section>
      )}
    </div>
  );
}

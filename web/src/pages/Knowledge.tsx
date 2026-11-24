import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtAgo } from '../api';
import { Loading, Modal, useLoad, useToast } from '../components/ui';

interface Fact { id: string; category: string; title: string; content: string; notes: string; source: string; updated_at: string; updated_by: string | null }
interface Answer { id: string; text: string; answer: string; norm: string; grant_id: string; grant_title: string; updated_at: string }

const CAT_LABEL: Record<string, string> = {
  company: 'Company basics', contact: 'Contacts', team: 'Team & leadership', product: 'Product', problem: 'Problem', market: 'Market & customers',
  traction: 'Traction', business_model: 'Business model', financials: 'Financials & funding', legal: 'Legal & compliance', story: 'Story & vision', other: 'Other',
};

export function Knowledge() {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ facts: Fact[]; answers: Answer[]; categories: string[] }>(() => api('/knowledge'));
  const [tab, setTab] = useState<'facts' | 'answers'>('facts');
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Partial<Fact> | null>(null);

  const facts = useMemo(() => {
    const n = search.trim().toLowerCase();
    return (data?.facts ?? []).filter((f) => !n || `${f.title} ${f.content} ${f.notes}`.toLowerCase().includes(n));
  }, [data, search]);
  const answers = useMemo(() => {
    const n = search.trim().toLowerCase();
    const seen = new Map<string, Answer & { grants: string[] }>();
    for (const a of data?.answers ?? []) {
      if (n && !`${a.text} ${a.answer}`.toLowerCase().includes(n)) continue;
      const key = a.norm + '|' + a.answer;
      const ex = seen.get(key);
      if (ex) ex.grants.push(a.grant_title); else seen.set(key, { ...a, grants: [a.grant_title] });
    }
    return [...seen.values()];
  }, [data, search]);

  if (!data) return <Loading error={error} />;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      if (edit?.id) await api(`/knowledge/${edit.id}`, { method: 'PATCH', body });
      else await api('/knowledge', { body });
      toast('Saved. Open questions will be re-checked against it within a few minutes.');
      setEdit(null);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    }
  }
  async function remove(id: string) {
    if (!confirm('Delete this fact from the knowledge base?')) return;
    await api(`/knowledge/${id}`, { method: 'DELETE' });
    setEdit(null);
    reload();
  }

  const byCat = new Map<string, Fact[]>();
  for (const f of facts) byCat.set(f.category, [...(byCat.get(f.category) ?? []), f]);
  const cats = [...data.categories.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !data.categories.includes(c))];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Company knowledge</h1>
          <p className="muted">The single source of truth. The portal answers grant questions from here, so a fact entered once never has to be typed again.</p>
        </div>
        <button className="btn primary" onClick={() => setEdit({ category: 'company' })}>+ Add a fact</button>
      </header>
      <div className="tabs">
        <button className={tab === 'facts' ? 'on' : ''} onClick={() => setTab('facts')}>Company facts <span className="count">{data.facts.length}</span></button>
        <button className={tab === 'answers' ? 'on' : ''} onClick={() => setTab('answers')}>Approved answers <span className="count">{data.answers.length}</span></button>
        <input className="search" type="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {tab === 'facts' && (facts.length === 0 ? (
        <div className="empty">{data.facts.length === 0 ? 'No facts yet. Add the basics (legal name, address, contacts, team), or import from the old system in Settings.' : 'Nothing matches.'}</div>
      ) : cats.map((c) => (
        <section key={c}>
          <h2>{CAT_LABEL[c] ?? c} <span className="muted">({byCat.get(c)!.length})</span></h2>
          <div className="facts">
            {byCat.get(c)!.map((f) => (
              <button key={f.id} className="fact" onClick={() => setEdit(f)}>
                <div className="fact-title">{f.title}</div>
                <div className="fact-content">{f.content}</div>
                {f.notes && <div className="fact-notes">{f.notes}</div>}
              </button>
            ))}
          </div>
        </section>
      )))}

      {tab === 'answers' && (answers.length === 0 ? (
        <div className="empty">No approved answers yet. Each answer you approve on a grant shows up here and is reused automatically.</div>
      ) : (
        <div className="facts">
          {answers.map((a) => (
            <Link key={a.id} to={`/grants/${a.grant_id}`} className="fact">
              <div className="fact-title">{a.text}</div>
              <div className="fact-content">{a.answer}</div>
              <div className="fact-notes">Used on {a.grants.join(', ')} · {fmtAgo(a.updated_at)}</div>
            </Link>
          ))}
        </div>
      ))}

      {edit && (
        <Modal title={edit.id ? 'Edit fact' : 'Add a fact'} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={save}>
            <div className="row">
              <label>What is it?<input name="title" defaultValue={edit.title ?? ''} required autoFocus placeholder="e.g. EIN, CEO LinkedIn, Monthly burn" /></label>
              <label>Category<select name="category" defaultValue={edit.category ?? 'other'}>{data.categories.map((c) => <option key={c} value={c}>{CAT_LABEL[c] ?? c}</option>)}</select></label>
            </div>
            <label>The fact<textarea name="content" defaultValue={edit.content ?? ''} required rows={5} /></label>
            <label>Internal notes <span className="muted">(context for the team and the AI; never copied into an application)</span><textarea name="notes" defaultValue={edit.notes ?? ''} rows={2} /></label>
            <div className="row">
              <button className="btn primary">Save</button>
              {edit.id && <button type="button" className="btn ghost danger-text" onClick={() => remove(edit.id!)}>Delete</button>}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

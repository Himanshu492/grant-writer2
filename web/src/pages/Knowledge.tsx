import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Loading, Modal, useLoad, useToast } from '../components/ui';

interface Fact { id: string; category: string; title: string; content: string; notes: string }
interface Answer { id: string; text: string; answer: string; norm: string; grant_id: string; grant_title: string }

const CAT_LABEL: Record<string, string> = {
  company: 'Company', contact: 'Contacts', team: 'Team', product: 'Product', problem: 'Problem', market: 'Market',
  traction: 'Traction', business_model: 'Business model', financials: 'Financials', legal: 'Legal', story: 'Story', other: 'Other',
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
    const seen = new Map<string, Answer>();
    for (const a of data?.answers ?? []) {
      if (n && !`${a.text} ${a.answer}`.toLowerCase().includes(n)) continue;
      if (!seen.has(a.norm + '|' + a.answer)) seen.set(a.norm + '|' + a.answer, a);
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
      setEdit(null);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', 'error');
    }
  }
  async function remove(id: string) {
    if (!confirm('Delete this fact?')) return;
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
        <h1>Company knowledge</h1>
        <button className="btn" onClick={() => setEdit({ category: 'company' })}>Add fact</button>
      </header>
      <div className="tabs">
        <button className={tab === 'facts' ? 'on' : ''} onClick={() => setTab('facts')}>Facts<span className="count">{data.facts.length}</span></button>
        <button className={tab === 'answers' ? 'on' : ''} onClick={() => setTab('answers')}>Approved answers<span className="count">{data.answers.length}</span></button>
        <input className="search" type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {tab === 'facts' && (facts.length === 0 ? <div className="empty">Nothing here.</div> : cats.map((c) => (
        <section key={c} style={{ marginTop: 20 }}>
          <h2>{CAT_LABEL[c] ?? c}</h2>
          <div className="facts">
            {byCat.get(c)!.map((f) => (
              <button key={f.id} className="fact" onClick={() => setEdit(f)}>
                <div className="fact-title">{f.title}</div>
                <div className="fact-content">{f.content}</div>
              </button>
            ))}
          </div>
        </section>
      )))}

      {tab === 'answers' && (answers.length === 0 ? <div className="empty">Answers you approve show up here and get reused.</div> : (
        <div className="facts">
          {answers.map((a) => (
            <Link key={a.id} to={`/grants/${a.grant_id}`} className="fact">
              <div className="fact-title">{a.text}</div>
              <div className="fact-content">{a.answer}</div>
            </Link>
          ))}
        </div>
      ))}

      {edit && (
        <Modal title={edit.id ? 'Edit fact' : 'Add fact'} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={save}>
            <div className="row">
              <label>Name<input name="title" defaultValue={edit.title ?? ''} required autoFocus placeholder="EIN, CEO email, Monthly burn" /></label>
              <label>Category<select name="category" defaultValue={edit.category ?? 'other'}>{data.categories.map((c) => <option key={c} value={c}>{CAT_LABEL[c] ?? c}</option>)}</select></label>
            </div>
            <label>Fact<textarea name="content" defaultValue={edit.content ?? ''} required rows={5} /></label>
            <label>Internal notes<textarea name="notes" defaultValue={edit.notes ?? ''} rows={2} placeholder="Never copied into an application" /></label>
            <div className="row">
              <button className="btn primary">Save</button>
              {edit.id && <button type="button" className="btn quiet danger-text" onClick={() => remove(edit.id!)}>Delete</button>}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

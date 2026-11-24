import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Grant } from '../api';
import { GrantCard } from '../components/GrantCard';
import { Loading, Modal, useLoad, useToast } from '../components/ui';

const FILTERS: { id: string; label: string; match: (g: Grant) => boolean }[] = [
  { id: 'active', label: 'Active', match: (g) => g.pipeline === 'active' },
  { id: 'open', label: 'Open now', match: (g) => g.pipeline === 'active' && (g.status === 'open' || g.status === 'rolling') && (g.days_left === null || g.days_left >= 0) },
  { id: 'ready', label: 'Ready', match: (g) => g.pipeline === 'active' && g.ready },
  { id: 'submitted', label: 'Submitted', match: (g) => g.pipeline === 'submitted' },
  { id: 'not_pursuing', label: 'Not pursuing', match: (g) => g.pipeline === 'not_pursuing' },
];

export function Grants() {
  const { data, error } = useLoad<{ grants: Grant[] }>(() => api('/grants'));
  const [filter, setFilter] = useState('active');
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  if (!data) return <Loading error={error} />;

  const real = data.grants.filter((g) => !g.is_sandbox);
  const current = FILTERS.find((f) => f.id === filter)!;
  const list = real.filter(current.match);
  const practice = data.grants.filter((g) => g.is_sandbox);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      const res = await api<{ id: string }>('/grants', { body: Object.fromEntries(new FormData(e.currentTarget).entries()) });
      nav(`/grants/${res.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the grant', 'error');
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Grants</h1>
        <button className="btn" onClick={() => setAdding(true)}>Add grant</button>
      </header>
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
            {f.label}<span className="count">{real.filter(f.match).length}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? <div className="empty">None.</div> : <div className="grid">{list.map((g) => <GrantCard key={g.id} g={g} />)}</div>}
      {practice.length > 0 && filter === 'active' && (
        <section>
          <h2>Practice</h2>
          <div className="grid">{practice.map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}
      {adding && (
        <Modal title="Add grant" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={add}>
            <label>Name<input name="title" required autoFocus /></label>
            <label>Application link<input name="application_url" type="url" placeholder="https://" /></label>
            <div className="row">
              <label>Deadline<input name="deadline" type="date" /></label>
              <label>Award<input name="amount" /></label>
            </div>
            <button className="btn primary">Add</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

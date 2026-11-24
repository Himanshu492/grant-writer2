import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Grant } from '../api';
import { GrantCard } from '../components/GrantCard';
import { Loading, Modal, useLoad, useToast } from '../components/ui';

const FILTERS = [
  { id: 'active', label: 'Active' },
  { id: 'ready', label: 'Ready to apply' },
  { id: 'open', label: 'Open now' },
  { id: 'submitted', label: 'Submitted' },
  { id: 'not_pursuing', label: 'Not pursuing' },
  { id: 'all', label: 'All' },
];

export function Grants() {
  const { data, error } = useLoad<{ grants: Grant[] }>(() => api('/grants'));
  const [filter, setFilter] = useState('active');
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  if (!data) return <Loading error={error} />;

  const match = (g: Grant) => {
    if (filter === 'all') return true;
    if (filter === 'active') return g.pipeline === 'active';
    if (filter === 'ready') return g.pipeline === 'active' && g.ready;
    if (filter === 'open') return g.pipeline === 'active' && (g.status === 'open' || g.status === 'rolling') && (g.days_left === null || g.days_left >= 0);
    return g.pipeline === filter;
  };
  const list = data.grants.filter(match);
  const real = list.filter((g) => !g.is_sandbox);
  const sandbox = list.filter((g) => g.is_sandbox);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const res = await api<{ id: string }>('/grants', { body });
      nav(`/grants/${res.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the grant', 'error');
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Grants</h1>
          <p className="muted">Every grant and accelerator we are tracking, soonest deadline first.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>+ Add a grant</button>
      </header>
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
            {f.label} <span className="count">{data.grants.filter((g) => !g.is_sandbox).filter((g) => {
              const prev = filter; void prev;
              if (f.id === 'all') return true;
              if (f.id === 'active') return g.pipeline === 'active';
              if (f.id === 'ready') return g.pipeline === 'active' && g.ready;
              if (f.id === 'open') return g.pipeline === 'active' && (g.status === 'open' || g.status === 'rolling') && (g.days_left === null || g.days_left >= 0);
              return g.pipeline === f.id;
            }).length}</span>
          </button>
        ))}
      </div>
      {real.length === 0 ? <div className="empty">No grants here.</div> : <div className="grid">{real.map((g) => <GrantCard key={g.id} g={g} />)}</div>}
      {sandbox.length > 0 && (
        <section>
          <h2>Practice</h2>
          <p className="muted sec-sub">A fake application inside this portal for testing the browser agent safely.</p>
          <div className="grid">{sandbox.map((g) => <GrantCard key={g.id} g={g} />)}</div>
        </section>
      )}
      {adding && (
        <Modal title="Add a grant" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={add}>
            <label>Name<input name="title" required autoFocus placeholder="e.g. Acme Health Innovation Grant" /></label>
            <label>Funder<input name="funder" placeholder="Organisation" /></label>
            <label>Program page<input name="program_url" type="url" placeholder="https://…" /></label>
            <label>Application link<input name="application_url" type="url" placeholder="https://… (where the form starts)" /></label>
            <div className="row">
              <label>Deadline<input name="deadline" type="date" /></label>
              <label>Award<input name="amount" placeholder="e.g. $50,000" /></label>
            </div>
            <p className="muted">After adding, use “Scan the live form” so the browser agent reads the real questions, or add them by hand.</p>
            <button className="btn primary">Add grant</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

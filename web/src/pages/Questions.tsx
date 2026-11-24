import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Question } from '../api';
import { QuestionCard } from '../components/QuestionCard';
import { Loading, useLoad, useToast } from '../components/ui';

const FILTERS = [
  { id: 'needs_input', label: 'Need your input', key: 'needs_input' },
  { id: 'to_confirm', label: 'To confirm', key: 'to_confirm' },
  { id: 'answered', label: 'Answered', key: 'answered' },
];

export function Questions() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? 'needs_input';
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { data, error, reload } = useLoad<{ questions: Question[]; stats: Record<string, number> }>(() => api(`/questions?filter=${filter}`), [filter]);

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    const map = new Map<string, { q: Question; grants: { id: string; title: string }[] }>();
    for (const q of data.questions) {
      if (q.not_applicable) continue;
      if (needle && !`${q.text} ${q.answer} ${q.grant_title}`.toLowerCase().includes(needle)) continue;
      // Same wording and same current answer is one card.
      const key = `${q.norm}|${q.status}|${q.answer}`;
      const g = map.get(key);
      if (g) g.grants.push({ id: q.grant_id, title: q.grant_title! });
      else map.set(key, { q, grants: [{ id: q.grant_id, title: q.grant_title! }] });
    }
    return [...map.values()];
  }, [data, search]);

  async function fillAll() {
    setBusy(true);
    try {
      const r = await api<{ suggested: number; approved: number; reused: number; still_missing: number; errors: string[] }>('/infer', { body: {} });
      if (r.errors.length) toast(r.errors[0], 'error');
      else toast(`Filled ${r.suggested + r.approved + r.reused}. ${r.still_missing} still need you.`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Questions</h1>
        <button className="btn" disabled={busy} onClick={fillAll}>{busy ? <><span className="spinner" /> Filling</> : 'Fill from knowledge'}</button>
      </header>
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setParams({ filter: f.id })}>
            {f.label}{data && <span className="count">{data.stats[f.key] ?? 0}</span>}
          </button>
        ))}
        <input className="search" type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!data ? <Loading error={error} /> : groups.length === 0 ? <div className="empty">Nothing here.</div> : (
        <div className="stack">
          {groups.slice(0, 120).map(({ q, grants }) => <QuestionCard key={q.id} q={q} showGrant alsoAskedBy={grants} onChange={() => reload()} />)}
          {groups.length > 120 && <p className="muted small">Showing 120 of {groups.length}. Search to narrow down.</p>}
        </div>
      )}
    </div>
  );
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login' && path !== '/me') window.dispatchEvent(new Event('gp:signed-out'));
    throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export interface Progress { all: number; total: number; done: number; suggested: number; draft: number; empty: number; optional_open: number }

export interface Grant {
  id: string; title: string; funder: string; program_url: string | null; application_url: string | null;
  status: string; deadline: string | null; deadline_note: string; days_left: number | null; amount: string | null;
  rating: string; priority_rank: number | null; pipeline: string;
  summary: Record<string, string>; portal: Record<string, any>;
  questions_verification: string; questions_source_url: string | null; questions_verified_on: string | null; questions_note: string;
  sources: { url: string; note?: string }[];
  is_sandbox: boolean; live_enabled: boolean; submitted_at: string | null;
  progress: Progress; remaining: number; ready: boolean; last_run: Run | null;
}

export interface Question {
  id: string; grant_id: string; position: number; section: string; text: string; help: string; type: string;
  options: string[]; required: boolean | null; limit: { unit: string; max: number } | null; doc_kind: string | null;
  origin: string; source_url: string | null; answer: string;
  status: 'empty' | 'suggested' | 'draft' | 'approved' | 'skipped';
  answer_origin: string | null; confidence: string | null; basis: string | null; missing_info: string | null;
  document_id: string | null; updated_at: string; updated_by: string | null;
  grant_title?: string; grant_deadline?: string | null; norm?: string;
}

export interface Run {
  id: string; grant_id: string; grant_title?: string; mode: 'test' | 'live' | 'scan'; status: string;
  progress_done: number; progress_total: number; note: string; human_reason: string | null; live_view_url: string | null;
  resume_requested: number; cancel_requested: number; started_by: string | null; created_at: string; updated_at: string; finished_at: string | null;
}

export interface Doc { id: string; kind: string; label: string; filename: string; mime?: string; size: number; uploaded_at: string; used_by?: number }

export interface AgentStatus { online: boolean; last_seen: string | null; info: Record<string, any> | null }

export const DOC_KIND_LABELS: Record<string, string> = {
  pitch_deck: 'Pitch deck', financials: 'Financials', incorporation: 'Incorporation documents', cap_table: 'Cap table',
  resume: 'Résumé / CV', logo: 'Logo', video: 'Video', letter_of_support: 'Letter of support', budget: 'Budget', other: 'Other',
};

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T12:00:00Z' : iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function dueLabel(g: Pick<Grant, 'deadline' | 'days_left' | 'status' | 'deadline_note'>): { text: string; tone: 'danger' | 'warn' | 'ok' | 'muted' } {
  if (g.days_left === null || g.deadline === null) {
    if (g.status === 'rolling') return { text: 'Rolling — apply any time', tone: 'ok' };
    if (g.status === 'closed') return { text: 'Closed — next round not announced', tone: 'muted' };
    return { text: 'No deadline published', tone: 'muted' };
  }
  if (g.days_left < 0) return { text: `Deadline passed ${fmtDate(g.deadline)}`, tone: 'muted' };
  if (g.days_left === 0) return { text: 'Due today', tone: 'danger' };
  if (g.days_left === 1) return { text: 'Due tomorrow', tone: 'danger' };
  if (g.days_left <= 14) return { text: `Due in ${g.days_left} days · ${fmtDate(g.deadline)}`, tone: 'danger' };
  if (g.days_left <= 45) return { text: `Due in ${g.days_left} days · ${fmtDate(g.deadline)}`, tone: 'warn' };
  return { text: `Due ${fmtDate(g.deadline)}`, tone: 'ok' };
}

import { Hono } from 'hono';
import type { Env, GrantRow, QuestionRow, SeedQuestion } from './types';
import { requireAgent } from './auth';
import { reuseExistingAnswers, setSetting, syncQuestions } from './data';
import { norm, parseJson, todayISO, uid } from './util';

export interface RunRow {
  id: string;
  grant_id: string;
  mode: 'test' | 'live' | 'scan';
  status: string;
  progress_done: number;
  progress_total: number;
  note: string;
  human_reason: string | null;
  live_view_url: string | null;
  resume_requested: number;
  cancel_requested: number;
  result_json: string | null;
  started_by: string | null;
  created_at: string;
  claimed_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'needs_human'];
const FINAL = new Set(['review', 'submitted', 'completed', 'failed', 'cancelled']);

export async function addRunEvent(env: Env, runId: string, message: string, level = 'info', screenshotKey: string | null = null) {
  await env.DB.prepare('INSERT INTO run_events(run_id, level, message, screenshot_key) VALUES(?,?,?,?)').bind(runId, level, message.slice(0, 2000), screenshotKey).run();
}

/** The job sheet handed to the browser agent: where to go, what to type into which field, which files to attach. */
export async function buildJob(env: Env, run: RunRow, origin: string) {
  const grant = await env.DB.prepare('SELECT * FROM grants WHERE id=?').bind(run.grant_id).first<GrantRow>();
  if (!grant) throw new Error('Grant not found');
  const abs = (u: string | null) => (u && u.startsWith('/') ? origin + u : u);
  const { results: qs } = await env.DB.prepare('SELECT * FROM questions WHERE grant_id=? ORDER BY position').bind(run.grant_id).all<QuestionRow>();
  const { results: docs } = await env.DB.prepare('SELECT id, kind, label, filename, mime, size FROM documents').all<Record<string, string | number>>();
  const docById = new Map(docs.map((d) => [String(d.id), d]));
  const fields = run.mode === 'scan' ? [] : qs.map((q, i) => {
    const doc = q.document_id ? docById.get(q.document_id) : undefined;
    return {
      n: i + 1,
      id: q.id,
      section: q.section,
      question: q.text,
      help: q.help,
      type: q.type,
      options: parseJson<string[]>(q.options_json, []),
      required: q.required === null ? null : !!q.required,
      limit: q.limit_unit && q.limit_max ? `${q.limit_max} ${q.limit_unit}` : null,
      action: q.answer_status === 'approved' ? (q.type === 'file' ? 'upload' : 'fill') : 'leave_blank',
      answer: q.answer_status === 'approved' && q.type !== 'file' ? q.answer : '',
      document: q.answer_status === 'approved' && doc
        ? { id: doc.id, filename: doc.filename, mime: doc.mime, url: `${origin}/api/agent/documents/${doc.id}` }
        : null,
    };
  });
  return {
    run_id: run.id,
    mode: run.mode,
    grant: {
      id: grant.id,
      title: grant.title,
      funder: grant.funder,
      application_url: abs(grant.application_url) ?? abs(grant.program_url),
      program_url: abs(grant.program_url),
      portal: parseJson<Record<string, unknown>>(grant.portal_json, {}),
      is_sandbox: !!grant.is_sandbox,
    },
    fields,
  };
}

export const agentApi = new Hono<{ Bindings: Env }>();
agentApi.use('*', requireAgent);

agentApi.post('/heartbeat', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  await setSetting(c.env, 'agent_heartbeat', JSON.stringify({ ...body, at: new Date().toISOString() }));
  return c.json({ ok: true });
});

/** Hand the oldest queued run to the runner. */
agentApi.post('/claim', async (c) => {
  const run = await c.env.DB.prepare(
    `UPDATE runs SET status='running', claimed_at=datetime('now'), updated_at=datetime('now'), note='Agent picked up the job'
      WHERE id=(SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *`,
  ).first<RunRow>();
  if (!run) return c.json({ job: null });
  await addRunEvent(c.env, run.id, 'Browser agent picked up the job');
  return c.json({ job: await buildJob(c.env, run, new URL(c.req.url).origin) });
});

agentApi.get('/runs/:id', async (c) => {
  const run = await c.env.DB.prepare('SELECT id, status, resume_requested, cancel_requested FROM runs WHERE id=?').bind(c.req.param('id')).first();
  return run ? c.json(run) : c.json({ error: 'Not found' }, 404);
});

agentApi.post('/runs/:id/update', async (c) => {
  const id = c.req.param('id');
  const run = await c.env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();
  if (!run) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<{
    status?: string; note?: string; human_reason?: string; progress_done?: number; progress_total?: number;
    live_view_url?: string; message?: string; level?: string; result?: unknown;
  }>();
  if (FINAL.has(run.status)) return c.json({ ok: true, ignored: 'run already finished', status: run.status });
  const allowed = new Set(['running', 'needs_human', 'review', 'submitted', 'completed', 'failed', 'cancelled']);
  let status = b.status && allowed.has(b.status) ? b.status : run.status;
  // In test mode nothing may ever be reported as submitted.
  if (run.mode === 'test' && status === 'submitted') status = 'review';
  const sets = ['status=?', "updated_at=datetime('now')"];
  const binds: (string | number | null)[] = [status];
  if (b.note !== undefined) { sets.push('note=?'); binds.push(String(b.note).slice(0, 500)); }
  if (status === 'needs_human') { sets.push('human_reason=?'); binds.push(String(b.human_reason ?? b.note ?? 'The agent needs you to step in').slice(0, 500)); }
  if (status === 'running' && run.status === 'needs_human') { sets.push('human_reason=NULL', 'resume_requested=0'); }
  if (typeof b.progress_done === 'number') { sets.push('progress_done=?'); binds.push(b.progress_done); }
  if (typeof b.progress_total === 'number') { sets.push('progress_total=?'); binds.push(b.progress_total); }
  if (b.live_view_url) { sets.push('live_view_url=?'); binds.push(b.live_view_url); }
  if (b.result !== undefined) { sets.push('result_json=?'); binds.push(JSON.stringify(b.result).slice(0, 20000)); }
  if (FINAL.has(status)) sets.push("finished_at=datetime('now')");
  await c.env.DB.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id=?`).bind(...binds, id).run();
  if (b.message) await addRunEvent(c.env, id, b.message, b.level ?? (status === 'failed' ? 'error' : status === 'needs_human' ? 'warn' : 'info'));
  if (status === 'submitted' && run.mode === 'live') {
    await c.env.DB.prepare(`UPDATE grants SET pipeline='submitted', submitted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(run.grant_id).run();
  }
  return c.json({ ok: true, status });
});

agentApi.post('/runs/:id/screenshot', async (c) => {
  const id = c.req.param('id');
  const run = await c.env.DB.prepare('SELECT id FROM runs WHERE id=?').bind(id).first();
  if (!run) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 8 * 1024 * 1024) return c.json({ error: 'Screenshot too large' }, 413);
  const key = `runs/${id}/${Date.now()}.png`;
  await c.env.DOCS.put(key, body, { httpMetadata: { contentType: 'image/png' } });
  await addRunEvent(c.env, id, c.req.query('message') || 'Screenshot', 'info', key);
  return c.json({ ok: true });
});

/**
 * Questions read off the live form. In a scan run they replace the grant's list (answers are kept by matching text);
 * in a fill run they are fields the agent found that the portal did not know about, added as new unanswered questions.
 */
agentApi.post('/runs/:id/questions', async (c) => {
  const id = c.req.param('id');
  const run = await c.env.DB.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();
  if (!run) return c.json({ error: 'Not found' }, 404);
  const grant = await c.env.DB.prepare('SELECT * FROM grants WHERE id=?').bind(run.grant_id).first<GrantRow>();
  if (!grant) return c.json({ error: 'Grant not found' }, 404);
  const b = await c.req.json<{ questions: SeedQuestion[]; source_url?: string; note?: string }>();
  const list = (b.questions ?? []).filter((q) => q && typeof q.text === 'string' && q.text.trim()).slice(0, 400);
  if (!list.length) return c.json({ error: 'No questions supplied' }, 400);

  if (run.mode === 'scan') {
    const res = await syncQuestions(c.env, grant.id, grant.title, list, 'agent_scan');
    await c.env.DB.prepare(
      `UPDATE grants SET questions_verification='agent_scan', questions_source_url=?, questions_verified_on=?, questions_note=?, updated_at=datetime('now') WHERE id=?`,
    ).bind(b.source_url ?? grant.application_url, todayISO(), b.note ?? 'Read from the live application form by the browser agent.', grant.id).run();
    const reused = await reuseExistingAnswers(c.env, grant.id);
    await addRunEvent(c.env, id, `Scanned the live form: ${list.length} questions (${res.added} new, ${res.kept} already known, ${res.removed} removed, ${reused} answered from existing answers)`);
    return c.json({ ok: true, ...res, reused });
  }

  const { results: existing } = await c.env.DB.prepare('SELECT norm, max(position) OVER () AS maxpos FROM questions WHERE grant_id=?').bind(grant.id).all<{ norm: string; maxpos: number }>();
  const known = new Set(existing.map((e) => e.norm));
  let pos = existing[0]?.maxpos ?? 0;
  const stmts: D1PreparedStatement[] = [];
  for (const q of list) {
    const n = norm(q.text);
    if (!n || known.has(n)) continue;
    known.add(n);
    pos += 1;
    const type = q.type || 'long_text';
    stmts.push(c.env.DB.prepare(
      `INSERT INTO questions(id, grant_id, position, section, text, help, type, options_json, required, limit_unit, limit_max, doc_kind, norm, origin, source_url)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'agent_scan',?)`,
    ).bind(uid('q'), grant.id, pos, q.section ?? '', q.text.trim(), q.help ?? '', type, JSON.stringify(q.options ?? []),
      q.required === null || q.required === undefined ? null : q.required ? 1 : 0, q.limit?.unit ?? null, q.limit?.max ?? null,
      type === 'file' ? q.doc_kind ?? 'other' : null, n, b.source_url ?? null));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const reused = await reuseExistingAnswers(c.env, grant.id);
  await addRunEvent(c.env, id, `Found ${stmts.length} field(s) on the live form that were not in the portal; added them as new questions`, 'warn');
  return c.json({ ok: true, added: stmts.length, reused });
});

agentApi.get('/documents/:id', async (c) => {
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(c.req.param('id')).first<Record<string, string>>();
  if (!doc) return c.json({ error: 'Not found' }, 404);
  const obj = await c.env.DOCS.get(doc.r2_key);
  if (!obj) return c.json({ error: 'File missing from storage' }, 404);
  return new Response(obj.body, {
    headers: { 'content-type': doc.mime, 'content-disposition': `attachment; filename="${encodeURIComponent(doc.filename)}"` },
  });
});

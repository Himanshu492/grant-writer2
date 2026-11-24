import { Hono } from 'hono';
import type { Env, GrantRow, QuestionRow, SeedGrant } from './types';
import { type Vars, checkPassword, clearSession, createSession, readSession, requireUser } from './auth';
import { draftAnswer, KNOWLEDGE_CATEGORIES, runInference } from './ai';
import { ACTIVE_RUN_STATUSES, type RunRow, addRunEvent, agentApi } from './agent';
import {
  allProgress, autolinkDocuments, bumpKbVersion, getSetting, grantView, kbVersion, propagateAnswer, questionView,
  reuseExistingAnswers, setSetting, upsertSeedGrant,
} from './data';
import { importLegacy } from './legacy';
import { SANDBOX_PASSWORD, sandbox } from './sandbox';
import { norm, parseJson, sha256Hex, uid } from './util';
import seedBundle from './seed.generated.json';
import clientBundle from './client.generated.json';
import agentBundle from './agent.generated.json';

const SEEDS = seedBundle as unknown as SeedGrant[];
const CLIENT = clientBundle as unknown as Record<string, { type: string; body: string; base64: boolean }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || 'Something went wrong' }, 500);
});

app.route('/sandbox', sandbox);

// ---------- VM runner distribution (public: these files contain no secrets) ----------

const AGENT = agentBundle as { version: string; files: Record<string, string> };
app.get('/agent/version', (c) => c.json({ version: AGENT.version, files: Object.keys(AGENT.files).filter((f) => f !== 'install.sh') }));
app.get('/agent/install.sh', (c) => c.text(AGENT.files['install.sh'], 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' }));
app.get('/agent/files/:name', (c) => {
  const body = AGENT.files[c.req.param('name')];
  return body === undefined ? c.text('Not found', 404) : c.text(body, 200, { 'cache-control': 'no-store' });
});
app.all('/agent/*', (c) => c.text('Not found', 404));
app.route('/api/agent', agentApi);

// ---------- session ----------

app.post('/api/login', async (c) => {
  const { password, name } = await c.req.json<{ password: string; name: string }>();
  if (!c.env.PORTAL_PASSWORD || !c.env.SESSION_SECRET) return c.json({ error: 'The portal password has not been configured yet.' }, 503);
  if (!checkPassword(c.env, String(password ?? ''))) return c.json({ error: 'Wrong password' }, 401);
  const who = String(name ?? '').trim().slice(0, 60) || 'Team member';
  await createSession(c, who);
  return c.json({ name: who });
});

app.post('/api/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
  const s = await readSession(c);
  return s ? c.json({ name: s.name }) : c.json({ error: 'Not signed in' }, 401);
});

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/agent/')) return next();
  return requireUser(c, next);
});

// ---------- helpers ----------

async function applySeeds(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const seed of SEEDS) out[seed.id] = await upsertSeedGrant(env, seed);
  await autolinkDocuments(env);
  await reuseExistingAnswers(env);
  await setSetting(env, 'seed_bundle_hash', await sha256Hex(JSON.stringify(SEEDS)));
  return out;
}

async function lastRuns(env: Env): Promise<Map<string, Record<string, unknown>>> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.grant_id, r.mode, r.status, r.note, r.human_reason, r.progress_done, r.progress_total, r.created_at, r.updated_at
       FROM runs r JOIN (SELECT grant_id, max(created_at) AS m FROM runs GROUP BY grant_id) x ON x.grant_id=r.grant_id AND x.m=r.created_at`,
  ).all<Record<string, unknown>>();
  return new Map(results.map((r) => [String(r.grant_id), r]));
}

async function agentStatus(env: Env) {
  const hb = parseJson<Record<string, unknown> | null>(await getSetting(env, 'agent_heartbeat', ''), null);
  const at = hb?.at ? Date.parse(String(hb.at)) : 0;
  return { online: !!at && Date.now() - at < 90_000, last_seen: hb?.at ?? null, info: hb };
}

const QUESTION_JOIN = `SELECT q.*, g.title AS grant_title, g.deadline AS grant_deadline, g.is_sandbox AS grant_sandbox
  FROM questions q JOIN grants g ON g.id=q.grant_id`;

// ---------- dashboard ----------

app.get('/api/dashboard', async (c) => {
  const env = c.env;
  const [{ results: grants }, progress, runs, agent, { results: open }, { results: activeRuns }, counts] = await Promise.all([
    env.DB.prepare(`SELECT * FROM grants ORDER BY (deadline IS NULL), deadline, priority_rank`).all<GrantRow>(),
    allProgress(env),
    lastRuns(env),
    agentStatus(env),
    env.DB.prepare(
      `${QUESTION_JOIN} WHERE q.answer_status IN ('empty','draft') AND (q.required IS NULL OR q.required=1) AND g.pipeline='active' AND g.is_sandbox=0
        ORDER BY (g.deadline IS NULL), g.deadline, g.priority_rank, q.position LIMIT 400`,
    ).all<QuestionRow & { grant_title: string; grant_deadline: string | null }>(),
    env.DB.prepare(
      `SELECT r.*, g.title AS grant_title FROM runs r JOIN grants g ON g.id=r.grant_id
        WHERE r.status IN ('queued','running','needs_human') OR r.updated_at > datetime('now','-2 days') ORDER BY r.created_at DESC LIMIT 12`,
    ).all<RunRow & { grant_title: string }>(),
    env.DB.prepare(
      `SELECT (SELECT count(*) FROM knowledge) AS knowledge, (SELECT count(*) FROM documents) AS documents,
              (SELECT count(*) FROM questions q JOIN grants g ON g.id=q.grant_id WHERE q.answer_status='suggested' AND g.pipeline='active' AND g.is_sandbox=0) AS suggested`,
    ).first<Record<string, number>>(),
  ]);

  const views = grants.map((g) => grantView(g, progress.get(g.id), runs.get(g.id)));
  // "Answer next": one entry per distinct question, with every grant it unblocks.
  const groups = new Map<string, { question: ReturnType<typeof questionView>; grants: { id: string; title: string; deadline: string | null }[] }>();
  for (const q of open) {
    const g = groups.get(q.norm);
    const ref = { id: q.grant_id, title: q.grant_title, deadline: q.grant_deadline };
    if (g) {
      if (!g.grants.some((x) => x.id === ref.id)) g.grants.push(ref);
    } else groups.set(q.norm, { question: questionView(q), grants: [ref] });
  }
  return c.json({
    grants: views,
    queue: [...groups.values()].slice(0, 40),
    queue_total: groups.size,
    counts,
    agent,
    runs: activeRuns,
    default_mode: await getSetting(env, 'default_mode', 'test'),
  });
});

// ---------- grants ----------

app.get('/api/grants', async (c) => {
  const [{ results }, progress, runs] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM grants ORDER BY (deadline IS NULL), deadline, priority_rank, title`).all<GrantRow>(),
    allProgress(c.env),
    lastRuns(c.env),
  ]);
  return c.json({ grants: results.map((g) => grantView(g, progress.get(g.id), runs.get(g.id))) });
});

app.post('/api/grants', async (c) => {
  const b = await c.req.json<Record<string, string>>();
  if (!b.title?.trim()) return c.json({ error: 'A grant needs a name' }, 400);
  const id = (b.title.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'GRANT') + '-' + uid().slice(0, 4);
  await c.env.DB.prepare(
    `INSERT INTO grants(id, title, funder, program_url, application_url, deadline, deadline_note, amount, questions_verification, questions_note)
     VALUES(?,?,?,?,?,?,?,?,'manual','Added by hand. Add its questions below, or run "Scan the live form".')`,
  ).bind(id, b.title.trim(), b.funder?.trim() ?? '', b.program_url?.trim() || null, b.application_url?.trim() || null,
    b.deadline?.trim() || null, b.deadline_note?.trim() ?? '', b.amount?.trim() || null).run();
  return c.json({ id });
});

app.get('/api/grants/:id', async (c) => {
  const id = c.req.param('id');
  const g = await c.env.DB.prepare('SELECT * FROM grants WHERE id=?').bind(id).first<GrantRow>();
  if (!g) return c.json({ error: 'Grant not found' }, 404);
  const [progress, { results: questions }, { results: runs }, { results: documents }, agent] = await Promise.all([
    allProgress(c.env),
    c.env.DB.prepare('SELECT * FROM questions WHERE grant_id=? ORDER BY position').bind(id).all<QuestionRow>(),
    c.env.DB.prepare('SELECT * FROM runs WHERE grant_id=? ORDER BY created_at DESC LIMIT 10').bind(id).all<RunRow>(),
    c.env.DB.prepare('SELECT id, kind, label, filename, size, uploaded_at FROM documents ORDER BY uploaded_at DESC').all(),
    agentStatus(c.env),
  ]);
  return c.json({
    grant: grantView(g, progress.get(id), runs[0] as unknown as Record<string, unknown>),
    questions: questions.map(questionView),
    runs,
    documents,
    agent,
    default_mode: await getSetting(c.env, 'default_mode', 'test'),
    sandbox_password: g.is_sandbox ? SANDBOX_PASSWORD : undefined,
  });
});

app.patch('/api/grants/:id', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json<Record<string, unknown>>();
  const editable = ['title', 'funder', 'program_url', 'application_url', 'status', 'deadline', 'deadline_note', 'amount', 'pipeline', 'live_enabled'];
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of editable) {
    if (!(k in b)) continue;
    let v = b[k];
    if (k === 'live_enabled') v = v ? 1 : 0;
    if (k === 'pipeline' && !['active', 'submitted', 'not_pursuing'].includes(String(v))) return c.json({ error: 'Bad pipeline value' }, 400);
    if (typeof v === 'string' && !v.trim() && ['program_url', 'application_url', 'deadline', 'amount'].includes(k)) v = null;
    sets.push(`${k}=?`);
    binds.push(v);
  }
  if (b.pipeline === 'submitted') sets.push(`submitted_at=coalesce(submitted_at, datetime('now'))`);
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  await c.env.DB.prepare(`UPDATE grants SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).bind(...binds, id).run();
  return c.json({ ok: true });
});

app.post('/api/grants/:id/questions', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json<{ text: string; type?: string; section?: string; required?: boolean; help?: string }>();
  if (!b.text?.trim()) return c.json({ error: 'Question text is required' }, 400);
  const max = await c.env.DB.prepare('SELECT coalesce(max(position),0) AS m FROM questions WHERE grant_id=?').bind(id).first<{ m: number }>();
  const qid = uid('q');
  await c.env.DB.prepare(
    `INSERT INTO questions(id, grant_id, position, section, text, help, type, required, norm, origin, doc_kind) VALUES(?,?,?,?,?,?,?,?,?,'manual',?)`,
  ).bind(qid, id, (max?.m ?? 0) + 1, b.section ?? '', b.text.trim(), b.help ?? '', b.type ?? 'long_text', b.required === false ? 0 : 1,
    norm(b.text), b.type === 'file' ? 'other' : null).run();
  await reuseExistingAnswers(c.env, id);
  return c.json({ id: qid });
});

app.post('/api/grants/:id/accept-suggestions', async (c) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(`SELECT * FROM questions WHERE grant_id=? AND answer_status='suggested' AND answer<>''`).bind(id).all<QuestionRow>();
  if (!results.length) return c.json({ accepted: 0 });
  await c.env.DB.prepare(
    `UPDATE questions SET answer_status='approved', updated_at=datetime('now'), updated_by=? WHERE grant_id=? AND answer_status='suggested' AND answer<>''`,
  ).bind(c.get('user'), id).run();
  for (const q of results) await propagateAnswer(c.env, { ...q, answer_status: 'approved' }, c.get('user'));
  await bumpKbVersion(c.env);
  return c.json({ accepted: results.length });
});

// ---------- questions ----------

app.get('/api/questions', async (c) => {
  const filter = c.req.query('filter') ?? 'needs_input';
  const where: string[] = [`g.pipeline='active'`];
  if (filter === 'needs_input') where.push(`q.answer_status IN ('empty','draft')`);
  else if (filter === 'to_confirm') where.push(`q.answer_status='suggested'`);
  else if (filter === 'answered') where.push(`q.answer_status IN ('approved','skipped')`);
  const { results } = await c.env.DB.prepare(
    `${QUESTION_JOIN} WHERE ${where.join(' AND ')} ORDER BY (g.deadline IS NULL), g.deadline, g.priority_rank, g.title, q.position LIMIT 1500`,
  ).all<QuestionRow & { grant_title: string; grant_deadline: string | null; grant_sandbox: number }>();
  const stats = await c.env.DB.prepare(
    `SELECT sum(CASE WHEN q.answer_status IN ('empty','draft') THEN 1 ELSE 0 END) AS needs_input,
            sum(CASE WHEN q.answer_status='suggested' THEN 1 ELSE 0 END) AS to_confirm,
            sum(CASE WHEN q.answer_status IN ('approved','skipped') THEN 1 ELSE 0 END) AS answered, count(*) AS all_q
       FROM questions q JOIN grants g ON g.id=q.grant_id WHERE g.pipeline='active'`,
  ).first();
  return c.json({
    questions: results.map((q) => ({ ...questionView(q), grant_title: q.grant_title, grant_deadline: q.grant_deadline, norm: q.norm })),
    stats,
  });
});

app.patch('/api/questions/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const q = await c.env.DB.prepare('SELECT * FROM questions WHERE id=?').bind(id).first<QuestionRow>();
  if (!q) return c.json({ error: 'Question not found' }, 404);
  const b = await c.req.json<{
    answer?: string; status?: string; document_id?: string | null;
    text?: string; help?: string; type?: string; options?: string[]; required?: boolean | null; section?: string;
    limit?: { unit: string; max: number } | null; doc_kind?: string;
  }>();

  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col}=?`); binds.push(v); };

  // Editing the question itself.
  if (b.text !== undefined && b.text.trim()) { set('text', b.text.trim()); set('norm', norm(b.text)); }
  if (b.help !== undefined) set('help', b.help);
  if (b.section !== undefined) set('section', b.section);
  if (b.type !== undefined) { set('type', b.type); if (b.type === 'file' && !q.doc_kind) set('doc_kind', 'other'); }
  if (b.doc_kind !== undefined) set('doc_kind', b.doc_kind);
  if (b.options !== undefined) set('options_json', JSON.stringify(b.options));
  if (b.required !== undefined) set('required', b.required === null ? null : b.required ? 1 : 0);
  if (b.limit !== undefined) { set('limit_unit', b.limit?.unit ?? null); set('limit_max', b.limit?.max ?? null); }

  // Answering.
  let answer = q.answer;
  let status = q.answer_status;
  let documentId = q.document_id;
  if (b.document_id !== undefined) {
    documentId = b.document_id || null;
    set('document_id', documentId);
    status = documentId ? 'approved' : 'empty';
    set('answer_origin', 'manual');
  }
  if (b.answer !== undefined) {
    answer = b.answer;
    set('answer', answer);
    if (answer !== q.answer) { set('answer_origin', 'manual'); set('answer_basis', null); set('answer_confidence', null); }
    if (b.status === undefined && b.document_id === undefined) status = answer.trim() ? (q.answer_status === 'approved' && answer === q.answer ? 'approved' : 'draft') : 'empty';
  }
  if (b.status !== undefined) {
    if (!['empty', 'draft', 'approved', 'skipped', 'suggested'].includes(b.status)) return c.json({ error: 'Bad status' }, 400);
    status = b.status as QuestionRow['answer_status'];
    if (status === 'approved' && q.type === 'file' && !documentId) return c.json({ error: 'Choose or upload a document first' }, 400);
    if (status === 'approved' && q.type !== 'file' && !answer.trim()) return c.json({ error: 'Write an answer before approving' }, 400);
    if (status === 'empty') { answer = ''; set('answer', ''); set('answer_origin', null); set('answer_basis', null); if (q.type === 'file') set('document_id', null); }
  }
  if (status !== q.answer_status) {
    set('answer_status', status);
    if (status === 'approved' || status === 'skipped') set('missing_info', null);
  }
  if (!sets.length) return c.json({ question: questionView(q), reused: 0 });
  await c.env.DB.prepare(`UPDATE questions SET ${sets.join(', ')}, updated_at=datetime('now'), updated_by=? WHERE id=?`).bind(...binds, user, id).run();

  const fresh = (await c.env.DB.prepare('SELECT * FROM questions WHERE id=?').bind(id).first<QuestionRow>())!;
  let reused = 0;
  if (fresh.answer_status === 'approved' && (q.answer_status !== 'approved' || q.answer !== fresh.answer)) {
    reused = await propagateAnswer(c.env, fresh, user);
    await bumpKbVersion(c.env); // a new approved answer is new company knowledge
  }
  return c.json({ question: questionView(fresh), reused });
});

app.delete('/api/questions/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM questions WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

app.post('/api/questions/:id/draft', async (c) => {
  const id = c.req.param('id');
  const q = await c.env.DB.prepare('SELECT * FROM questions WHERE id=?').bind(id).first<QuestionRow>();
  if (!q) return c.json({ error: 'Question not found' }, 404);
  if (q.type === 'file') return c.json({ error: 'Upload a document for this one' }, 400);
  const grant = (await c.env.DB.prepare('SELECT * FROM grants WHERE id=?').bind(q.grant_id).first<GrantRow>())!;
  const { guidance } = await c.req.json<{ guidance?: string }>().catch(() => ({ guidance: undefined }));
  const draft = await draftAnswer(c.env, q, grant, guidance);
  const missing = draft.missing.join(' · ').slice(0, 500) || null;
  if (draft.answer) {
    await c.env.DB.prepare(
      `UPDATE questions SET answer=?, answer_status='draft', answer_origin='ai_draft', answer_basis=?, missing_info=?, updated_at=datetime('now'), updated_by=? WHERE id=?`,
    ).bind(draft.answer, draft.basis.slice(0, 300), missing, `${c.get('user')} (AI draft)`, id).run();
  } else {
    await c.env.DB.prepare(`UPDATE questions SET missing_info=? WHERE id=?`).bind(missing ?? 'The knowledge base does not contain this yet.', id).run();
  }
  const fresh = (await c.env.DB.prepare('SELECT * FROM questions WHERE id=?').bind(id).first<QuestionRow>())!;
  return c.json({ question: questionView(fresh), drafted: !!draft.answer, missing: draft.missing });
});

/** "Fill from knowledge base": try to answer every open question from what the company has already told us. */
app.post('/api/infer', async (c) => {
  const { grant_id } = await c.req.json<{ grant_id?: string }>().catch(() => ({ grant_id: undefined }));
  const reused = await reuseExistingAnswers(c.env, grant_id);
  const summary = await runInference(c.env, { grantId: grant_id, force: true, maxQuestions: grant_id ? 200 : 300 });
  return c.json({ ...summary, reused });
});

// ---------- knowledge ----------

app.get('/api/knowledge', async (c) => {
  const [{ results: facts }, { results: answers }] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM knowledge ORDER BY category, title').all(),
    c.env.DB.prepare(
      `SELECT q.id, q.text, q.answer, q.norm, q.updated_at, q.updated_by, g.id AS grant_id, g.title AS grant_title FROM questions q JOIN grants g ON g.id=q.grant_id
        WHERE q.answer_status='approved' AND q.answer<>'' AND q.type<>'file' AND g.is_sandbox=0 ORDER BY q.updated_at DESC LIMIT 1000`,
    ).all(),
  ]);
  return c.json({ facts, answers, categories: KNOWLEDGE_CATEGORIES });
});

app.post('/api/knowledge', async (c) => {
  const b = await c.req.json<Record<string, string>>();
  if (!b.title?.trim() || !b.content?.trim()) return c.json({ error: 'A fact needs a title and a value' }, 400);
  const id = uid('k');
  await c.env.DB.prepare(`INSERT INTO knowledge(id, category, title, content, notes, source, updated_by) VALUES(?,?,?,?,?,'manual',?)`)
    .bind(id, b.category || 'other', b.title.trim(), b.content.trim(), b.notes ?? '', c.get('user')).run();
  await bumpKbVersion(c.env);
  return c.json({ id });
});

app.patch('/api/knowledge/:id', async (c) => {
  const b = await c.req.json<Record<string, string>>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const k of ['category', 'title', 'content', 'notes']) if (k in b) { sets.push(`${k}=?`); binds.push(b[k]); }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  await c.env.DB.prepare(`UPDATE knowledge SET ${sets.join(', ')}, updated_at=datetime('now'), updated_by=? WHERE id=?`).bind(...binds, c.get('user'), c.req.param('id')).run();
  await bumpKbVersion(c.env);
  return c.json({ ok: true });
});

app.delete('/api/knowledge/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM knowledge WHERE id=?').bind(c.req.param('id')).run();
  await bumpKbVersion(c.env);
  return c.json({ ok: true });
});

// ---------- documents ----------

const DOC_KINDS = ['pitch_deck', 'financials', 'incorporation', 'cap_table', 'resume', 'logo', 'video', 'letter_of_support', 'budget', 'other'];

app.get('/api/documents', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT d.*, (SELECT count(*) FROM questions q WHERE q.document_id=d.id) AS used_by FROM documents d ORDER BY d.uploaded_at DESC`,
  ).all();
  const { results: wanted } = await c.env.DB.prepare(
    `SELECT q.doc_kind, count(*) AS n FROM questions q JOIN grants g ON g.id=q.grant_id
      WHERE q.type='file' AND q.document_id IS NULL AND q.answer_status<>'skipped' AND g.pipeline='active' AND g.is_sandbox=0 GROUP BY q.doc_kind`,
  ).all();
  return c.json({ documents: results, kinds: DOC_KINDS, wanted });
});

app.post('/api/documents', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file') as unknown as File | null;
  if (!file || typeof file === 'string') return c.json({ error: 'No file received' }, 400);
  if (file.size > 95 * 1024 * 1024) return c.json({ error: 'File is larger than 95 MB' }, 413);
  const kind = DOC_KINDS.includes(String(form.get('kind'))) ? String(form.get('kind')) : 'other';
  const id = uid('doc');
  const safeName = file.name.replace(/[^\w.\- ()]+/g, '_').slice(0, 150) || 'file';
  const key = `documents/${id}/${safeName}`;
  await c.env.DOCS.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
  await c.env.DB.prepare(`INSERT INTO documents(id, kind, label, filename, mime, size, r2_key, uploaded_by) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id, kind, String(form.get('label') ?? '').trim() || safeName, safeName, file.type || 'application/octet-stream', file.size, key, c.get('user')).run();
  // A specific question asked for this file: attach it there.
  const questionId = form.get('question_id');
  if (typeof questionId === 'string' && questionId) {
    await c.env.DB.prepare(
      `UPDATE questions SET document_id=?, answer_status='approved', answer_origin='manual', updated_at=datetime('now'), updated_by=? WHERE id=? AND type='file'`,
    ).bind(id, c.get('user'), questionId).run();
  }
  const linked = await autolinkDocuments(c.env);
  await bumpKbVersion(c.env);
  return c.json({ id, linked });
});

app.patch('/api/documents/:id', async (c) => {
  const b = await c.req.json<Record<string, string>>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.kind && DOC_KINDS.includes(b.kind)) { sets.push('kind=?'); binds.push(b.kind); }
  if (b.label !== undefined) { sets.push('label=?'); binds.push(b.label); }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  await c.env.DB.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id=?`).bind(...binds, c.req.param('id')).run();
  const linked = await autolinkDocuments(c.env);
  return c.json({ ok: true, linked });
});

app.delete('/api/documents/:id', async (c) => {
  const id = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT r2_key FROM documents WHERE id=?').bind(id).first<{ r2_key: string }>();
  if (!doc) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE questions SET document_id=NULL, answer_status='empty', updated_at=datetime('now') WHERE document_id=?`).bind(id),
    c.env.DB.prepare('DELETE FROM documents WHERE id=?').bind(id),
  ]);
  await c.env.DOCS.delete(doc.r2_key);
  await autolinkDocuments(c.env);
  return c.json({ ok: true });
});

app.get('/api/documents/:id/download', async (c) => {
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id=?').bind(c.req.param('id')).first<Record<string, string>>();
  if (!doc) return c.json({ error: 'Not found' }, 404);
  const obj = await c.env.DOCS.get(doc.r2_key);
  if (!obj) return c.json({ error: 'File missing from storage' }, 404);
  return new Response(obj.body, {
    headers: { 'content-type': doc.mime, 'content-disposition': `inline; filename="${encodeURIComponent(doc.filename)}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' },
  });
});

// ---------- runs (the browser agent) ----------

app.post('/api/grants/:id/apply', async (c) => {
  const id = c.req.param('id');
  const { mode } = await c.req.json<{ mode: 'test' | 'live' | 'scan' }>();
  if (!['test', 'live', 'scan'].includes(mode)) return c.json({ error: 'Mode must be test, live or scan' }, 400);
  const g = await c.env.DB.prepare('SELECT * FROM grants WHERE id=?').bind(id).first<GrantRow>();
  if (!g) return c.json({ error: 'Grant not found' }, 404);
  if (!g.application_url && !(mode === 'scan' && g.program_url)) return c.json({ error: 'This grant has no application link yet. Add one on the grant page first.' }, 400);
  const active = await c.env.DB.prepare(`SELECT id FROM runs WHERE grant_id=? AND status IN ('queued','running','needs_human')`).bind(id).first();
  if (active) return c.json({ error: 'The agent is already working on this grant' }, 409);
  const view = grantView(g, (await allProgress(c.env)).get(id));
  if (mode === 'live') {
    if (!g.live_enabled) return c.json({ error: 'Real submissions are switched off for this grant. Turn on "Allow real submission" first.' }, 400);
    if (!view.ready) return c.json({ error: `${view.remaining} required question(s) still need an approved answer before submitting for real.` }, 400);
  }
  if (mode === 'test' && view.progress.done === 0) return c.json({ error: 'Approve at least one answer before a test run.' }, 400);
  const runId = uid('run');
  await c.env.DB.prepare(`INSERT INTO runs(id, grant_id, mode, status, progress_total, note, started_by) VALUES(?,?,?,'queued',?,'Waiting for the browser agent',?)`)
    .bind(runId, id, mode, mode === 'scan' ? 0 : view.progress.all, c.get('user')).run();
  const label = mode === 'scan' ? 'Scan of the live form' : mode === 'live' ? 'REAL application (will submit)' : 'Test application (will not submit)';
  await addRunEvent(c.env, runId, `${label} started by ${c.get('user')}`);
  return c.json({ id: runId });
});

app.get('/api/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, g.title AS grant_title FROM runs r JOIN grants g ON g.id=r.grant_id ORDER BY r.created_at DESC LIMIT 100`,
  ).all();
  return c.json({ runs: results, agent: await agentStatus(c.env) });
});

app.get('/api/runs/:id', async (c) => {
  const id = c.req.param('id');
  const run = await c.env.DB.prepare(`SELECT r.*, g.title AS grant_title, g.application_url FROM runs r JOIN grants g ON g.id=r.grant_id WHERE r.id=?`).bind(id).first();
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const { results: events } = await c.env.DB.prepare('SELECT id, at, level, message, screenshot_key IS NOT NULL AS has_screenshot FROM run_events WHERE run_id=? ORDER BY id').bind(id).all();
  return c.json({ run, events, agent: await agentStatus(c.env) });
});

app.get('/api/runs/:id/screenshots/:eventId', async (c) => {
  const ev = await c.env.DB.prepare('SELECT screenshot_key FROM run_events WHERE id=? AND run_id=?').bind(c.req.param('eventId'), c.req.param('id')).first<{ screenshot_key: string | null }>();
  if (!ev?.screenshot_key) return c.json({ error: 'Not found' }, 404);
  const obj = await c.env.DOCS.get(ev.screenshot_key);
  if (!obj) return c.json({ error: 'Not found' }, 404);
  return new Response(obj.body, { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' } });
});

app.post('/api/runs/:id/resume', async (c) => {
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(`UPDATE runs SET resume_requested=1, updated_at=datetime('now') WHERE id=? AND status='needs_human'`).bind(id).run();
  if (!res.meta.changes) return c.json({ error: 'This run is not waiting for you' }, 400);
  await addRunEvent(c.env, id, `${c.get('user')} finished the manual step and asked the agent to continue`);
  return c.json({ ok: true });
});

app.post('/api/runs/:id/cancel', async (c) => {
  const id = c.req.param('id');
  const run = await c.env.DB.prepare('SELECT status FROM runs WHERE id=?').bind(id).first<{ status: string }>();
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) return c.json({ error: 'This run has already finished' }, 400);
  if (run.status === 'queued') {
    await c.env.DB.prepare(`UPDATE runs SET status='cancelled', note='Cancelled before the agent started', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(id).run();
  } else {
    await c.env.DB.prepare(`UPDATE runs SET cancel_requested=1, updated_at=datetime('now') WHERE id=?`).bind(id).run();
  }
  await addRunEvent(c.env, id, `${c.get('user')} cancelled the run`, 'warn');
  return c.json({ ok: true });
});

// ---------- settings + admin ----------

app.get('/api/settings', async (c) => {
  const env = c.env;
  const sandboxSubs = await env.DB.prepare('SELECT id, at, payload_json FROM sandbox_submissions ORDER BY id DESC LIMIT 5').all();
  return c.json({
    default_mode: await getSetting(env, 'default_mode', 'test'),
    auto_approve_facts: (await getSetting(env, 'auto_approve_facts', '0')) === '1',
    agent_engine: await getSetting(env, 'agent_engine', 'builtin'),
    kb_version: await kbVersion(env),
    agent: await agentStatus(env),
    legacy_available: !!env.LEGACY_DB,
    ai_configured: !!env.DEEPSEEK_API_KEY,
    agent_configured: !!env.AGENT_TOKEN,
    seed_grants: SEEDS.length,
    sandbox_submissions: sandboxSubs.results,
  });
});

app.patch('/api/settings', async (c) => {
  const b = await c.req.json<Record<string, unknown>>();
  if (b.default_mode === 'test' || b.default_mode === 'live') await setSetting(c.env, 'default_mode', b.default_mode);
  if (b.agent_engine === 'builtin' || b.agent_engine === 'hermes') await setSetting(c.env, 'agent_engine', b.agent_engine);
  if ('auto_approve_facts' in b) await setSetting(c.env, 'auto_approve_facts', b.auto_approve_facts ? '1' : '0');
  return c.json({ ok: true });
});

app.get('/api/admin/agent-install', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    command: `curl -fsSL ${origin}/agent/install.sh | bash -s -- ${origin} ${c.env.AGENT_TOKEN}`,
    version: AGENT.version,
  });
});

app.post('/api/admin/seed', async (c) => c.json({ result: await applySeeds(c.env) }));

app.post('/api/admin/import-legacy', async (c) => {
  const imported = await importLegacy(c.env);
  const seeded = await applySeeds(c.env);
  return c.json({ imported, seeded });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// ---------- the UI (built by Vite, packed into the Worker) ----------

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
};

app.get('*', (c) => {
  const path = new URL(c.req.url).pathname;
  const file = CLIENT[path];
  if (file) {
    const body = file.base64 ? Uint8Array.from(atob(file.body), (ch) => ch.charCodeAt(0)) : file.body;
    return new Response(body, {
      headers: { 'content-type': file.type, 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', ...SECURITY_HEADERS },
    });
  }
  if (path.startsWith('/assets/')) return c.text('Not found', 404);
  // Any other path is a page inside the single-page app.
  return new Response(CLIENT['/index.html'].body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...SECURITY_HEADERS } });
});

// ---------- scheduled work ----------

async function scheduled(env: Env): Promise<void> {
  // New verified grant data shipped with a deploy is applied automatically.
  const bundleHash = await sha256Hex(JSON.stringify(SEEDS));
  if ((await getSetting(env, 'seed_bundle_hash')) !== bundleHash) await applySeeds(env);

  // Runs the agent abandoned (VM rebooted, agent crashed) should not look alive forever.
  const { results: stale } = await env.DB.prepare(
    `SELECT id FROM runs WHERE (status='running' AND updated_at < datetime('now','-30 minutes')) OR (status='needs_human' AND updated_at < datetime('now','-1 day'))`,
  ).all<{ id: string }>();
  for (const r of stale) {
    await env.DB.prepare(`UPDATE runs SET status='failed', note='The agent stopped responding', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).bind(r.id).run();
    await addRunEvent(env, r.id, 'Marked as failed: no word from the browser agent for too long', 'error');
  }

  // Knowledge changed since some open questions were last checked: see whether they can be answered now.
  if (env.DEEPSEEK_API_KEY) {
    await reuseExistingAnswers(env);
    await runInference(env, { maxQuestions: 160 });
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(scheduled(env)),
} satisfies ExportedHandler<Env>;

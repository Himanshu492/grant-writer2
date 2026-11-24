import type { Env, GrantRow, QuestionRow, SeedGrant, SeedQuestion } from './types';
import { SHORT_TYPES, daysUntil, fitsLimit, norm, parseJson, sha256Hex, uid } from './util';

// ---------- settings ----------

export async function getSetting(env: Env, key: string, fallback = ''): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run();
}

export async function kbVersion(env: Env): Promise<number> {
  return Number(await getSetting(env, 'kb_version', '1')) || 1;
}

/** Call whenever the company knowledge changes (a fact edited, an answer approved). Triggers re-inference of open questions. */
export async function bumpKbVersion(env: Env): Promise<number> {
  const v = (await kbVersion(env)) + 1;
  await setSetting(env, 'kb_version', String(v));
  return v;
}

// ---------- grants + progress ----------

export interface GrantProgress {
  total: number;      // questions that must be done before applying (required or unknown)
  done: number;       // approved or skipped among those
  suggested: number;  // inferred from the knowledge base, waiting for a one-click confirm
  draft: number;      // AI/human drafts not yet approved
  empty: number;      // truly need new information
  optional_open: number;
  all: number;
}

const PROGRESS_SQL = `
  SELECT grant_id,
    count(*) AS all_q,
    sum(CASE WHEN required IS NULL OR required=1 THEN 1 ELSE 0 END) AS total,
    sum(CASE WHEN (required IS NULL OR required=1) AND answer_status IN ('approved','skipped') THEN 1 ELSE 0 END) AS done,
    sum(CASE WHEN (required IS NULL OR required=1) AND answer_status='suggested' THEN 1 ELSE 0 END) AS suggested,
    sum(CASE WHEN (required IS NULL OR required=1) AND answer_status='draft' THEN 1 ELSE 0 END) AS draft,
    sum(CASE WHEN (required IS NULL OR required=1) AND answer_status='empty' THEN 1 ELSE 0 END) AS empty,
    sum(CASE WHEN required=0 AND answer_status NOT IN ('approved','skipped') THEN 1 ELSE 0 END) AS optional_open
  FROM questions GROUP BY grant_id`;

export async function allProgress(env: Env): Promise<Map<string, GrantProgress>> {
  const { results } = await env.DB.prepare(PROGRESS_SQL).all<Record<string, number | string>>();
  const map = new Map<string, GrantProgress>();
  for (const r of results) {
    map.set(String(r.grant_id), {
      all: Number(r.all_q), total: Number(r.total), done: Number(r.done), suggested: Number(r.suggested),
      draft: Number(r.draft), empty: Number(r.empty), optional_open: Number(r.optional_open),
    });
  }
  return map;
}

export const EMPTY_PROGRESS: GrantProgress = { all: 0, total: 0, done: 0, suggested: 0, draft: 0, empty: 0, optional_open: 0 };

export function grantView(g: GrantRow, p: GrantProgress | undefined, lastRun?: Record<string, unknown> | null) {
  const progress = p ?? EMPTY_PROGRESS;
  const remaining = progress.total - progress.done;
  return {
    id: g.id,
    title: g.title,
    funder: g.funder,
    program_url: g.program_url,
    application_url: g.application_url,
    status: g.status,
    deadline: g.deadline,
    deadline_note: g.deadline_note,
    days_left: daysUntil(g.deadline),
    amount: g.amount,
    rating: g.rating,
    priority_rank: g.priority_rank,
    pipeline: g.pipeline,
    summary: parseJson<Record<string, string>>(g.summary_json, {}),
    portal: parseJson<Record<string, unknown>>(g.portal_json, {}),
    questions_verification: g.questions_verification,
    questions_source_url: g.questions_source_url,
    questions_verified_on: g.questions_verified_on,
    questions_note: g.questions_note,
    sources: parseJson<{ url: string; note?: string }[]>(g.sources_json, []),
    is_sandbox: !!g.is_sandbox,
    live_enabled: !!g.live_enabled,
    submitted_at: g.submitted_at,
    progress,
    remaining,
    ready: progress.total > 0 && remaining === 0,
    last_run: lastRun ?? null,
  };
}

export function questionView(q: QuestionRow) {
  return {
    id: q.id,
    grant_id: q.grant_id,
    position: q.position,
    section: q.section,
    text: q.text,
    help: q.help,
    type: q.type,
    options: parseJson<string[]>(q.options_json, []),
    required: q.required === null ? null : !!q.required,
    limit: q.limit_unit && q.limit_max ? { unit: q.limit_unit, max: q.limit_max } : null,
    doc_kind: q.doc_kind,
    origin: q.origin,
    source_url: q.source_url,
    answer: q.answer,
    status: q.answer_status,
    answer_origin: q.answer_origin,
    confidence: q.answer_confidence,
    basis: q.answer_basis,
    missing_info: q.missing_info,
    document_id: q.document_id,
    updated_at: q.updated_at,
    updated_by: q.updated_by,
  };
}

// ---------- answers ----------

/**
 * When an answer is approved, the same question on other grants should never be asked again.
 * Identical short factual fields are approved automatically; identical narrative questions are
 * pre-filled as suggestions (the right answer may differ per funder), as is anything that breaks a limit.
 */
export async function propagateAnswer(env: Env, q: QuestionRow, user: string): Promise<number> {
  if (!q.answer.trim() || q.type === 'file') return 0;
  const { results } = await env.DB.prepare(
    `SELECT * FROM questions WHERE norm=? AND id<>? AND answer_status IN ('empty','suggested') AND type<>'file'`,
  ).bind(q.norm, q.id).all<QuestionRow>();
  const stmts: D1PreparedStatement[] = [];
  for (const other of results) {
    const sameOptions = other.options_json === q.options_json;
    const fits = fitsLimit(q.answer, other.limit_unit, other.limit_max);
    const auto = SHORT_TYPES.has(other.type) && SHORT_TYPES.has(q.type) && sameOptions && fits;
    stmts.push(
      env.DB.prepare(
        `UPDATE questions SET answer=?, answer_status=?, answer_origin='reused', answer_confidence='high', answer_basis=?, missing_info=NULL,
           updated_at=datetime('now'), updated_by=? WHERE id=?`,
      ).bind(q.answer, auto ? 'approved' : 'suggested', `Same question already answered for ${q.grant_id}`, user, other.id),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** File questions are satisfied automatically once a document of the right kind has been uploaded. */
export async function autolinkDocuments(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE questions SET
        document_id=(SELECT d.id FROM documents d WHERE d.kind=questions.doc_kind ORDER BY d.uploaded_at DESC LIMIT 1),
        answer_status='approved', answer_origin='reused', answer_basis='Document already uploaded', updated_at=datetime('now')
      WHERE type='file' AND document_id IS NULL AND doc_kind IS NOT NULL AND doc_kind<>'other' AND answer_status IN ('empty','suggested')
        AND EXISTS (SELECT 1 FROM documents d WHERE d.kind=questions.doc_kind)`,
  ).run();
  return res.meta.changes ?? 0;
}

// ---------- seeding verified grant data ----------

function seedQuestionFields(sq: SeedQuestion) {
  const type = sq.type || 'long_text';
  return {
    section: sq.section ?? '',
    text: sq.text.trim(),
    help: sq.help ?? '',
    type,
    options_json: JSON.stringify(sq.options ?? []),
    required: sq.required === null || sq.required === undefined ? null : sq.required ? 1 : 0,
    limit_unit: sq.limit?.unit ?? null,
    limit_max: sq.limit?.max ?? null,
    doc_kind: type === 'file' ? sq.doc_kind ?? 'other' : null,
    source_url: sq.source_url ?? null,
  };
}

/**
 * Insert or update a grant from a verified seed file. Answers are never lost: questions are matched to the
 * existing ones by normalised text, and an answered question that no longer exists on the form is moved to
 * the knowledge base instead of being deleted.
 */
export async function upsertSeedGrant(env: Env, seed: SeedGrant): Promise<'created' | 'updated' | 'unchanged'> {
  const hash = await sha256Hex(JSON.stringify(seed));
  const existing = await env.DB.prepare('SELECT * FROM grants WHERE id=?').bind(seed.id).first<GrantRow>();
  if (existing && existing.seed_hash === hash) return 'unchanged';

  const fields = [
    seed.title, seed.funder ?? '', seed.program_url ?? null, seed.application_url ?? null, seed.status ?? 'unknown',
    seed.deadline ?? null, seed.deadline_note ?? '', seed.amount ?? null, JSON.stringify(seed.summary ?? {}),
    JSON.stringify(seed.portal ?? {}), seed.questions_verification ?? 'unverified', seed.questions_source_url ?? null,
    seed.questions_verified_on ?? null, seed.questions_note ?? '', JSON.stringify(seed.sources ?? []), hash,
    seed.is_sandbox ? 1 : 0,
  ];
  const stmts: D1PreparedStatement[] = [];
  if (existing) {
    stmts.push(env.DB.prepare(
      `UPDATE grants SET title=?, funder=?, program_url=?, application_url=?, status=?, deadline=?, deadline_note=?, amount=?,
         summary_json=?, portal_json=?, questions_verification=?, questions_source_url=?, questions_verified_on=?, questions_note=?,
         sources_json=?, seed_hash=?, is_sandbox=?, updated_at=datetime('now') WHERE id=?`,
    ).bind(...fields, seed.id));
  } else {
    stmts.push(env.DB.prepare(
      `INSERT INTO grants(title, funder, program_url, application_url, status, deadline, deadline_note, amount, summary_json, portal_json,
         questions_verification, questions_source_url, questions_verified_on, questions_note, sources_json, seed_hash, is_sandbox, id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(...fields, seed.id));
  }

  await env.DB.batch(stmts);
  // A scan of the live form by the browser agent is more authoritative than bundled research: never overwrite it.
  if (existing?.questions_verification === 'agent_scan') {
    await env.DB.prepare(
      `UPDATE grants SET questions_verification='agent_scan', questions_source_url=?, questions_verified_on=?, questions_note=? WHERE id=?`,
    ).bind(existing.questions_source_url, existing.questions_verified_on, existing.questions_note, seed.id).run();
  } else if ((seed.questions ?? []).length || !existing) {
    await syncQuestions(env, seed.id, seed.title, seed.questions ?? [], 'seed');
  }
  return existing ? 'updated' : 'created';
}

/**
 * Make a grant's question list match `list` (the real form, in order) without ever losing an answer.
 * `origin` is 'seed' (verified research bundled with the app) or 'agent_scan' (read off the live form by the browser agent).
 * Hand-added questions are kept after the synced ones. Verified seed data replaces the list; a scan only merges into it.
 */
export async function syncQuestions(
  env: Env, grantId: string, grantTitle: string, list: SeedQuestion[], origin: 'seed' | 'agent_scan',
  opts: { removeMissing?: boolean } = {},
): Promise<{ added: number; kept: number; removed: number }> {
  // A scan often sees only the steps it can reach without typing, so by default it only ever adds and updates.
  const removeMissing = opts.removeMissing ?? origin === 'seed';
  const stmts: D1PreparedStatement[] = [];
  const { results: old } = await env.DB.prepare(`SELECT * FROM questions WHERE grant_id=? ORDER BY position`).bind(grantId).all<QuestionRow>();
  const replaceable = (o: QuestionRow) => o.origin !== 'manual';
  const byNorm = new Map<string, QuestionRow[]>();
  for (const q of old) {
    const l = byNorm.get(q.norm) ?? [];
    l.push(q);
    byNorm.set(q.norm, l);
  }
  const used = new Set<string>();
  let pos = 0, added = 0, kept = 0, removed = 0;
  for (const sq of list) {
    if (!sq.text?.trim()) continue;
    pos += 1;
    const f = seedQuestionFields(sq);
    const n = norm(f.text);
    const match = byNorm.get(n)?.shift();
    if (match) {
      used.add(match.id);
      kept += 1;
      stmts.push(env.DB.prepare(
        `UPDATE questions SET position=?, section=?, text=?, help=?, type=?, options_json=?, required=?, limit_unit=?, limit_max=?, doc_kind=?, source_url=?, origin=? WHERE id=?`,
      ).bind(pos, f.section, f.text, f.help, f.type, f.options_json, f.required, f.limit_unit, f.limit_max, f.doc_kind, f.source_url ?? match.source_url, match.origin === 'manual' ? 'manual' : origin, match.id));
    } else {
      added += 1;
      stmts.push(env.DB.prepare(
        `INSERT INTO questions(id, grant_id, position, section, text, help, type, options_json, required, limit_unit, limit_max, doc_kind, norm, origin, source_url)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(uid('q'), grantId, pos, f.section, f.text, f.help, f.type, f.options_json, f.required, f.limit_unit, f.limit_max, f.doc_kind, n, origin, f.source_url));
    }
  }
  for (const q of old) {
    if (used.has(q.id)) continue;
    if (!removeMissing || !replaceable(q)) {
      pos += 1;
      stmts.push(env.DB.prepare('UPDATE questions SET position=? WHERE id=?').bind(pos, q.id));
      continue;
    }
    // No longer on the form: keep any real answer as knowledge, then remove the question.
    removed += 1;
    if (q.answer.trim() && (q.answer_status === 'approved' || q.answer_status === 'draft') && q.type !== 'file') {
      stmts.push(env.DB.prepare(
        `INSERT INTO knowledge(id, category, title, content, notes, source) VALUES(?,?,?,?,?,?)`,
      ).bind(uid('k'), 'other', q.text.slice(0, 200), q.answer, `Answer to a question that is no longer on the ${grantTitle} form.`, 'retired_question'));
    }
    stmts.push(env.DB.prepare('DELETE FROM questions WHERE id=?').bind(q.id));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  return { added, kept, removed };
}

/** After new questions appear, give them any answer the same question already has on another grant. */
export async function reuseExistingAnswers(env: Env, grantId?: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT q.id, q.type, q.options_json, q.limit_unit, q.limit_max,
            s.answer AS s_answer, s.type AS s_type, s.options_json AS s_options, s.grant_id AS s_grant
       FROM questions q
       JOIN questions s ON s.norm=q.norm AND s.id<>q.id AND s.answer_status='approved' AND s.answer<>'' AND s.type<>'file'
      WHERE q.answer_status='empty' AND q.type<>'file' ${grantId ? 'AND q.grant_id=?' : ''}
      GROUP BY q.id`,
  ).bind(...(grantId ? [grantId] : [])).all<Record<string, string | number | null>>();
  const stmts: D1PreparedStatement[] = [];
  for (const r of results) {
    const answer = String(r.s_answer);
    const auto = SHORT_TYPES.has(String(r.type)) && SHORT_TYPES.has(String(r.s_type)) && r.options_json === r.s_options &&
      fitsLimit(answer, r.limit_unit as string | null, r.limit_max as number | null);
    stmts.push(env.DB.prepare(
      `UPDATE questions SET answer=?, answer_status=?, answer_origin='reused', answer_confidence='high', answer_basis=?, updated_at=datetime('now') WHERE id=?`,
    ).bind(answer, auto ? 'approved' : 'suggested', `Same question already answered for ${r.s_grant}`, r.id));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  return stmts.length;
}

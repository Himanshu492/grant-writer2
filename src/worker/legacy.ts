import type { Env } from './types';
import { titleLegacyEntries } from './ai';
import { autolinkDocuments, bumpKbVersion } from './data';

/**
 * One-time import from the old "grant operations" database. Only two things are taken over, as agreed:
 *   1. the list of grants (name, links, deadline, rating, the funder profile text), and
 *   2. everything the team had already answered, which becomes the knowledge base.
 * The old per-grant question lists are NOT imported - they were unreliable. Real questions come from verified seed files.
 * Safe to run more than once: existing rows are left alone.
 */
export async function importLegacy(env: Env): Promise<Record<string, unknown>> {
  const old = env.LEGACY_DB;
  if (!old) throw new Error('The old database is not bound to this deployment (LEGACY_DB). Deploy with wrangler.legacy.jsonc to import.');
  const out: Record<string, unknown> = {};

  // 1. Grants (skip the old test fixtures).
  const { results: grants } = await old.prepare(
    `SELECT g.*, p.at_a_glance, p.what_they_offer, p.what_theyre_looking_for, p.who_can_apply, p.worth_noting, p.how_to_apply, p.sources_json
       FROM grants g LEFT JOIN grant_profiles p ON p.company_id=g.company_id AND p.grant_id=g.id
      WHERE g.id NOT LIKE 'test-%'`,
  ).all<Record<string, string | number | null>>();
  let grantsAdded = 0;
  for (const g of grants) {
    const summary = {
      at_a_glance: g.at_a_glance ?? '', what_they_offer: g.what_they_offer ?? '', what_theyre_looking_for: g.what_theyre_looking_for ?? '',
      who_can_apply: g.who_can_apply ?? '', how_to_apply: g.how_to_apply ?? '', worth_noting: g.worth_noting ?? '',
    };
    const res = await env.DB.prepare(
      `INSERT INTO grants(id, title, funder, program_url, application_url, deadline, deadline_note, rating, priority_rank, pipeline, summary_json, questions_verification, questions_note)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,'unverified','Imported from the old system without questions. Waiting for verified questions.')
       ON CONFLICT(id) DO UPDATE SET rating=excluded.rating, priority_rank=excluded.priority_rank`,
    ).bind(g.id, g.title, g.funder, g.url, g.application_url, g.deadline, g.deadline_note ?? '', g.rating ?? '', g.priority_rank,
      g.pursuit_status === 'not_pursuing' ? 'not_pursuing' : 'active', JSON.stringify(summary)).run();
    grantsAdded += res.meta.changes ? 1 : 0;
  }
  out.grants = grantsAdded;

  // 2. Answered questions -> knowledge base.
  const { results: bank } = await old.prepare(
    `SELECT number, question, answer, internal_notes, prompt FROM question_bank
      WHERE status='answered' AND trim(answer)<>'' AND source NOT LIKE 'TEST%' ORDER BY number`,
  ).all<{ number: number; question: string; answer: string; internal_notes: string | null; prompt: string | null }>();
  const { results: have } = await env.DB.prepare(`SELECT id FROM knowledge WHERE source='legacy_import'`).all<{ id: string }>();
  const haveIds = new Set(have.map((h) => h.id));
  const fresh = bank.filter((b) => !haveIds.has(`legacy_${b.number}`));
  const titles = fresh.length ? await titleLegacyEntries(env, fresh.map((b) => ({ n: b.number, question: b.question, answer: b.answer }))) : new Map();
  const stmts: D1PreparedStatement[] = [];
  for (const b of fresh) {
    // The old question text is a merge of several forms' labels: `TS-BAL FORM “First name” PNP FORM “First Name” https://... · sources/x.html`
    const labels = [...new Set([...b.question.matchAll(/[“"]([^”"]{2,200})[”"]/g)].map((m) => m[1].trim()))];
    const t = titles.get(b.number);
    const title = t?.title ?? b.prompt?.trim() ?? labels[0] ?? `Answer ${b.number}`;
    const notes = [labels.length ? `Originally asked as: ${labels.slice(0, 8).map((l) => `"${l}"`).join(' / ')}` : '', b.internal_notes?.trim() ?? '']
      .filter(Boolean).join('\n');
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO knowledge(id, category, title, content, notes, source, updated_by) VALUES(?,?,?,?,?,'legacy_import','import')`,
    ).bind(`legacy_${b.number}`, t?.category ?? 'other', title.slice(0, 200), b.answer.trim(), notes));
  }
  // Per-grant approved answers from the old system (non-test) are knowledge too.
  const { results: qga } = await old.prepare(
    `SELECT a.question_id, a.grant_id, a.answer, b.question, b.prompt FROM question_grant_answers a
       LEFT JOIN question_bank b ON b.company_id=a.company_id AND b.id=a.question_id
      WHERE a.grant_id NOT LIKE 'test-%' AND a.question_id NOT LIKE 'test-%'`,
  ).all<Record<string, string | null>>();
  for (const a of qga) {
    const id = `legacy_ga_${a.question_id}_${a.grant_id}`;
    if (haveIds.has(id)) continue;
    const label = a.prompt?.trim() || [...(a.question ?? '').matchAll(/[“"]([^”"]{2,200})[”"]/g)][0]?.[1] || String(a.question_id);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO knowledge(id, category, title, content, notes, source, updated_by) VALUES(?,?,?,?,?,'legacy_import','import')`,
    ).bind(id, 'other', `${label} (answer given for ${a.grant_id})`.slice(0, 200), String(a.answer).trim(), ''));
  }
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
  out.knowledge = stmts.length;

  // 3. Documents: copy each distinct file into the new bucket (the old system stored the same deck several times).
  let docs = 0;
  if (env.LEGACY_DOCS) {
    const { results: oldDocs } = await old.prepare('SELECT * FROM documents ORDER BY uploaded_at DESC').all<Record<string, string | number | null>>();
    const seen = new Set<string>();
    for (const d of oldDocs) {
      const sig = `${d.filename}|${d.size}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const exists = await env.DB.prepare('SELECT id FROM documents WHERE filename=? AND size=?').bind(d.filename, d.size).first();
      if (exists) continue;
      const obj = await env.LEGACY_DOCS.get(String(d.object_key));
      if (!obj) continue;
      const id = `doc_${String(d.id).slice(0, 8)}`;
      const key = `documents/${id}/${d.filename}`;
      await env.DOCS.put(key, obj.body, { httpMetadata: { contentType: String(d.mime) } });
      const label = String(d.label ?? '');
      const kind = /deck|pitch/i.test(label + d.filename) ? 'pitch_deck' : 'other';
      await env.DB.prepare(
        `INSERT INTO documents(id, kind, label, filename, mime, size, r2_key, uploaded_by) VALUES(?,?,?,?,?,?,?,'import')`,
      ).bind(id, kind, label || String(d.filename), d.filename, d.mime, d.size, key).run();
      docs += 1;
    }
    await autolinkDocuments(env);
  }
  out.documents = docs;
  if (stmts.length) await bumpKbVersion(env);
  return out;
}

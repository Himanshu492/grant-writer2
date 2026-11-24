import type { Env, GrantRow, QuestionRow } from './types';
import { getSetting, kbVersion } from './data';
import { SHORT_TYPES, fitsLimit, parseJson } from './util';

interface ChatOpts {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

/** One DeepSeek chat call that must return a JSON object. */
export async function chatJson<T>(env: Env, opts: ChatOpts): Promise<T> {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  let lastError: Error = new Error('DeepSeek call failed');
  // JSON mode occasionally returns blank or truncated content; one retry clears almost all of those.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${env.DEEPSEEK_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          response_format: { type: 'json_object' },
          max_tokens: opts.maxTokens ?? 8000,
          temperature: opts.temperature ?? 0.2,
        }),
      });
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      const content = data.choices?.[0]?.message?.content ?? '';
      try {
        return JSON.parse(content) as T;
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]) as T;
        throw new Error('The AI returned something that is not JSON');
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError;
}

/** Everything the company has told us, as one text block: curated facts plus every approved answer. */
export async function knowledgeText(env: Env): Promise<string> {
  const [{ results: facts }, { results: answers }, { results: docs }] = await Promise.all([
    env.DB.prepare('SELECT id, category, title, content, notes FROM knowledge ORDER BY category, title').all<Record<string, string>>(),
    env.DB.prepare(
      `SELECT q.norm, q.text, q.answer, g.title AS grant_title FROM questions q JOIN grants g ON g.id=q.grant_id
        WHERE q.answer_status='approved' AND q.answer<>'' AND q.type<>'file' AND g.is_sandbox=0 ORDER BY q.updated_at DESC`,
    ).all<Record<string, string>>(),
    env.DB.prepare('SELECT kind, label, filename FROM documents ORDER BY uploaded_at DESC').all<Record<string, string>>(),
  ]);
  const lines: string[] = ['# COMPANY KNOWLEDGE BASE', ''];
  for (const f of facts) {
    lines.push(`- [${f.category}] ${f.title}: ${f.content}`);
    if (f.notes?.trim()) lines.push(`    (internal context, do not quote: ${f.notes.trim().replace(/\s+/g, ' ')})`);
  }
  const seen = new Set<string>();
  const approved: string[] = [];
  for (const a of answers) {
    const key = a.norm + '|' + a.answer;
    if (seen.has(key)) continue;
    seen.add(key);
    approved.push(`- (${a.grant_title}) Q: ${a.text}\n  A: ${a.answer}`);
  }
  if (approved.length) lines.push('', '# ANSWERS THE TEAM HAS ALREADY APPROVED ON OTHER APPLICATIONS', '', ...approved);
  if (docs.length) lines.push('', '# DOCUMENTS ON FILE', '', ...docs.map((d) => `- ${d.kind}: ${d.label || d.filename}`));
  return lines.join('\n');
}

const INFER_SYSTEM = `You fill in grant and accelerator application forms for a company, using ONLY the company's knowledge base.
For every question, decide whether the knowledge base contains enough to answer it truthfully, and if so write the exact text to type into that form field.

Rules:
- Never invent facts, numbers, names, dates or URLs. Use only what the knowledge base states or what follows directly from it
  (a founding date answers "What year was your company founded?"; a founder's LinkedIn URL answers "Founder LinkedIn profile";
  the registered address answers "City", "State" and "Country").
- The answer is exactly what goes in the field: no preamble, no explanation, no notes about other programs. Short fields get the bare value
  ("Acme Health LLC", "2025", "https://...").
- Personal fields such as "First name", "Email" or "Phone" refer to the applicant's primary point of contact unless the question says otherwise.
- single_select / multi_select: answer only with option labels exactly as given (multi_select: join with "; "). If no option clearly fits, it is not answerable.
- yes_no: answer "Yes" or "No" only when the knowledge base settles it.
- Respect the character or word limit when one is given.
- Narrative questions (long_text): if the knowledge base has the substance, write a concise, faithful answer in the company's own wording.
- Program-specific questions ("Why this program?", "How did you hear about us?", referral codes, program-specific IDs) are answerable only if the
  knowledge base has information specific to that program.
- confidence "high" = stated directly in the knowledge base; "medium" = assembled or condensed from it. If you would have to guess, it is NOT answerable.
- If not answerable: set answerable=false and write "missing": one short sentence telling the team exactly what information to provide.
- "basis": a few words naming which knowledge the answer came from.
- "missing" must be short: at most 12 words, naming only the fact needed (for example "CEO email address").
- Never use em dashes or en dashes anywhere; use commas or full stops.

Return JSON: {"results":[{"id":"...","answerable":true,"answer":"...","confidence":"high","basis":"...","missing":""}]} with one result per question id.`;

interface InferResult {
  id: string;
  answerable: boolean;
  answer?: string;
  confidence?: string;
  basis?: string;
  missing?: string;
}

function describeQuestion(q: QuestionRow, grantTitle: string): Record<string, unknown> {
  const d: Record<string, unknown> = { id: q.id, program: grantTitle, question: q.text, type: q.type };
  if (q.section) d.section = q.section;
  if (q.help) d.help = q.help;
  const options = parseJson<string[]>(q.options_json, []);
  if (options.length) d.options = options;
  if (q.limit_unit && q.limit_max) d.limit = `${q.limit_max} ${q.limit_unit}`;
  return d;
}

/** Our generated text never contains em or en dashes. */
export function noDash(s: string): string {
  return s.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/,\s*,/g, ',');
}

export interface InferenceSummary {
  checked: number;
  suggested: number;
  approved: number;
  still_missing: number;
  errors: string[];
}

/**
 * Try to answer open questions from the knowledge base. Answers land as "suggested" (one click to confirm),
 * or are approved outright for short factual fields when the team has switched that on in Settings.
 */
export async function runInference(env: Env, opts: { grantId?: string; maxQuestions?: number; force?: boolean } = {}): Promise<InferenceSummary> {
  const version = await kbVersion(env);
  const autoApprove = (await getSetting(env, 'auto_approve_facts', '0')) === '1';
  const where = [`q.answer_status='empty'`, `q.type<>'file'`, `g.pipeline='active'`];
  const binds: (string | number)[] = [];
  if (!opts.force) {
    where.push('q.inferred_kb_version<?');
    binds.push(version);
  }
  if (opts.grantId) {
    where.push('q.grant_id=?');
    binds.push(opts.grantId);
  }
  const { results: rows } = await env.DB.prepare(
    `SELECT q.*, g.title AS grant_title FROM questions q JOIN grants g ON g.id=q.grant_id
      WHERE ${where.join(' AND ')} ORDER BY q.inferred_kb_version, (g.deadline IS NULL), g.deadline, q.grant_id, q.position LIMIT ?`,
  ).bind(...binds, opts.maxQuestions ?? 160).all<QuestionRow & { grant_title: string }>();

  const summary: InferenceSummary = { checked: rows.length, suggested: 0, approved: 0, still_missing: 0, errors: [] };
  if (!rows.length) return summary;

  const kb = await knowledgeText(env);
  const batches: (QuestionRow & { grant_title: string })[][] = [];
  for (let i = 0; i < rows.length; i += 20) batches.push(rows.slice(i, i + 20));

  await Promise.all(batches.map(async (batch) => {
    try {
      const out = await chatJson<{ results: InferResult[] }>(env, {
        model: env.DEEPSEEK_MODEL_FAST,
        system: INFER_SYSTEM,
        user: `${kb}\n\n# QUESTIONS TO ANSWER\n${JSON.stringify(batch.map((q) => describeQuestion(q, q.grant_title)), null, 1)}`,
        maxTokens: 12000,
        temperature: 0,
      });
      const byId = new Map((out.results ?? []).map((r) => [r.id, r]));
      const stmts: D1PreparedStatement[] = [];
      for (const q of batch) {
        const r = byId.get(q.id);
        const answer = noDash((r?.answer ?? '').trim());
        const options = parseJson<string[]>(q.options_json, []);
        const optionOk = !options.length || q.type === 'multi_select'
          ? true
          : options.some((o) => o.toLowerCase() === answer.toLowerCase());
        const ok = !!r?.answerable && !!answer && (r.confidence === 'high' || r.confidence === 'medium') &&
          fitsLimit(answer, q.limit_unit, q.limit_max) && optionOk;
        if (ok) {
          const approve = autoApprove && r!.confidence === 'high' && SHORT_TYPES.has(q.type);
          if (approve) summary.approved += 1; else summary.suggested += 1;
          stmts.push(env.DB.prepare(
            `UPDATE questions SET answer=?, answer_status=?, answer_origin='inferred', answer_confidence=?, answer_basis=?, missing_info=NULL,
               inferred_kb_version=?, updated_at=datetime('now'), updated_by='knowledge base'
             WHERE id=? AND answer_status='empty'`,
          ).bind(answer, approve ? 'approved' : 'suggested', r!.confidence!, noDash(r!.basis ?? '').slice(0, 300), version, q.id));
        } else {
          summary.still_missing += 1;
          stmts.push(env.DB.prepare(
            `UPDATE questions SET missing_info=?, inferred_kb_version=? WHERE id=? AND answer_status='empty'`,
          ).bind(noDash(r?.missing ?? '').slice(0, 200) || null, version, q.id));
        }
      }
      if (stmts.length) await env.DB.batch(stmts);
    } catch (e) {
      summary.errors.push(e instanceof Error ? e.message : String(e));
    }
  }));
  return summary;
}

const DRAFT_SYSTEM = `You write answers for a company's grant and accelerator applications.
You are given the company's knowledge base, what this funder is looking for, and one application question.
Write the best possible answer for THIS funder.

Rules:
- Use only facts from the knowledge base. Never invent numbers, customers, partnerships, credentials, dates or quotes.
- If a fact the answer really needs is missing, still write the strongest truthful answer you can and put a bracketed placeholder
  where the fact belongs, like [ADD: monthly active users]. List each missing fact in "missing".
- If the question is a basic factual field (a name, an email, a number, a date, a URL, a yes/no, a choice) and the knowledge base does not
  contain the value, do NOT write prose: return an empty "answer" and say what is needed in "missing".
- Speak as the company ("we"). Plain, specific, confident. No buzzword filler, no headings, no markdown, no preamble.
- Tailor emphasis to what the funder says it looks for, without flattery and without claiming things that are not in the knowledge base.
- Stay within the limit if one is given (aim for 85-95% of it). With no limit, be as long as the question deserves and no longer.
- For select questions answer with the exact option label(s).
- Never use em dashes or en dashes; use commas or full stops. Write like a founder, not like marketing copy.
- Each "missing" item is at most 8 words.

Return JSON: {"answer":"...","missing":["..."],"basis":"a few words on which knowledge was used"}`;

export interface DraftResult {
  answer: string;
  missing: string[];
  basis: string;
}

export async function draftAnswer(env: Env, q: QuestionRow, grant: GrantRow, guidance?: string): Promise<DraftResult> {
  const kb = await knowledgeText(env);
  const summary = parseJson<Record<string, string>>(grant.summary_json, {});
  const { results: siblings } = await env.DB.prepare(
    `SELECT text, answer FROM questions WHERE grant_id=? AND id<>? AND answer_status='approved' AND answer<>'' AND type<>'file' ORDER BY position LIMIT 40`,
  ).bind(grant.id, q.id).all<{ text: string; answer: string }>();
  const funder = [
    `Program: ${grant.title} (${grant.funder})`,
    summary.at_a_glance && `About: ${summary.at_a_glance}`,
    summary.what_they_offer && `What they offer: ${summary.what_they_offer}`,
    summary.what_theyre_looking_for && `What they are looking for: ${summary.what_theyre_looking_for}`,
    summary.who_can_apply && `Who can apply: ${summary.who_can_apply}`,
  ].filter(Boolean).join('\n');
  const user = [
    kb,
    '\n# THIS FUNDER\n' + funder,
    siblings.length ? '\n# ALREADY ANSWERED ON THIS APPLICATION (stay consistent, do not repeat)\n' + siblings.map((s) => `Q: ${s.text}\nA: ${s.answer}`).join('\n') : '',
    '\n# QUESTION TO ANSWER\n' + JSON.stringify(describeQuestion(q, grant.title), null, 1),
    q.answer.trim() ? `\n# CURRENT TEXT IN THE FIELD (improve on it)\n${q.answer}` : '',
    guidance?.trim() ? `\n# INSTRUCTIONS FROM THE TEAM FOR THIS DRAFT\n${guidance.trim()}` : '',
  ].join('\n');
  const out = await chatJson<Partial<DraftResult>>(env, {
    model: env.DEEPSEEK_MODEL_WRITE,
    system: DRAFT_SYSTEM,
    user,
    maxTokens: 12000,
    temperature: 0.4,
  });
  return {
    answer: noDash(String(out.answer ?? '').trim()),
    missing: Array.isArray(out.missing) ? out.missing.map((m) => noDash(String(m))).filter(Boolean) : [],
    basis: noDash(String(out.basis ?? '')),
  };
}

export const KNOWLEDGE_CATEGORIES = [
  'company', 'contact', 'team', 'product', 'problem', 'market', 'traction', 'business_model', 'financials', 'legal', 'story', 'other',
] as const;

/** Turn the old system's merged question blobs into short titles + categories for the knowledge base. Content is never rewritten. */
export async function titleLegacyEntries(
  env: Env,
  entries: { n: number; question: string; answer: string }[],
): Promise<Map<number, { title: string; category: string }>> {
  const map = new Map<number, { title: string; category: string }>();
  for (let i = 0; i < entries.length; i += 60) {
    const chunk = entries.slice(i, i + 60);
    try {
      const out = await chatJson<{ items: { n: number; title: string; category: string }[] }>(env, {
        model: env.DEEPSEEK_MODEL_FAST,
        system: `You organise a company's knowledge base. Each item is a past answer the company gave, with the (messy, merged) application questions it answered.
For each item return a short neutral title naming the fact or topic (3-8 words, e.g. "Primary contact name", "Company legal name", "Problem being solved", "Founding team and roles")
and one category from: ${KNOWLEDGE_CATEGORIES.join(', ')}.
Do not include program names in titles. Return JSON {"items":[{"n":1,"title":"...","category":"..."}]}.`,
        user: JSON.stringify(chunk.map((e) => ({ n: e.n, questions: e.question.slice(0, 500), answer: e.answer.slice(0, 300) }))),
        temperature: 0,
      });
      for (const it of out.items ?? []) {
        const category = (KNOWLEDGE_CATEGORIES as readonly string[]).includes(it.category) ? it.category : 'other';
        if (it.title) map.set(Number(it.n), { title: String(it.title).slice(0, 120), category });
      }
    } catch {
      // Fall back to titles derived from the question text.
    }
  }
  return map;
}

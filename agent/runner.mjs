#!/usr/bin/env node
// Grants portal browser-agent runner.
//
// Lives on the VM. Polls the portal for "Apply" jobs, drives ONE long-lived, visible Chrome (so a human can take
// over through the live view), and reports progress back. Two engines can do the form filling:
//   - hermes  : hands the job to the Hermes agent already installed on the VM (attached to the same Chrome over CDP)
//   - builtin : a self-contained observe -> decide -> act loop (the model is reached through the portal)
// ENGINE=auto uses Hermes when it is installed and falls back to the builtin engine if Hermes cannot run the job.
//
// The browser profile is persistent, so a login or account the human creates once is still there next time.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));

const cfg = {
  portal: (process.env.PORTAL_URL || '').replace(/\/$/, ''),
  token: process.env.AGENT_TOKEN || '',
  engine: process.env.ENGINE || 'auto',
  dataDir: process.env.DATA_DIR || '/var/lib/grants-agent',
  headless: process.env.HEADLESS === '1',
  cdpPort: Number(process.env.CDP_PORT || 9222),
  chromePath: process.env.CHROME_PATH || undefined,
  hermesBin: process.env.HERMES_BIN || 'hermes',
  hermesModel: process.env.HERMES_MODEL || 'deepseek-v4-pro',
  hermesProvider: process.env.HERMES_PROVIDER || 'deepseek',
  maxSteps: Number(process.env.MAX_STEPS || 70),
  once: process.argv.includes('--once'),
};
if (!cfg.portal || !cfg.token) {
  console.error('PORTAL_URL and AGENT_TOKEN must be set (see /etc/grants-agent.env)');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (list) => [...new Set(list)];

// ---------- portal API ----------

async function portal(path, { method = 'GET', body, raw, headers } = {}) {
  const res = await fetch(`${cfg.portal}/api/agent${path}`, {
    method: body !== undefined || raw ? 'POST' : method,
    headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) throw new Error(`portal ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}
const portalJson = async (path, opts) => (await portal(path, opts)).json();

async function report(runId, fields) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await portalJson(`/runs/${runId}/update`, { body: fields });
    } catch (e) {
      log('report failed:', e.message);
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

function liveViewUrl() {
  try {
    return readFileSync(join(cfg.dataDir, 'live_view_url'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

let hermesVersion = null;
function detectHermes() {
  try {
    hermesVersion = execFileSync(cfg.hermesBin, ['--version'], { encoding: 'utf8', timeout: 20000 }).trim().split('\n')[0].slice(0, 80);
  } catch {
    hermesVersion = null;
  }
  return hermesVersion;
}

async function heartbeat(extra = {}) {
  try {
    await portal('/heartbeat', {
      body: { hostname: hostname(), version: VERSION, engine: cfg.engine, hermes: hermesVersion, live_view_url: liveViewUrl(), ...extra },
    });
  } catch (e) {
    log('heartbeat failed:', e.message);
  }
}

// ---------- the browser ----------

let context = null;
async function browser() {
  if (context) {
    try {
      context.pages();
      if (context.browser()?.isConnected() !== false) return context;
    } catch { /* relaunch below */ }
  }
  const profile = join(cfg.dataDir, 'profile');
  mkdirSync(profile, { recursive: true });
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(profile, lock), { force: true });
  context = await chromium.launchPersistentContext(profile, {
    headless: cfg.headless,
    executablePath: cfg.chromePath,
    viewport: cfg.headless ? { width: 1366, height: 900 } : null,
    acceptDownloads: false,
    proxy: process.env.BROWSER_PROXY ? { server: process.env.BROWSER_PROXY } : undefined,
    args: [
      `--remote-debugging-port=${cfg.cdpPort}`,
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
      '--window-position=0,0', '--window-size=1366,900', '--password-store=basic',
    ],
  });
  context.on('close', () => { context = null; });
  log('browser started');
  return context;
}

async function activePage(ctx) {
  const pages = ctx.pages().filter((p) => !p.isClosed());
  return pages[pages.length - 1] ?? (await ctx.newPage());
}

async function screenshot(runId, page, message) {
  try {
    const buf = await page.screenshot({ fullPage: true, type: 'png', timeout: 15000 }).catch(() => page.screenshot({ type: 'png', timeout: 15000 }));
    await portal(`/runs/${runId}/screenshot?message=${encodeURIComponent(message)}`, { raw: buf, headers: { 'content-type': 'image/png' } });
  } catch (e) {
    log('screenshot failed:', e.message);
  }
}

// ---------- page observation (runs inside every frame) ----------

function observeFrame({ prefix, includeHidden }) {
  const out = [];
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const labelOf = (el) => {
    const bits = [];
    if (el.labels) for (const l of el.labels) bits.push(clean(l.innerText));
    const aria = el.getAttribute('aria-label');
    if (aria) bits.push(clean(aria));
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) { const n = document.getElementById(id); if (n) bits.push(clean(n.innerText)); }
    const group = el.closest('fieldset, [role=group], [role=radiogroup]');
    if (group) {
      const lg = group.querySelector('legend') || (group.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby')));
      if (lg) bits.unshift('group: ' + clean(lg.innerText));
    }
    if (!bits.length) {
      let p = el.parentElement;
      for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
        const t = clean(p.innerText);
        if (t && t.length < 260) { bits.push(t); break; }
      }
    }
    const desc = el.getAttribute('aria-describedby');
    if (desc) for (const id of desc.split(/\s+/)) { const n = document.getElementById(id); if (n) bits.push('hint: ' + clean(n.innerText)); }
    if (el.placeholder) bits.push('placeholder: ' + clean(el.placeholder));
    return [...new Set(bits.filter(Boolean))].join(' | ').slice(0, 320);
  };
  const BUTTONISH = /next|continue|back|previous|apply|start|begin|save|submit|send|finish|review|log ?in|sign ?in|sign ?up|register|create|accept|agree|add|upload|ok|yes|no|close|proceed|get started/i;
  // Ids from an earlier look at the page must not linger on elements that are now hidden.
  for (const stale of document.querySelectorAll('[data-ga]')) stale.removeAttribute('data-ga');
  let n = 0;
  const nodes = document.querySelectorAll(
    'input, textarea, select, button, [role=button], a[href], [contenteditable=true], [contenteditable=""], [role=checkbox], [role=radio], [role=combobox], [role=textbox], [role=option], [role=switch], [role=tab]',
  );
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && ['hidden'].includes(type)) continue;
    const isFile = tag === 'input' && type === 'file';
    const shown = visible(el);
    const isField = ['input', 'textarea', 'select'].includes(tag);
    // When scanning, fields of later steps that are already in the page (just hidden) are worth reading too.
    if (!isFile && !shown && !(includeHidden && isField)) continue;
    const item = { id: '', kind: tag };
    if (!shown && !isFile) item.hidden = true;
    if (tag === 'input') item.kind = type || 'text';
    const role = el.getAttribute('role');
    if (role && !['input', 'textarea', 'select'].includes(tag)) item.kind = role;
    if (tag === 'a') {
      const t = clean(el.innerText);
      if (!t || t.length > 40 || !(BUTTONISH.test(t) || /btn|button/i.test(el.className || ''))) continue;
      item.kind = 'link';
      item.text = t;
    } else if (tag === 'button' || role === 'button' || role === 'tab' || role === 'option' || (tag === 'input' && ['submit', 'button', 'reset'].includes(type))) {
      item.kind = role === 'option' ? 'option' : role === 'tab' ? 'tab' : 'button';
      item.text = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.title).slice(0, 80);
      if (!item.text) continue;
      if (tag === 'button' && (el.getAttribute('type') || 'submit') === 'submit' && el.form) item.submits_form = true;
    } else {
      item.label = labelOf(el);
      if (tag === 'select') {
        item.options = [...el.options].map((o) => clean(o.text)).filter(Boolean).slice(0, 80);
        item.value = clean(el.selectedOptions[0]?.text);
      } else if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch') {
        item.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
        if (el.value && el.value !== 'on') item.option = clean(el.value).slice(0, 80);
      } else if (!isFile) {
        const v = el.value ?? el.innerText ?? '';
        if (v) item.value = clean(v).slice(0, 160);
        if (v && v.length > 160) item.value_length = v.length;
      }
      if (el.required || el.getAttribute('aria-required') === 'true') item.required = true;
      const max = el.getAttribute('maxlength');
      if (max && Number(max) > 0 && Number(max) < 100000) item.maxlength = Number(max);
      if (el.getAttribute('aria-invalid') === 'true') item.invalid = true;
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    item.id = `${prefix}e${n++}`;
    el.setAttribute('data-ga', item.id);
    out.push(item);
    if (out.length >= 260) break;
  }
  const text = clean(document.body?.innerText || '');
  const alerts = [...document.querySelectorAll('[role=alert], .error, .errors, .invalid-feedback, .field-error, [class*="error-message"]')]
    .filter(visible).map((e) => clean(e.innerText)).filter((t) => t && t.length < 300).slice(0, 12);
  const headings = [...document.querySelectorAll('h1, h2, h3, legend')].filter(visible).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 25);
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, [class*="captcha" i]');
  return { elements: out, text: text.slice(0, 2500), text_length: text.length, alerts, headings, captcha };
}

async function observe(page, includeHidden = false) {
  const frames = page.frames().filter((f) => !f.isDetached());
  const view = { url: page.url(), title: await page.title().catch(() => ''), elements: [], text: '', alerts: [], headings: [], captcha: false };
  const frameOf = new Map();
  let i = 0;
  for (const frame of frames) {
    const prefix = `f${i++}`;
    try {
      const r = await frame.evaluate(observeFrame, { prefix, includeHidden });
      for (const el of r.elements) frameOf.set(el.id, frame);
      view.elements.push(...r.elements);
      if (frame === page.mainFrame()) { view.text = r.text; view.headings = r.headings; }
      else if (r.elements.length && r.text) view.text += `\n[embedded frame] ${r.text.slice(0, 600)}`;
      view.alerts.push(...r.alerts);
      view.captcha = view.captcha || r.captcha;
    } catch { /* cross-origin frame that is navigating, or gone */ }
  }
  return { view, frameOf };
}

// ---------- the builtin engine ----------

const RULES = `You are a careful browser operator filling in a grant / accelerator application form for a company.
You get: the job (mode + the answer sheet), what is on the page right now (interactive elements with ids), and what you did so far.
Reply with JSON only: {"thought":"one short sentence","actions":[...],"status":"continue|needs_human|done|failed","reason":"...","unknown_fields":[...],"questions":[...]}

Actions (use the element ids exactly as given; several per reply is good - fill everything visible, then move on):
  {"op":"fill","el":"f0e3","value":"text","field":7}        type into a text box / textarea (replaces what is there)
  {"op":"select","el":"f0e5","value":"Option label","field":8}  choose in a <select> dropdown
  {"op":"check","el":"f0e9","checked":true,"field":9}       tick or untick a checkbox / radio
  {"op":"upload","el":"f0e12","field":10}                  attach the document the answer sheet lists for that field
  {"op":"click","el":"f0e20"}                              press a button / link / custom dropdown option
  {"op":"click","el":"f0e21","final_submit":true}          the ONE click that finally submits the whole application
  {"op":"press","key":"Enter"}   {"op":"wait","ms":1500}   {"op":"goto","url":"https://..."}
"field" is the answer-sheet number (n) the action fills; always include it so progress can be tracked.

Rules:
1. Type each approved answer EXACTLY as written in the answer sheet. Never invent, reword, shorten or "improve" an answer. Never make up data for a field.
2. Match fields to answers by meaning: the form's wording may differ slightly from the sheet's question. For choice fields pick the option that equals the answer.
3. Fields whose action is "leave_blank" stay empty. Fields on the page that are NOT in the answer sheet: leave them empty and list them in "unknown_fields"
   as {"text":"exact label","type":"short_text|long_text|single_select|multi_select|yes_no|number|date|url|email|phone|file","options":[...],"required":true|false}.
4. Hand over to a human (status "needs_human", with a clear "reason" saying exactly what they must do) whenever you meet: a login or sign-in page,
   account creation / registration, a password field, a CAPTCHA or "I'm not a robot" check, email / SMS verification codes, payment, a legal signature,
   or anything else that needs a person. Never type into password fields, never try to solve or bypass a CAPTCHA, never create an account.
5. Multi-step forms: fill the visible step, then click Next / Continue / Save and continue. Check for validation errors after each step and fix what you can.
6. Do not navigate away from the application, do not open unrelated links, do not change account settings.
7. Stop conditions:
   - mode "test": fill in everything you can on every step you can reach, but NEVER perform the final submission. When the only thing left is the final
     Submit button, reply status "done" (reason: what was filled and what was left).
   - mode "live": when every step is filled and there are no errors, click the final submit with "final_submit":true, then confirm from the next page that
     the application was received and reply status "done" with reason starting "SUBMITTED:" and quoting the confirmation text.
     If required fields have no answer in the sheet, do NOT submit: reply "needs_human" and list them.
   - mode "scan": do not type anything. Report every form field you can see in "questions" (same shape as unknown_fields, plus "section" and "help" when shown,
     and "limit":{"unit":"chars|words","max":N} when shown), in form order, each field once, without the "*" that marks required fields.
     Elements marked "hidden":true are fields of later steps already present in the page: report them too. Move to the next step only if that is
     possible without entering data.
     When there are no more steps you can reach, reply status "done".
8. If you are stuck (same page, no progress after two attempts), reply "needs_human" with what blocks you rather than looping. If the page is clearly the wrong
   site or the application is closed, reply "failed" with the reason.
9. "status":"continue" means you want to see the page again after your actions.
10. In the page listing, "value" shows only the first 160 characters of what a field holds; "value_length" is its full length. A long answer whose
    value_length matches the answer's length is filled correctly - do not retype it.`;

async function llm(messages) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await portal('/llm/v1/chat/completions', {
        body: { messages, response_format: { type: 'json_object' }, max_tokens: 6000, temperature: 0 },
      });
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      try {
        return JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) return JSON.parse(m[0]);
        throw new Error('model reply was not JSON');
      }
    } catch (e) {
      last = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last;
}

const FINAL_WORDS = /^(submit|submit application|submit my application|send application|send|finish|finish application|complete application|apply|apply now|submit form|confirm and submit|submit your application)$/i;

async function act(page, frameOf, action, job, files, state) {
  const op = action.op;
  if (op === 'wait') { await sleep(Math.min(Number(action.ms) || 1000, 8000)); return 'waited'; }
  if (op === 'press') { await page.keyboard.press(String(action.key || 'Enter')); return `pressed ${action.key}`; }
  if (op === 'goto') {
    const target = new URL(String(action.url), page.url());
    const allowed = new URL(job.grant.application_url);
    if (target.hostname !== allowed.hostname && !target.hostname.endsWith('.' + allowed.hostname.split('.').slice(-2).join('.'))) return `refused: ${target.hostname} is not the application site`;
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return `opened ${target.href}`;
  }
  const frame = frameOf.get(action.el);
  if (!frame) return `error: no element ${action.el} on the page now`;
  const loc = frame.locator(`[data-ga="${action.el}"]`).first();
  const info = await loc.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 60) })).catch(() => null);
  if (!info) return `error: element ${action.el} is gone`;

  if (op === 'fill') {
    if (job.mode === 'scan') return 'refused: scan mode never types';
    if (info.type === 'password') return 'refused: password fields are for a human - use status needs_human';
    const value = String(action.value ?? '');
    try {
      await loc.fill(value, { timeout: 8000 });
    } catch {
      await loc.click({ timeout: 5000 });
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.type(value, { delay: 5 });
    }
    return `filled ${action.el}`;
  }
  if (op === 'select') {
    if (job.mode === 'scan') return 'refused: scan mode never selects';
    const value = String(action.value ?? '');
    try {
      await loc.selectOption({ label: value }, { timeout: 6000 });
    } catch {
      try { await loc.selectOption(value, { timeout: 3000 }); } catch (e) { return `error: could not select "${value}" (${e.message.split('\n')[0]}). For custom dropdowns click it, then click the option.`; }
    }
    return `selected "${value}"`;
  }
  if (op === 'check') {
    if (job.mode === 'scan') return 'refused: scan mode never ticks';
    try {
      await loc.setChecked(action.checked !== false, { timeout: 6000 });
    } catch {
      await loc.click({ timeout: 5000, force: true });
    }
    return `set ${action.el} ${action.checked !== false ? 'checked' : 'unchecked'}`;
  }
  if (op === 'upload') {
    if (job.mode === 'scan') return 'refused: scan mode never uploads';
    const path = files.get(Number(action.field));
    if (!path) return `error: the answer sheet has no document for field ${action.field}`;
    await loc.setInputFiles(path, { timeout: 15000 });
    return `attached ${path.split('/').pop()}`;
  }
  if (op === 'click') {
    const looksFinal = action.final_submit === true || FINAL_WORDS.test(info.text);
    if (looksFinal && job.mode !== 'live') {
      if (action.final_submit === true || job.mode === 'test') {
        state.reachedSubmit = true;
        return `refused: "${info.text}" looks like the final submission and this is a ${job.mode} run. If everything else is filled, reply status "done". If this button only moves to the next step, say so in your thought and click it WITHOUT final_submit - it will be allowed only if its text is not a submit word.`;
      }
    }
    if (looksFinal && job.mode === 'live') state.submitted = true;
    await loc.click({ timeout: 10000 }).catch(async () => loc.click({ timeout: 5000, force: true }));
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    return `clicked "${info.text}"`;
  }
  return `error: unknown op ${op}`;
}

function sheetForModel(job, done) {
  return job.fields.map((f) => {
    const o = { n: f.n, question: f.question, type: f.type, action: f.action };
    if (f.section) o.section = f.section;
    if (f.options?.length) o.options = f.options;
    if (f.action === 'fill') o.answer = f.answer;
    if (f.action === 'upload') o.document = f.document?.filename;
    if (done.has(f.n)) o.already_filled = true;
    return o;
  });
}

async function builtinEngine(job, ctx, files, state, control) {
  const history = [];
  const done = state.done;
  const scanned = state.scanned;
  let stuck = 0;
  let lastSignature = '';
  for (let step = 1; step <= cfg.maxSteps; step++) {
    if (control.cancelled) return { type: 'cancelled' };
    const page = await activePage(ctx);
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await sleep(700);
    const { view, frameOf } = await observe(page, job.mode === 'scan');
    const signature = view.url + '|' + view.elements.map((e) => `${e.kind}:${e.label || e.text || ''}:${e.value || ''}:${e.checked ?? ''}`).join(';');
    stuck = signature === lastSignature ? stuck + 1 : 0;
    lastSignature = signature;
    if (stuck >= 3) return { type: 'needs_human', reason: 'The agent is not making progress on this page. Please look at the browser, get the form unstuck, then resume.' };

    const user = {
      job: { mode: job.mode, program: job.grant.title, application_url: job.grant.application_url, portal_notes: job.grant.portal?.notes || undefined },
      answer_sheet: job.mode === 'scan' ? undefined : sheetForModel(job, done),
      resumed_after_human_step: state.resumedNote || undefined,
      page: view,
      history: history.slice(-14),
      step: `${step} of at most ${cfg.maxSteps}`,
    };
    let reply;
    try {
      reply = await llm([{ role: 'system', content: RULES }, { role: 'user', content: JSON.stringify(user) }]);
    } catch (e) {
      return { type: 'failed', reason: `The AI model could not be reached: ${e.message}` };
    }
    state.resumedNote = null;
    const results = [];
    const filledNow = [];
    for (const action of Array.isArray(reply.actions) ? reply.actions.slice(0, 40) : []) {
      if (control.cancelled) return { type: 'cancelled' };
      let result;
      try {
        result = await act(page, frameOf, action, job, files, state);
      } catch (e) {
        result = `error: ${e.message.split('\n')[0].slice(0, 200)}`;
      }
      results.push({ ...action, value: action.value ? String(action.value).slice(0, 40) : undefined, result });
      if (!/^(error|refused)/.test(result) && action.field && ['fill', 'select', 'check', 'upload'].includes(action.op)) {
        done.add(Number(action.field));
        filledNow.push(Number(action.field));
      }
      if (/^refused: .*final submission/.test(result)) break;
    }
    history.push({ step, url: view.url, thought: String(reply.thought || '').slice(0, 200), results });
    log(`step ${step}: ${reply.thought || ''} [${reply.status}] ${results.map((r) => r.result).join(' / ').slice(0, 300)}`);

    if (Array.isArray(reply.unknown_fields)) for (const u of reply.unknown_fields) if (u?.text && !state.unknown.some((x) => x.text === u.text)) state.unknown.push(u);
    if (Array.isArray(reply.questions)) for (const q of reply.questions) if (q?.text && !scanned.some((x) => x.text === q.text)) scanned.push(q);

    if (job.mode !== 'scan') {
      await report(job.run_id, {
        status: 'running', progress_done: done.size, progress_total: job.fields.length,
        note: String(reply.thought || '').slice(0, 300),
        message: filledNow.length ? `Filled ${uniq(filledNow).length} field(s): ${uniq(filledNow).map((n) => `Q${n}`).join(', ')}` : undefined,
      });
      if (filledNow.length && state.shots < 10) { state.shots += 1; await screenshot(job.run_id, await activePage(ctx), `After filling ${uniq(filledNow).map((n) => `Q${n}`).join(', ')}`); }
    } else {
      await report(job.run_id, { status: 'running', note: `Reading the form: ${scanned.length} fields so far` });
    }

    if (reply.status === 'needs_human') return { type: 'needs_human', reason: String(reply.reason || 'The agent needs you to step in.') };
    if (reply.status === 'failed') return { type: 'failed', reason: String(reply.reason || 'The agent could not continue.') };
    if (reply.status === 'done') return { type: 'done', reason: String(reply.reason || ''), submitted: state.submitted && /^SUBMITTED/i.test(String(reply.reason || '')) };
    if (state.reachedSubmit && job.mode === 'test' && !results.some((r) => !/^(error|refused)/.test(r.result))) {
      return { type: 'done', reason: 'Everything reachable was filled; stopped at the final Submit button (test mode).' };
    }
  }
  return { type: 'needs_human', reason: `The agent used all ${cfg.maxSteps} steps without finishing. Check the browser and resume, or cancel.` };
}

// ---------- the Hermes engine ----------

class EngineUnavailable extends Error {}

function hermesPrompt(job, runDir, state) {
  const mode = job.mode;
  return `You are running one job for the grants portal. Use the form-filler skill if it is loaded. Work only in the browser that is already open
(it is attached for you; the application page is the active tab) and report through the \`grantctl\` command in the terminal.

JOB
- Mode: ${mode.toUpperCase()}
- Program: ${job.grant.title}
- Application URL: ${job.grant.application_url}
- Answer sheet (JSON): ${join(runDir, 'job.json')}   <- read this file first
${state.resumedNote ? `- A human just finished a manual step for you: ${state.resumedNote}. The browser is where they left it. Carry on from there; do not redo what is already filled.` : ''}
${job.grant.portal?.notes ? `- Notes about this portal: ${job.grant.portal.notes}` : ''}

RULES
1. Type each answer EXACTLY as written in the answer sheet. Never invent or reword an answer. Fields with action "leave_blank" stay empty.
2. For "upload" fields attach the local file given in the sheet as "local_path".
3. Fields on the form that are not in the sheet: leave empty and report them with:  grantctl missing '[{"text":"exact label","type":"short_text","required":true}]'
4. After each form step run:  grantctl progress <comma separated field numbers you filled> "short note"
5. STOP and hand over to a human for: login / sign-in, account creation, any password field, CAPTCHA, verification codes, payment, signatures.
   Do it with:  grantctl need-human "exactly what the person must do"   and then END your turn immediately (do not wait, do not retry).
6. ${mode === 'test' ? 'TEST MODE: fill every step you can reach but NEVER press the final Submit button. When only the final submit is left run:  grantctl done "what was filled / what was left"'
    : mode === 'live' ? 'LIVE MODE: when every step is filled with no errors, press the final Submit, confirm the confirmation page, then run:  grantctl done --submitted "the confirmation text". If required fields have no answer, do not submit: grantctl need-human "..." instead.'
    : 'SCAN MODE: type nothing. Read every field of every step you can reach without entering data, write them to a JSON file as [{"section","text","help","type","options","required","limit"}] in form order, then run:  grantctl questions <file>   and   grantctl done "scanned N fields"'}
7. If you cannot continue for any other reason run:  grantctl fail "why"   and end your turn.
8. Take a screenshot for the team at meaningful moments with:  grantctl screenshot "what this shows"
Always finish by calling exactly one of: grantctl done / grantctl need-human / grantctl fail.`;
}

async function hermesEngine(job, ctx, files, state, control, runDir) {
  if (!hermesVersion) throw new EngineUnavailable('Hermes is not installed on this machine');
  const stateFile = join(runDir, 'outcome.json');
  rmSync(stateFile, { force: true });
  const promptFile = join(runDir, `prompt-${Date.now()}.txt`);
  writeFileSync(promptFile, hermesPrompt(job, runDir, state));
  state.resumedNote = null;
  const args = ['chat', '--oneshot', '-Q', '--query-file', promptFile, '--provider', cfg.hermesProvider, '-m', cfg.hermesModel,
    '-t', 'browser,terminal,file', '-s', 'form-filler', '--max-turns', '150', '--yolo'];
  log('starting hermes', args.join(' '));
  const started = Date.now();
  const child = spawn(cfg.hermesBin, args, {
    cwd: runDir,
    env: { ...process.env, PATH: `${HERE}:${process.env.PATH}`, GRANT_RUN_DIR: runDir, HERMES_YOLO_MODE: '1', BROWSER_CDP_URL: `http://127.0.0.1:${cfg.cdpPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  const keep = (d) => { tail = (tail + d.toString()).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const code = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (control.cancelled || Date.now() - started > 45 * 60 * 1000) child.kill('SIGTERM');
    }, 3000);
    child.on('exit', (c) => { clearInterval(timer); resolve(c ?? 1); });
    child.on('error', () => { clearInterval(timer); resolve(127); });
  });
  writeFileSync(join(runDir, 'hermes-last.log'), tail);
  if (control.cancelled) return { type: 'cancelled' };
  let outcome = null;
  try { outcome = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* none reported */ }
  try {
    const p = JSON.parse(readFileSync(join(runDir, 'progress.json'), 'utf8'));
    for (const n of p.done ?? []) state.done.add(Number(n));
    for (const u of p.unknown ?? []) if (!state.unknown.some((x) => x.text === u.text)) state.unknown.push(u);
    for (const q of p.scanned ?? []) if (!state.scanned.some((x) => x.text === q.text)) state.scanned.push(q);
  } catch { /* no progress file */ }
  if (outcome?.type) return outcome;
  if (code === 2 || code === 127 || Date.now() - started < 20000) throw new EngineUnavailable(`Hermes exited with code ${code}: ${tail.slice(-300)}`);
  // Hermes ran but never reported an outcome: let the built-in engine finish from wherever the browser is now.
  throw new EngineUnavailable(`Hermes stopped without reporting a result (exit code ${code})`);
}

// ---------- running one job ----------

async function runJob(job) {
  const runId = job.run_id;
  const runDir = join(cfg.dataDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  log(`job ${runId}: ${job.mode} ${job.grant.title}`);
  const control = { cancelled: false };
  const state = { done: new Set(), unknown: [], scanned: [], shots: 0, submitted: false, reachedSubmit: false, resumedNote: null };
  const watcher = setInterval(async () => {
    try {
      const r = await portalJson(`/runs/${runId}`);
      if (r.cancel_requested || r.status === 'cancelled') control.cancelled = true;
    } catch { /* portal blip */ }
    heartbeat({ busy: runId });
  }, 5000);

  try {
    if (!job.grant.application_url) throw new Error('This grant has no application link.');
    // Documents the form will ask for.
    const files = new Map();
    for (const f of job.fields) {
      if (f.action !== 'upload' || !f.document) continue;
      const res = await portal(`/documents/${f.document.id}`);
      const path = join(runDir, String(f.document.filename).replace(/[^\w.\- ()]+/g, '_'));
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      files.set(f.n, path);
      f.document.local_path = path;
    }
    writeFileSync(join(runDir, 'job.json'), JSON.stringify(job, null, 2));
    writeFileSync(join(cfg.dataDir, 'current_run'), runDir);

    const ctx = await browser();
    const page = await activePage(ctx);
    for (const other of ctx.pages()) if (other !== page) await other.close().catch(() => {});
    await report(runId, { status: 'running', note: 'Opening the application', live_view_url: liveViewUrl() ?? undefined, progress_total: job.fields.length, message: `Opening ${job.grant.application_url}` });
    await page.goto(job.grant.application_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.bringToFront().catch(() => {});

    // ENGINE in the env file wins; with ENGINE=auto the choice made in the portal's Settings is used.
    const wanted = cfg.engine !== 'auto' ? cfg.engine : job.engine || 'builtin';
    let engine = wanted === 'hermes' && hermesVersion ? 'hermes' : 'builtin';
    if (wanted === 'hermes' && !hermesVersion) await report(runId, { message: 'Hermes was chosen but is not installed on the VM; using the built-in engine.', level: 'warn' });
    await report(runId, { message: engine === 'hermes' ? `Using the Hermes agent (${hermesVersion})` : 'Using the built-in form-filling engine' });

    let outcome;
    for (;;) {
      try {
        outcome = engine === 'hermes' ? await hermesEngine(job, ctx, files, state, control, runDir) : await builtinEngine(job, ctx, files, state, control);
      } catch (e) {
        if (e instanceof EngineUnavailable) {
          log('hermes unavailable, switching to builtin:', e.message);
          await report(runId, { message: `Hermes could not run this job (${e.message.slice(0, 160)}). Continuing with the built-in engine.`, level: 'warn' });
          engine = 'builtin';
          continue;
        }
        throw e;
      }
      if (outcome.type !== 'needs_human') break;

      // Hand over to a person, then wait - no model calls while waiting.
      const p = await activePage(ctx);
      await screenshot(runId, p, 'Where the agent stopped');
      await report(runId, { status: 'needs_human', human_reason: outcome.reason, note: 'Waiting for a person', live_view_url: liveViewUrl() ?? undefined, message: `Needs a human: ${outcome.reason}` });
      log('waiting for human:', outcome.reason);
      let resumed = false;
      while (!control.cancelled) {
        await sleep(4000);
        try {
          const r = await portalJson(`/runs/${runId}`);
          if (r.resume_requested) { resumed = true; break; }
          if (r.status !== 'needs_human') { control.cancelled = true; break; }
        } catch { /* keep waiting */ }
      }
      if (!resumed) { outcome = { type: 'cancelled' }; break; }
      state.resumedNote = outcome.reason;
      await report(runId, { status: 'running', note: 'Continuing after the manual step', message: 'Resumed after the manual step' });
    }

    // Anything the form asked that the portal did not know about becomes a new question there.
    if (job.mode !== 'scan' && state.unknown.length) {
      await portalJson(`/runs/${runId}/questions`, { body: { questions: state.unknown, source_url: (await activePage(ctx)).url() } }).catch((e) => log('could not report unknown fields:', e.message));
    }
    const finalPage = await activePage(ctx);
    if (outcome.type === 'cancelled') {
      await report(runId, { status: 'cancelled', note: 'Cancelled', message: 'Run cancelled' });
    } else if (outcome.type === 'failed') {
      await screenshot(runId, finalPage, 'Where it failed');
      await report(runId, { status: 'failed', note: outcome.reason.slice(0, 400), message: `Failed: ${outcome.reason}` });
    } else if (job.mode === 'scan') {
      if (state.scanned.length) {
        const r = await portalJson(`/runs/${runId}/questions`, { body: { questions: state.scanned, source_url: finalPage.url() } });
        await report(runId, { status: 'completed', note: `Read ${state.scanned.length} fields from the live form (${r.added} new).`, message: 'Scan finished' });
      } else {
        await report(runId, { status: 'failed', note: 'No form fields could be read. The form may need a login first - try again and step in when asked.', message: 'Scan found no fields' });
      }
    } else {
      await screenshot(runId, finalPage, job.mode === 'live' ? 'Final page' : 'Filled form (not submitted)');
      const extra = state.unknown.length ? ` ${state.unknown.length} field(s) on the form had no answer in the portal and were added as new questions.` : '';
      const result = { filled: [...state.done], unknown_fields: state.unknown.length, summary: outcome.reason };
      if (job.mode === 'live' && outcome.submitted) {
        await report(runId, { status: 'submitted', progress_done: state.done.size, note: (outcome.reason || 'Application submitted').slice(0, 400), message: 'Application submitted', result });
      } else if (job.mode === 'live') {
        await report(runId, { status: 'needs_human', human_reason: `The agent filled the form but could not confirm the submission. ${outcome.reason}`.slice(0, 480), progress_done: state.done.size, message: 'Submission not confirmed - please check the browser', result });
      } else {
        await report(runId, { status: 'review', progress_done: state.done.size, note: (`Filled ${state.done.size} of ${job.fields.length} fields; not submitted (test mode). ${outcome.reason || ''}` + extra).slice(0, 480), message: 'Test run finished - form filled, not submitted', result });
      }
    }
  } catch (e) {
    log('job failed:', e);
    await report(runId, { status: 'failed', note: String(e.message || e).slice(0, 400), message: `Failed: ${e.message || e}` });
  } finally {
    clearInterval(watcher);
    rmSync(join(cfg.dataDir, 'current_run'), { force: true });
  }
}

// ---------- self-update + main loop ----------

async function checkForUpdate() {
  try {
    const res = await fetch(`${cfg.portal}/agent/version`);
    if (!res.ok) return;
    const { version, files } = await res.json();
    if (!version || version === VERSION) return;
    log(`updating runner ${VERSION} -> ${version}`);
    for (const name of files) {
      const f = await fetch(`${cfg.portal}/agent/files/${name}`);
      if (!f.ok) throw new Error(`download ${name} failed`);
      writeFileSync(join(HERE, name + '.new'), Buffer.from(await f.arrayBuffer()));
    }
    const { renameSync, chmodSync } = await import('node:fs');
    for (const name of files) { renameSync(join(HERE, name + '.new'), join(HERE, name)); if (!name.includes('.md') && !name.endsWith('.json')) chmodSync(join(HERE, name), 0o755); }
    log('updated; restarting');
    process.exit(0); // systemd starts the new version
  } catch (e) {
    log('update check failed:', e.message);
  }
}

async function main() {
  mkdirSync(cfg.dataDir, { recursive: true });
  detectHermes();
  log(`grants agent ${VERSION} | portal ${cfg.portal} | engine ${cfg.engine} | hermes ${hermesVersion ?? 'not found'}`);
  await browser();
  await heartbeat();
  let lastUpdateCheck = 0;
  let lastBeat = 0;
  for (;;) {
    try {
      if (!cfg.once && Date.now() - lastUpdateCheck > 10 * 60 * 1000) { lastUpdateCheck = Date.now(); await checkForUpdate(); }
      if (Date.now() - lastBeat > 20000) { lastBeat = Date.now(); await heartbeat(); }
      const { job } = await portalJson('/claim', { method: 'POST', body: {} });
      if (job) {
        await runJob(job);
        if (cfg.once) break;
        continue;
      }
    } catch (e) {
      log('loop error:', e.message);
    }
    await sleep(5000);
  }
  await context?.close().catch(() => {});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

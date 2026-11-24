import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from './types';

/**
 * A fake grant application used to test the browser agent end to end without touching a real funder.
 * It deliberately has the things real portals have: a login wall the agent must hand to a human,
 * a two-step form, selects, checkboxes, a character limit, a file upload and a final submit.
 * Nothing entered here goes anywhere except the sandbox_submissions table.
 */
export const sandbox = new Hono<{ Bindings: Env }>({ strict: false });

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Sandbox Grant</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f4f1ea;color:#1d1b16;margin:0}
main{max-width:680px;margin:40px auto;background:#fff;border:1px solid #ddd6c8;border-radius:10px;padding:32px}
h1{margin:0 0 4px;font-size:24px}.tag{display:inline-block;background:#ffe9a8;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;margin-bottom:16px}
label{display:block;font-weight:600;margin:18px 0 6px}small{display:block;font-weight:400;color:#666}
input[type=text],input[type=email],input[type=url],input[type=number],input[type=password],select,textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #b9b2a3;border-radius:6px;font:inherit}
textarea{min-height:110px}fieldset{border:0;padding:0;margin:18px 0 0}legend{font-weight:600;padding:0;margin-bottom:6px}
.opt{display:block;font-weight:400;margin:4px 0}.opt input{margin-right:8px}
button{font:inherit;font-weight:600;padding:10px 18px;border-radius:6px;border:1px solid #1d1b16;background:#1d1b16;color:#fff;cursor:pointer;margin-top:24px}
button.secondary{background:#fff;color:#1d1b16;margin-right:8px}.err{color:#b00020;font-weight:600}
</style></head><body><main><span class="tag">SANDBOX · not a real funder</span>${body}</main></body></html>`;

sandbox.get('/', (c) => c.html(page('Sandbox Innovation Grant', `
<h1>Sandbox Innovation Grant</h1>
<p>A practice application for testing the grants portal's browser agent. Applicants must sign in before applying.</p>
<p><a href="/sandbox/login"><button type="button">Start application</button></a></p>`)));

sandbox.get('/login', (c) => c.html(page('Sign in', `
<h1>Sign in to apply</h1>
<p>Sign in with your applicant account. (For the sandbox: any email, and the password <b>is shown in the grants portal</b> on the Sandbox grant page.)</p>
${c.req.query('error') ? '<p class="err">Wrong password, or the robot check was not ticked.</p>' : ''}
<form method="post" action="/sandbox/login">
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="password">Password</label><input id="password" name="password" type="password" required>
<label class="opt" style="margin-top:18px"><input type="checkbox" name="human" value="1"> I'm not a robot</label>
<button type="submit">Sign in</button></form>`)));

export const SANDBOX_PASSWORD = 'sandbox-human-only';

sandbox.post('/login', async (c) => {
  const form = await c.req.formData();
  if (form.get('password') !== SANDBOX_PASSWORD || form.get('human') !== '1') return c.redirect('/sandbox/login?error=1');
  setCookie(c, 'sbx', '1', { path: '/sandbox', httpOnly: true, sameSite: 'Lax', maxAge: 3600 * 12 });
  return c.redirect('/sandbox/apply');
});

sandbox.get('/apply', (c) => {
  if (getCookie(c, 'sbx') !== '1') return c.redirect('/sandbox/login');
  return c.html(page('Application', `
<h1>Application form</h1>
<form method="post" action="/sandbox/submit" enctype="multipart/form-data" id="f">
<section id="s1">
<h2>Step 1 of 2 · Company</h2>
<label for="company_name">Company name *</label><input id="company_name" name="company_name" type="text" required>
<label for="website">Company website *</label><input id="website" name="website" type="url" required>
<label for="contact_email">Contact email *</label><input id="contact_email" name="contact_email" type="email" required>
<label for="year_founded">What year was your company founded? *</label><input id="year_founded" name="year_founded" type="number" min="1900" max="2100" required>
<label for="stage">What stage is your company? *</label>
<select id="stage" name="stage" required><option value="">Select…</option><option>Idea</option><option>Pre-seed</option><option>Seed</option><option>Series A or later</option></select>
<fieldset><legend>Which industries are relevant to your company? (select all that apply)</legend>
<label class="opt"><input type="checkbox" name="industries" value="Health Tech"> Health Tech</label>
<label class="opt"><input type="checkbox" name="industries" value="AI / Machine Learning"> AI / Machine Learning</label>
<label class="opt"><input type="checkbox" name="industries" value="Fintech"> Fintech</label>
<label class="opt"><input type="checkbox" name="industries" value="Climate"> Climate</label></fieldset>
<button type="button" id="next">Next</button>
</section>
<section id="s2" hidden>
<h2>Step 2 of 2 · Your pitch</h2>
<label for="one_liner">Describe what your company does <small>Maximum 280 characters</small></label>
<textarea id="one_liner" name="one_liner" maxlength="280" required></textarea>
<label for="problem">What problem are you solving? *</label><textarea id="problem" name="problem" required></textarea>
<fieldset><legend>Have you raised outside funding? *</legend>
<label class="opt"><input type="radio" name="raised" value="Yes" required> Yes</label>
<label class="opt"><input type="radio" name="raised" value="No"> No</label></fieldset>
<label for="deck">Pitch deck (PDF) <small>Optional</small></label><input id="deck" name="deck" type="file" accept="application/pdf">
<div><button type="button" class="secondary" id="back">Back</button><button type="submit" id="submit">Submit application</button></div>
</section>
</form>
<script>
const s1=document.getElementById('s1'),s2=document.getElementById('s2');
document.getElementById('next').onclick=()=>{for(const el of s1.querySelectorAll('input,select')){if(!el.reportValidity())return;}s1.hidden=true;s2.hidden=false;window.scrollTo(0,0)};
document.getElementById('back').onclick=()=>{s2.hidden=true;s1.hidden=false};
</script>`));
});

sandbox.post('/submit', async (c) => {
  if (getCookie(c, 'sbx') !== '1') return c.redirect('/sandbox/login');
  const form = await c.req.formData();
  const payload: Record<string, unknown> = {};
  for (const key of new Set([...form.keys()])) {
    const values = form.getAll(key).map((v) => (typeof v === 'string' ? v : { filename: (v as File).name, size: (v as File).size }));
    payload[key] = values.length === 1 ? values[0] : values;
  }
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO sandbox_submissions(payload_json) VALUES(?)').bind(JSON.stringify(payload).slice(0, 20000)),
    // Practice data only: keep the most recent few.
    c.env.DB.prepare('DELETE FROM sandbox_submissions WHERE id NOT IN (SELECT id FROM sandbox_submissions ORDER BY id DESC LIMIT 20)'),
  ]);
  return c.html(page('Submitted', `<h1 id="done">Application submitted</h1><p>Thank you. Your sandbox application has been received.</p>`));
});

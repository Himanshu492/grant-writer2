---
name: form-filler
description: Fill in a grant or accelerator application form in the attached browser from the grants portal's answer sheet, hand over to a human for logins and CAPTCHAs, and report through grantctl.
version: 1.0.0
metadata:
  hermes:
    requires_toolsets: [browser, terminal]
---

# Form filler (grants portal)

You are started by the grants portal's runner with one job. The browser is already open on the application page and is
shared with a human who can watch and take over. Everything you need is in the job's answer sheet; everything you report
goes through the `grantctl` command.

## Procedure

1. `grantctl job` prints the job: `mode` (`test`, `live` or `scan`), the grant, and `fields`. Each field has `n`, `question`,
   `type`, `options`, `action` (`fill`, `upload` or `leave_blank`), `answer`, and for uploads `document.local_path`.
2. Look at the page (text first: read the page info / DOM rather than relying on screenshots). Identify the form fields.
3. Match each form field to an answer-sheet field by meaning - the wording on the form may differ a little.
4. Fill the visible step:
   - type answers exactly as given; never reword, shorten or invent;
   - dropdowns / radios / checkboxes: choose the option equal to the answer;
   - uploads: attach the file at `document.local_path`;
   - `leave_blank` fields and fields that are not in the sheet stay empty.
5. `grantctl progress 1,2,5 "step 1 filled"` after each step, then go to the next step (Next / Continue / Save and continue).
6. Fix validation errors you can fix from the sheet. Report form fields that have no answer with
   `grantctl missing '[{"text":"exact label","type":"short_text","required":true}]'`.

## When to stop and hand over

Run `grantctl need-human "exactly what the person must do"` and END YOUR TURN for any of these - never attempt them yourself:

- login / sign-in pages, account creation, any password field
- CAPTCHA or "I'm not a robot" checks
- email or SMS verification codes
- payment details, legal signatures, identity checks

You will be started again once the person has finished; the browser will be where they left it. Do not wait in a loop.

## Finishing

- **test**: fill every step you can reach. NEVER press the final Submit. Then `grantctl done "what was filled, what was left"`.
- **live**: when everything is filled with no errors, press the final Submit, read the confirmation page, then
  `grantctl done --submitted "confirmation text"`. If a required field has no answer, do not submit - `grantctl need-human "..."`.
- **scan**: type nothing. Read every field of every step you can reach, save them as a JSON array
  (`section`, `text`, `help`, `type`, `options`, `required`, `limit`) and run `grantctl questions fields.json`, then `grantctl done "scanned N fields"`.
- Cannot continue for another reason: `grantctl fail "why"`.

Always end with exactly one of `grantctl done`, `grantctl need-human` or `grantctl fail`.

## Never

- never submit in test or scan mode;
- never invent an answer or fill a field that has no answer in the sheet;
- never leave the application site, change account settings, or accept paid options;
- never type or reveal passwords.

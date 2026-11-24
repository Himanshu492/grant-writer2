-- Questions that only appear on the form when another answer has a certain value.
ALTER TABLE questions ADD COLUMN show_if_json TEXT;
-- Who approved a grant for real submission, and when.
ALTER TABLE grants ADD COLUMN live_enabled_by TEXT;
ALTER TABLE grants ADD COLUMN live_enabled_at TEXT;
-- The long-form award description (the card shows the short one).
ALTER TABLE grants ADD COLUMN amount_detail TEXT;

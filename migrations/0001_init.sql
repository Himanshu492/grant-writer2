-- Grants portal schema.
-- One knowledge base (facts) + one questions table (each grant's real form fields, in order, with its answer).

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  funder TEXT NOT NULL DEFAULT '',
  program_url TEXT,
  application_url TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',            -- funder side: open | closed | rolling | upcoming | unknown
  deadline TEXT,                                     -- YYYY-MM-DD
  deadline_note TEXT NOT NULL DEFAULT '',
  amount TEXT,
  rating TEXT NOT NULL DEFAULT '',
  priority_rank INTEGER,
  pipeline TEXT NOT NULL DEFAULT 'active',           -- our side: active | submitted | not_pursuing
  summary_json TEXT NOT NULL DEFAULT '{}',
  portal_json TEXT NOT NULL DEFAULT '{}',
  questions_verification TEXT NOT NULL DEFAULT 'unverified', -- live_form | official_document | third_party_copy | not_accessible | agent_scan | manual | unverified
  questions_source_url TEXT,
  questions_verified_on TEXT,
  questions_note TEXT NOT NULL DEFAULT '',
  sources_json TEXT NOT NULL DEFAULT '[]',
  seed_hash TEXT,
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  live_enabled INTEGER NOT NULL DEFAULT 0,           -- must be switched on per grant before a LIVE (really submit) run
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  help TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'long_text',
  options_json TEXT NOT NULL DEFAULT '[]',
  required INTEGER,                                  -- 1 | 0 | NULL (unknown, treated as required)
  limit_unit TEXT,                                   -- chars | words | pages
  limit_max INTEGER,
  doc_kind TEXT,
  norm TEXT NOT NULL,                                -- normalised text, used to reuse answers across grants
  origin TEXT NOT NULL DEFAULT 'seed',               -- seed | manual | agent_scan
  source_url TEXT,
  answer TEXT NOT NULL DEFAULT '',
  answer_status TEXT NOT NULL DEFAULT 'empty',       -- empty | suggested | draft | approved | skipped
  answer_origin TEXT,                                -- manual | ai_draft | inferred | reused
  answer_confidence TEXT,
  answer_basis TEXT,                                 -- short "where this came from" line shown to the user
  missing_info TEXT,                                 -- what the knowledge base is missing to answer this
  document_id TEXT,
  inferred_kb_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
CREATE INDEX questions_grant ON questions(grant_id, position);
CREATE INDEX questions_norm ON questions(norm);
CREATE INDEX questions_status ON questions(answer_status);

CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
CREATE INDEX knowledge_category ON knowledge(category);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'other',
  label TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by TEXT
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,                                -- test | live | scan
  status TEXT NOT NULL DEFAULT 'queued',             -- queued | running | needs_human | review | submitted | completed | failed | cancelled
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  human_reason TEXT,
  live_view_url TEXT,
  resume_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  started_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX runs_grant ON runs(grant_id, created_at);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  screenshot_key TEXT
);
CREATE INDEX run_events_run ON run_events(run_id, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Submissions received by the built-in sandbox form (used to test the browser agent end to end).
CREATE TABLE sandbox_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL
);

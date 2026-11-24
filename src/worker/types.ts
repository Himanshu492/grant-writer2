export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  // Optional, only bound while importing from the old system.
  LEGACY_DB?: D1Database;
  LEGACY_DOCS?: R2Bucket;

  /** Comma-separated emails allowed in until the list is edited in Settings (then the saved list wins). */
  ALLOWED_EMAILS?: string;
  /** The address people use (behind Cloudflare Access). Other addresses redirect there. */
  PUBLIC_URL?: string;
  /** Local development only: "1" allows signing in with PORTAL_PASSWORD instead of Cloudflare Access. */
  DEV_PASSWORD_LOGIN?: string;
  PORTAL_PASSWORD?: string;
  SESSION_SECRET: string;
  AGENT_TOKEN: string;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL_FAST: string;
  DEEPSEEK_MODEL_WRITE: string;
  /** Cloudflare Access in front of the custom domain (optional): team domain and the application's audience tag. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Address the VM runner uses. Must not be behind Cloudflare Access, which would block the runner. */
  AGENT_PORTAL_URL?: string;
}

export type AnswerStatus = 'empty' | 'suggested' | 'draft' | 'approved' | 'skipped';

export interface QuestionRow {
  id: string;
  grant_id: string;
  position: number;
  section: string;
  text: string;
  help: string;
  type: string;
  options_json: string;
  required: number | null;
  limit_unit: string | null;
  limit_max: number | null;
  doc_kind: string | null;
  norm: string;
  origin: string;
  source_url: string | null;
  answer: string;
  answer_status: AnswerStatus;
  answer_origin: string | null;
  answer_confidence: string | null;
  answer_basis: string | null;
  missing_info: string | null;
  document_id: string | null;
  inferred_kb_version: number;
  show_if_json: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface GrantRow {
  id: string;
  title: string;
  funder: string;
  program_url: string | null;
  application_url: string | null;
  status: string;
  deadline: string | null;
  deadline_note: string;
  amount: string | null;
  rating: string;
  priority_rank: number | null;
  pipeline: string;
  summary_json: string;
  portal_json: string;
  questions_verification: string;
  questions_source_url: string | null;
  questions_verified_on: string | null;
  questions_note: string;
  sources_json: string;
  seed_hash: string | null;
  is_sandbox: number;
  live_enabled: number;
  live_enabled_by: string | null;
  live_enabled_at: string | null;
  amount_detail: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SeedQuestion {
  section?: string;
  text: string;
  help?: string;
  type?: string;
  options?: string[];
  required?: boolean | null;
  limit?: { unit: string; max: number } | null;
  doc_kind?: string | null;
  source_url?: string | null;
  /** Only on the form when another answer has a certain value. */
  show_if?: ShowIf | null;
}

export interface ShowIf {
  parent: string; // the other question's wording
  op: '=' | '!=' | 'contains' | 'yes' | 'empty' | 'notempty';
  value: string;
}

export interface SeedGrant {
  id: string;
  title: string;
  funder?: string;
  program_url?: string | null;
  application_url?: string | null;
  status?: string;
  deadline?: string | null;
  deadline_note?: string;
  amount?: string | null;
  amount_detail?: string | null;
  summary?: Record<string, string>;
  portal?: Record<string, unknown>;
  questions_verification?: string;
  questions_source_url?: string | null;
  questions_verified_on?: string | null;
  questions_note?: string;
  questions?: SeedQuestion[];
  sources?: { url: string; note?: string }[];
  is_sandbox?: boolean;
}

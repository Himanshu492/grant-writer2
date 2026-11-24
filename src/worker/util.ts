export function uid(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return prefix ? `${prefix}_${s}` : s;
}

/** Normalised form of a question, so "Company Name", "Company name:" and "company name *" are the same question. */
export function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\(optional\)|\(required\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysUntil(dateISO: string | null): number | null {
  if (!dateISO) return null;
  const d = Date.parse(dateISO + 'T00:00:00Z');
  if (Number.isNaN(d)) return null;
  const t = Date.parse(todayISO() + 'T00:00:00Z');
  return Math.round((d - t) / 86400000);
}

export function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** True if the answer fits the question's limit (pages limits are not enforced here). */
export function fitsLimit(answer: string, unit: string | null, max: number | null): boolean {
  if (!unit || !max) return true;
  if (unit === 'chars') return answer.length <= max;
  if (unit === 'words') return countWords(answer) <= max;
  return true;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Question types that are short facts (name, email, URL...) rather than narrative writing. */
export const SHORT_TYPES = new Set([
  'short_text', 'single_select', 'multi_select', 'yes_no', 'number', 'date', 'url', 'email', 'phone', 'address',
]);

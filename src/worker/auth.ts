import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './types';
import { timingSafeEqual } from './util';

export type Vars = { user: string };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const COOKIE = 'gp_session';
const MAX_AGE = 60 * 60 * 24 * 30;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createSession(c: Ctx, name: string): Promise<void> {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ n: name, e: Math.floor(Date.now() / 1000) + MAX_AGE }))));
  const sig = await hmac(c.env.SESSION_SECRET, payload);
  setCookie(c, COOKIE, `${payload}.${sig}`, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: MAX_AGE });
}

export function clearSession(c: Ctx): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function readSession(c: Ctx): Promise<{ name: string } | null> {
  const raw = getCookie(c, COOKIE);
  if (!raw || !c.env.SESSION_SECRET) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expect = await hmac(c.env.SESSION_SECRET, payload);
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(payload)))) as { n: string; e: number };
    if (data.e < Date.now() / 1000) return null;
    return { name: data.n };
  } catch {
    return null;
  }
}

// ---------- Cloudflare Access (single sign-on on the custom domain) ----------

let accessKeys: { at: number; keys: Map<string, CryptoKey> } | null = null;

async function loadAccessKeys(team: string, force = false): Promise<Map<string, CryptoKey>> {
  if (!force && accessKeys && Date.now() - accessKeys.at < 3600_000) return accessKeys.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not load Access signing keys (${res.status})`);
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  const map = new Map<string, CryptoKey>();
  for (const k of keys) map.set(k.kid, await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  accessKeys = { at: Date.now(), keys: map };
  return map;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

/**
 * When the portal sits behind Cloudflare Access, Access has already signed the person in and passes a signed token
 * with every request. If that token is genuine (signature, issuer, audience, expiry), they do not need the team password.
 */
export async function accessIdentity(c: Ctx): Promise<{ email: string; name: string } | null> {
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  const token = c.req.header('cf-access-jwt-assertion');
  if (!team || !aud || !token) return null;
  try {
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return null;
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { alg: string; kid: string };
    if (header.alg !== 'RS256') return null;
    let key = (await loadAccessKeys(team)).get(header.kid);
    if (!key) key = (await loadAccessKeys(team, true)).get(header.kid); // keys rotate
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { iss: string; aud: string | string[]; exp: number; email?: string };
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== `https://${team}` || !auds.includes(aud) || claims.exp < Date.now() / 1000 || !claims.email) return null;
    const local = claims.email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    return { email: claims.email, name: local.charAt(0).toUpperCase() + local.slice(1) };
  } catch {
    return null;
  }
}

/** The signed-in person: an existing portal session, or a valid Cloudflare Access sign-in (which then gets a session). */
export async function currentUser(c: Ctx): Promise<{ name: string } | null> {
  const s = await readSession(c);
  if (s) return s;
  if (!c.env.SESSION_SECRET) return null;
  const id = await accessIdentity(c);
  if (!id) return null;
  await createSession(c, id.name);
  return { name: id.name };
}

/** Everything under /api (except login) needs a signed-in person. */
export async function requireUser(c: Ctx, next: Next) {
  const s = await currentUser(c);
  if (!s) return c.json({ error: 'Not signed in' }, 401);
  // Cookie auth + state-changing request: only accept same-origin calls.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'Cross-origin request refused' }, 403);
  }
  c.set('user', s.name);
  await next();
}

/** The VM runner authenticates with a bearer token. */
export async function requireAgent(c: Context<{ Bindings: Env }>, next: Next) {
  const h = c.req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!c.env.AGENT_TOKEN || !token || !timingSafeEqual(token, c.env.AGENT_TOKEN)) return c.json({ error: 'Bad agent token' }, 401);
  await next();
}

export function checkPassword(env: Env, password: string): boolean {
  return !!env.PORTAL_PASSWORD && timingSafeEqual(password, env.PORTAL_PASSWORD);
}

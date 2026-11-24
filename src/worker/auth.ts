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


/** Everything under /api (except login) needs a signed session cookie. */
export async function requireUser(c: Ctx, next: Next) {
  const s = await readSession(c);
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

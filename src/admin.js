// Admin area (R6.9). Credentials come only from environment variables (ADMIN_USERNAME, ADMIN_PASSWORD),
// set in Render, never in the code. If they aren't set, the admin area is switched off.

import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const COOKIE = 'bd_admin';

const digest = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b)); // equal-length digests: safe, constant time

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function mountAdmin(app, { credentials, reports, now = () => Date.now() }) {
  const sessions = new Map(); // token -> expiry
  const fails = new Map(); // ip -> { count, until }
  const enabled = Boolean(credentials?.username && credentials?.password);
  const router = express.Router();
  router.use(express.json({ limit: '10kb' }));
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  const loggedIn = (req) => {
    const token = readCookie(req, COOKIE);
    const exp = token && sessions.get(token);
    if (!exp) return false;
    if (exp < now()) { sessions.delete(token); return false; }
    return true;
  };

  router.get('/api/me', (req, res) => res.json({ setup: enabled, loggedIn: enabled && loggedIn(req) }));

  router.post('/api/login', (req, res) => {
    if (!enabled) return res.status(503).json({ message: 'The admin area isn’t set up. Add ADMIN_USERNAME and ADMIN_PASSWORD in Render.' });
    const ip = req.ip;
    const f = fails.get(ip);
    if (f && f.until > now()) {
      const mins = Math.ceil((f.until - now()) / 60_000);
      return res.status(429).json({ message: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }
    const { username = '', password = '' } = req.body || {};
    const ok = same(username, credentials.username) & same(password, credentials.password); // no short-circuit
    if (!ok) {
      const count = (f && f.until <= now() && f.count >= MAX_FAILS ? 0 : f?.count || 0) + 1;
      fails.set(ip, { count, until: count >= MAX_FAILS ? now() + LOCK_MS : 0 });
      return res.status(401).json({ message: 'That username and password don’t match.' });
    }
    fails.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, now() + SESSION_MS);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure}`);
    return res.json({ ok: true });
  });

  router.post('/api/logout', (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/api/reports', (req, res) => {
    if (!enabled || !loggedIn(req)) return res.status(401).json({ message: 'Sign in first.' });
    res.json({ reports: [...reports].reverse() });
  });

  app.use('/admin', router);
}

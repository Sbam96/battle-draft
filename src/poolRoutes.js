// Public HTTP endpoints for the community pool and the contact form.
import express from 'express';
import { PoolError } from './pool.js';

// Simple per-address limit for writes: 30 a minute.
function writeLimiter() {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(req.ip, list);
    if (hits.size > 5000) hits.clear();
    if (list.length > 30) return res.status(429).json({ message: 'Too many requests. Wait a minute and try again.' });
    next();
  };
}

export function sendError(res, err) {
  if (err instanceof PoolError) return res.status(err.status).json({ code: err.code, message: err.message });
  console.error('[pool]', err);
  return res.status(503).json({ code: 'POOL_DOWN', message: 'The community pool isn’t reachable right now. Try again in a moment.' });
}

export function mountPool(app, { pool }) {
  const r = express.Router();
  r.use(express.json({ limit: '1.5mb' }));
  r.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!pool()) return res.status(503).json({ code: 'POOL_OFF', message: 'The community pool isn’t set up yet.' });
    next();
  });
  const limit = writeLimiter();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));

  r.get('/pool/verses', wrap(async (req, res) => res.json({ verses: await pool().listVerses() })));
  r.get('/pool/verses/:id', wrap(async (req, res) => res.json({ characters: await pool().verseCharacters(req.params.id) })));
  r.post('/pool/status', limit, wrap(async (req, res) => res.json(await pool().status(req.body?.identity))));
  r.post('/pool/request', limit, wrap(async (req, res) => res.json(await pool().requestAccess(req.body?.identity, req.body?.note))));
  r.post('/pool/add', limit, wrap(async (req, res) => {
    const { identity, verseId, verseName, text, source } = req.body || {};
    res.json(await pool().addCharacters(identity, { verseId, verseName, text: String(text ?? ''), source }));
  }));
  r.post('/contact', limit, wrap(async (req, res) => {
    await pool().contact(req.body || {});
    res.json({ ok: true });
  }));
  app.use('/api', r);
}

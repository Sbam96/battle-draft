// Turns typed, pasted or uploaded text into characters (R7.1–R7.6).
// Rules:
//  - One character per row. In pasted text a row of plain names separated by commas is several characters.
//  - Column meaning comes from the content, not headers: a web link is the image, plain text is the name.
//  - Duplicates (ignoring case and extra spaces) are dropped and reported. Variants like Pre-TS / Post-TS are kept.

import { MAX_CHARACTERS } from './config.js';

export const CHAR_NAME_MAX = 60;
export const URL_MAX = 2000;
export const TEXT_MAX = 1_000_000; // ~1 MB of text is far more than 500 rows need

const HEADER_WORDS = new Set(['name', 'names', 'character', 'characters', 'character name', 'image', 'images', 'image url', 'image link',
  'url', 'link', 'links', 'picture', 'pic', 'photo', 'img', 'verse', 'anime', 'series', 'show']);
const UNSAFE_SCHEME = /^\s*(javascript|data|vbscript|file|blob):/i;

export const nameKey = (name) => String(name).replace(/\s+/g, ' ').trim().toLowerCase();

// Splits one CSV/TSV row into cells, honouring "quoted, cells" and "" escapes.
export function splitRow(line) {
  const delim = line.includes('\t') ? '\t' : ',';
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') { quoted = true; cur = ''; } else if (ch === delim) { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c !== '');
}

function classify(cell) {
  if (UNSAFE_SCHEME.test(cell)) return { kind: 'unsafe' };
  if (/^https?:\/\/\S+$/i.test(cell)) return { kind: 'url', url: cell };
  if (/^www\.\S+\.\S+$/i.test(cell)) return { kind: 'url', url: `https://${cell}` };
  return { kind: 'text', text: cell };
}

// Returns { entries: [{ name, image }], notes } without deduplicating against anything else.
export function parseText(text, { source = 'paste' } = {}) {
  const raw = String(text ?? '');
  if (raw.includes('\u0000') || raw.startsWith('PK\u0003\u0004')) {
    throw Object.assign(new Error('That file isn’t a CSV. If it’s an Excel file, save it as CSV first (File, Save As, CSV) and upload that.'), { code: 'NOT_CSV' });
  }
  if (raw.length > TEXT_MAX) throw Object.assign(new Error('That list is too big. Keep it to 500 characters.'), { code: 'TOO_BIG' });

  const notes = { blankRows: 0, headerSkipped: false, unsafeLinks: 0, longNames: 0, linksWithoutName: 0 };
  const entries = [];
  // Strip a byte-order mark; a final line break isn't a blank row.
  const lines = raw.replace(/^﻿/, '').replace(/(\r\n|\r|\n)+$/, '').split(/\r\n|\r|\n/);

  lines.forEach((line) => {
    const cells = splitRow(line);
    if (!cells.length) { notes.blankRows += 1; return; }
    const parts = cells.map(classify);
    const texts = parts.filter((p) => p.kind === 'text').map((p) => p.text);
    const urls = parts.filter((p) => p.kind === 'url').map((p) => p.url);
    notes.unsafeLinks += parts.filter((p) => p.kind === 'unsafe').length;

    // A first row made only of header words, e.g. "Name, Image"
    if (!entries.length && !notes.headerSkipped && !urls.length && texts.length && texts.every((t) => HEADER_WORDS.has(t.toLowerCase()))) {
      notes.headerSkipped = true;
      return;
    }

    if (!texts.length) { if (urls.length) notes.linksWithoutName += 1; return; }

    // A pasted comma row of plain names ("Luffy, Zoro, Nami") is several characters.
    // CSV files and tab-separated rows (copied from a spreadsheet) are one character per row.
    const names = source === 'paste' && !line.includes('\t') && !urls.length && texts.length > 1 ? texts : [texts[0]];
    const image = urls[0] && urls[0].length <= URL_MAX ? urls[0] : null;
    for (const name of names) {
      if (name.length > CHAR_NAME_MAX) { notes.longNames += 1; continue; }
      entries.push({ name, image: names.length === 1 ? image : null });
    }
  });
  return { entries, notes };
}

// Merges parsed entries into an existing list, dropping duplicates. Pure: returns new values.
export function mergeCharacters(existing, entries, { verse = '' } = {}) {
  const seen = new Map(existing.map((c) => [nameKey(c.name), c]));
  const added = [];
  const duplicates = [];
  for (const e of entries) {
    const key = nameKey(e.name);
    if (seen.has(key)) { if (!duplicates.some((d) => nameKey(d) === key)) duplicates.push(e.name); continue; }
    const c = { name: e.name, image: e.image || null, verse };
    seen.set(key, c);
    added.push(c);
  }
  const total = existing.length + added.length;
  if (total > MAX_CHARACTERS) {
    throw Object.assign(new Error(`That would make ${total} characters. The maximum is ${MAX_CHARACTERS}, so remove ${total - MAX_CHARACTERS} and try again.`), { code: 'TOO_MANY' });
  }
  return { added, duplicates };
}

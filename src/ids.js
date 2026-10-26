import { randomBytes, randomInt } from 'node:crypto';

// Room ids are 12 random URL-safe characters (72 bits), so private links can't be guessed (NF5).
export const roomId = () => randomBytes(9).toString('base64url');
export const shortId = () => randomBytes(6).toString('base64url');

// Join codes (26 Oct 2026): 6 characters people can read out or type, without look-alikes (no 0/O, 1/I/L).
// 31^6 is about 900 million codes; the server also limits wrong guesses per address.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const joinCode = () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const normaliseCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

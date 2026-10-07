import { randomBytes } from 'node:crypto';

// Room ids are 12 random URL-safe characters (72 bits), so private links can't be guessed (NF5).
export const roomId = () => randomBytes(9).toString('base64url');
export const shortId = () => randomBytes(6).toString('base64url');

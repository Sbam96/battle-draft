// Tunable game constants. Durations are in milliseconds.

export const ROLE_COUNTS = [5, 10];
export const MIN_PLAYERS = 3;
export const MAX_CHARACTERS = 500;
export const NAME_MAX = 20;
export const ROLE_NAME_MAX = 30;
export const ROOM_NAME_MAX = 40;
export const GRACE_MS = 30_000; // R6.8: every disconnected player gets 30 seconds
export const EMPTY_ROOM_TTL_MS = 10 * 60_000; // drop rooms nobody is in
export const PLACEMENT_TIMER_OPTIONS = [15, 30, 45, 60]; // seconds, host picks one when the timer is on

// Minimum character list (R5.6): (players x roles + 3 per player) plus 10%, rounded up.
// Integer maths avoids floating-point surprises like 110.00000000000001.
export function minimumPool(players, roles) {
  return Math.ceil((players * (roles + 3) * 11) / 10);
}

// Largest player cap that keeps the minimum list within 500 characters.
export function maxPlayersFor(roles) {
  let p = MIN_PLAYERS;
  while (minimumPool(p + 1, roles) <= MAX_CHARACTERS) p += 1;
  return p;
}

// Tunable game constants. Durations are in milliseconds.

export const ROLE_COUNTS = [5, 10];
export const MIN_PLAYERS = 3;
export const PLACEMENT_TIMER_OPTIONS = [15, 30, 45, 60]; // seconds, host picks one when the timer is on
export const VOTE_TIMER_OPTIONS = [30, 60, 90, 120]; // seconds for face-off voting, host picks one when on
export const MAX_CHARACTERS = 500;
export const NAME_MAX = 20;
export const ROLE_NAME_MAX = 30;
export const ROOM_NAME_MAX = 40;
export const GRACE_MS = 30_000; // R6.8: every disconnected player gets 30 seconds
export const EMPTY_ROOM_TTL_MS = 10 * 60_000; // drop rooms nobody is in

// Minimum character list (R5.6): (players x roles + 3 per player) plus 10%, rounded up.
// Integer maths avoids floating-point surprises like 110.00000000000001.
export function minimumPool(players, roles) {
  return Math.ceil((players * (roles + 3) * 11) / 10);
}

// Auction (R14.7): the lot is roles x players + 20%, rounded up. Integer maths again.
export function auctionLotSize(players, roles) {
  return Math.ceil((players * roles * 12) / 10);
}
export const GAME_TYPES = ['wheel', 'auction'];
export const FUNDS_OPTIONS = [50, 60, 70, 80, 90, 100]; // R14.4
export const CURRENCIES = ['£', '$', '€', '¥', 'Beli']; // R14.5: display only; Beli shows amounts x1,000
export const BID_MS = Number(process.env.BD_TEST_BID_MS) || 10_000; // R14.6: fixed, restarts on every bid (env override for browser tests only)
export const BENCH_SPOTS = 3; // R16.5
export const MARKET_BUY_LIMIT = 2; // R17.6
export const TRADE_MIN_MS = 90_000; // R17.10: host can end trading after this
export const PROPOSAL_MS = 30_000; // R17.3

// Largest player cap that keeps the minimum list within 500 characters.
export function maxPlayersFor(roles) {
  let p = MIN_PLAYERS;
  while (minimumPool(p + 1, roles) <= MAX_CHARACTERS) p += 1;
  return p;
}

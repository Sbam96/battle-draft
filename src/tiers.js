// Character tiers (R15, agreed 26 October 2026). Used by both game types: in the wheel game tiers only
// colour the cards; in the auction they set the opening price.

export const TIERS = ['Diamond', 'Gold', 'Silver', 'Bronze']; // strongest first
export const DEFAULT_TIER = 'Bronze';
export const TIER_PRICE = { Diamond: 7, Gold: 5, Silver: 3, Bronze: 1 };

// Words accepted in lists. Older names from the first draft still work.
const WORDS = new Map([
  ['diamond', 'Diamond'], ['platinum', 'Diamond'], ['world breaker', 'Diamond'], ['worldbreaker', 'Diamond'], ['world-breaker', 'Diamond'],
  ['gold', 'Gold'], ['top', 'Gold'], ['top tier', 'Gold'],
  ['silver', 'Silver'], ['mid', 'Silver'], ['mid tier', 'Silver'],
  ['bronze', 'Bronze'], ['low', 'Bronze'], ['low tier', 'Bronze'],
]);

// "Gold", " world breaker ", "TOP" -> canonical tier, or null when the word isn't a tier.
export function tierFrom(word) {
  return WORDS.get(String(word ?? '').trim().toLowerCase().replace(/\s+/g, ' ')) ?? null;
}

export const isTier = (t) => TIERS.includes(t);
export const tierOrDefault = (t) => (isTier(t) ? t : DEFAULT_TIER);

// Selling to the market: half the tier price, rounded half up (Diamond 4, Gold 3, Silver 2, Bronze 1).
export const sellPrice = (tier) => Math.round(TIER_PRICE[tierOrDefault(tier)] / 2 + 1e-9);

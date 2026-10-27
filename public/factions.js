// Which poster a character's card uses (27 October 2026).
// Marines and the World Government get the star-rated bounty sheet; everyone else (pirates, revolutionaries,
// anyone not on this list) gets a wanted poster. Names are matched loosely: case, spacing and punctuation
// are ignored, and either part of "Akainu (Sakazuki)" counts.

const MARINES = [
  // Marines, past and present (as most fans would picture them)
  'Monkey D. Garp', 'Garp', 'Sengoku', 'Kong', 'Sakazuki', 'Akainu', 'Kuzan', 'Aokiji', 'Borsalino', 'Kizaru',
  'Issho', 'Fujitora', 'Aramaki', 'Ryokugyu', 'Ryokugyo', 'Smoker', 'Koby', 'Coby', 'Tsuru', 'Momonga', 'Onigumo',
  'Dalmatian', 'Zephyr', 'Helmeppo', 'Hina', 'Tashigi', 'Gion', 'Momousagi', 'Tokikake', 'Kizaru', 'Doberman',
  'Strawberry', 'Yamakaji', 'Comil', 'Bastille', 'Ain', 'Binz', 'Prince Grus', 'Grus', 'Hibari', 'Brannew',
  'Axe-Hand Morgan', 'Morgan', 'Fullbody', 'Sentomaru', 'Jango', 'Vergo', 'Sengoku the Buddha',
  // World Government and Cipher Pol
  'Imu', 'Saint Jaygarcia Saturn', 'Jaygarcia Saturn', 'Saturn', 'Saint Ethanbaron V. Nusjuro', 'Ethanbaron V. Nusjuro',
  'Saint Marcus Mars', 'Marcus Mars', 'Saint Topman Warcury', 'Topman Warcury', 'Saint Shepherd Ju Peter',
  'Shepherd Ju Peter', 'Garling Figarland', 'Figarland Garling', 'Rob Lucci', 'Kaku', 'Jabra', 'Kalifa', 'Blueno',
  'Fukuro', 'Kumadori', 'Spandam', 'Stussy', 'Magellan', 'Hannyabal', 'Shiryu of the Rain', 'Vegapunk',
  'S-Snake', 'S-Hawk', 'S-Bear', 'S-Shark', 'Bartholomew Kuma',
];
// Characters who sit on both sides are listed by their best-known look; these stay pirates.
const PIRATE_OVERRIDES = ['Shiryu', 'X Drake'];

const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MARINE_SET = new Set(MARINES.map(norm));
const PIRATE_SET = new Set(PIRATE_OVERRIDES.map(norm));

// 'marine' or 'wanted'
export function posterKind(name) {
  const full = norm(name);
  const parts = [full, norm(String(name ?? '').replace(/\(.*?\)/g, ' ')), ...[...String(name ?? '').matchAll(/\(([^)]*)\)/g)].map((m) => norm(m[1]))];
  if (parts.some((p) => PIRATE_SET.has(p))) return 'wanted';
  return parts.some((p) => MARINE_SET.has(p)) ? 'marine' : 'wanted';
}

// Stars on the bounty sheet: Bronze 1, Silver 2, Gold 3, Diamond 4 (out of 4).
export const STARS = { Bronze: 1, Silver: 2, Gold: 3, Diamond: 4 };

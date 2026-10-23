// Spotting the same character under two names (e.g. "Shiryu" and "Shiliew", "Akainu" and "Sakazuki").
//
// identityKey(name) is what duplicate checks use. It:
//  - ignores case, spacing, punctuation and curly vs straight quotes ("Who's-Who" = "Who’s Who");
//  - maps known other names (translations, titles, real names) to one character;
//  - reads a name in brackets as another name when it is one ("Akainu (Sakazuki)"), and otherwise as a
//    variant that keeps the entry separate ("Monkey D. Luffy (Pre-TS)" stays different from "Monkey D. Luffy").
//
// looseKey(name) ignores bracketed variants altogether. The admin portal uses it to list *possible*
// duplicates for a person to check (e.g. "Vegapunk" and "Vegapunk (Can call in satellites)").

// Each group is one character; the first entry is just a label. Names are matched after normalising.
const GROUPS = [
  // ---------- One Piece ----------
  ['Monkey D. Luffy', 'Luffy', 'Straw Hat Luffy', 'Mugiwara no Luffy'],
  ['Roronoa Zoro', 'Zoro', 'Zolo', 'Roronoa Zolo', 'Pirate Hunter Zoro'],
  ['Vinsmoke Sanji', 'Sanji', 'Black Leg Sanji', 'Mr. Prince', 'Sanji Vinsmoke'],
  ['Nami', 'Cat Burglar Nami'],
  ['Usopp', 'Sogeking', 'God Usopp', 'Usoland'],
  ['Tony Tony Chopper', 'Chopper'],
  ['Nico Robin', 'Robin', 'Miss All Sunday'],
  ['Franky', 'Cutty Flam', 'Iron Man Franky'],
  ['Brook', 'Soul King', 'Soul King Brook'],
  ['Jinbe', 'Jinbei', 'Jimbei', 'Jinbe Knight of the Sea'],
  ['Shanks', 'Red-Haired Shanks', 'Red Hair Shanks', 'Akagami'],
  ['Kaido', 'Kaidou', 'Kaido of the Beasts'],
  ['Charlotte Linlin', 'Big Mom', 'Linlin'],
  ['Edward Newgate', 'Whitebeard', 'Shirohige', 'Newgate'],
  ['Marshall D. Teach', 'Blackbeard', 'Kurohige', 'Teach'],
  ['Gol D. Roger', 'Gold Roger', 'Roger', 'Pirate King Roger'],
  ['Silvers Rayleigh', 'Rayleigh', 'Dark King Rayleigh'],
  ['Monkey D. Garp', 'Garp', 'Garp the Fist', 'Garp the Hero'],
  ['Monkey D. Dragon', 'Dragon'],
  ['Sengoku', 'Sengoku the Buddha'],
  ['Rocks D. Xebec', 'Xebec', 'Davy D. Xebec'],
  ['Dracule Mihawk', 'Mihawk', 'Hawk-Eyes', 'Hawk Eyes Mihawk'],
  ['Sakazuki', 'Akainu'],
  ['Kuzan', 'Aokiji'],
  ['Borsalino', 'Kizaru'],
  ['Issho', 'Fujitora'],
  ['Aramaki', 'Ryokugyu', 'Ryokugyo'],
  ['Kong', 'Commander-in-Chief Kong'],
  ['Shiryu', 'Shiliew', 'Shiryu of the Rain', 'Shiliew of the Rain'],
  ['Jesus Burgess', 'Burgess'],
  ['Van Augur', 'Augur'],
  ['Trafalgar Law', 'Law', 'Trafalgar D. Water Law', 'Trafalgar D Water Law', 'Surgeon of Death'],
  ['Eustass Kid', 'Kid', 'Eustass Kidd', 'Captain Kid'],
  ['Killer', 'Massacre Soldier Killer'],
  ['Portgas D. Ace', 'Ace', 'Fire Fist Ace', 'Gol D. Ace'],
  ['Sabo', 'Flame Emperor Sabo'],
  ['Marco', 'Marco the Phoenix'],
  ['Boa Hancock', 'Hancock', 'Pirate Empress Hancock'],
  ['Charlotte Katakuri', 'Katakuri'],
  ['Charlotte Cracker', 'Cracker'],
  ['Charlotte Smoothie', 'Smoothie'],
  ['Charlotte Perospero', 'Perospero'],
  ['King', 'Alber', 'King the Wildfire'],
  ['Queen', 'Queen the Plague'],
  ['Jack', 'Jack the Drought'],
  ["Who's-Who", 'Whos Who'],
  ['Donquixote Doflamingo', 'Doflamingo', 'Doffy'],
  ['Donquixote Rosinante', 'Rosinante', 'Rocinante', 'Corazon', 'Corazón', 'Donquixote Rocinante'],
  ['Crocodile', 'Sir Crocodile', 'Mr. 0', 'Mr 0', 'Mr. Zero'],
  ['Daz Bonez', 'Daz Bones', 'Mr. 1', 'Mr 1'],
  ['Bentham', 'Bon Clay', 'Mr. 2', 'Mr 2', 'Mr. 2 Bon Clay', 'Bon Kurei'],
  ['Galdino', 'Mr. 3', 'Mr 3'],
  ['Nefertari Vivi', 'Vivi', 'Miss Wednesday'],
  ['Enel', 'Eneru', 'God Enel'],
  ['Rob Lucci', 'Lucci'],
  ['Bartholomew Kuma', 'Kuma'],
  ['Gecko Moria', 'Moria', 'Gekko Moriah', 'Gecko Moriah'],
  ['Emporio Ivankov', 'Ivankov'],
  ['Kozuki Oden', 'Oden'],
  ['Kozuki Momonosuke', 'Momonosuke'],
  ['Kozuki Hiyori', 'Hiyori', 'Komurasaki'],
  ['Kinemon', "Kin'emon", 'Kinemon the Foxfire'],
  ['Denjiro', 'Kyoshiro'],
  ['Ashura Doji', 'Shutenmaru'],
  ['Kurozumi Kanjuro', 'Kanjuro'],
  ['Kurozumi Orochi'],
  ['Yamato'],
  ['Smoker', 'White Hunter Smoker'],
  ['Koby', 'Coby'],
  ['Kalifa', 'Califa'],
  ['Pica', 'Pika'],
  ['Vegapunk', 'Dr. Vegapunk', 'Dr Vegapunk'],
  ['Saint Jaygarcia Saturn', 'Jaygarcia Saturn', 'Saturn', 'St. Jaygarcia Saturn'],
  ['Saint Ethanbaron V. Nusjuro', 'Ethanbaron V. Nusjuro', 'Nusjuro'],
  ['Saint Marcus Mars', 'Marcus Mars'],
  ['Saint Topman Warcury', 'Topman Warcury', 'Warcury'],
  ['Saint Shepherd Ju Peter', 'Shepherd Ju Peter', 'Ju Peter'],
  ['Scopper Gaban', 'Gaban'],
  ['Benn Beckman', 'Beckman', 'Ben Beckman'],
  ['Lucky Roux', 'Lucky Roo', 'Lucky Rou'],
  ['Shimotsuki Ryuma', 'Ryuma'],
  ['Buggy', 'Buggy the Clown', 'Buggy the Star Clown'],
  ['Kuro', 'Captain Kuro', 'Klahadore'],
  ['Axe-Hand Morgan', 'Captain Morgan'],
  ['Hatchan', 'Hachi'],
  ['Zeff', 'Red-Leg Zeff', 'Red Leg Zeff'],
  ['Charlotte Pudding', 'Pudding'],
  ['Vinsmoke Judge'],
  ['Vinsmoke Reiju', 'Reiju'],
  ['Caesar Clown', 'Caesar'],
  ['Basil Hawkins', 'Hawkins'],
  ['X Drake', 'Diez Drake'],
  ['Capone Bege', 'Bege', 'Capone Gang Bege'],
  ['Scratchmen Apoo', 'Apoo'],
  ['Jewelry Bonney', 'Bonney'],
  ['Senor Pink', 'Señor Pink'],

  // ---------- Naruto ----------
  ['Naruto Uzumaki', 'Naruto', 'Uzumaki Naruto'],
  ['Sasuke Uchiha', 'Sasuke', 'Uchiha Sasuke'],
  ['Kakashi Hatake', 'Kakashi', 'Hatake Kakashi', 'Copy Ninja Kakashi'],
  ['Itachi Uchiha', 'Itachi', 'Uchiha Itachi'],
  ['Madara Uchiha', 'Madara', 'Uchiha Madara'],
  ['Obito Uchiha', 'Obito', 'Tobi', 'Uchiha Obito'],
  ['Hashirama Senju', 'Hashirama', 'First Hokage'],
  ['Tobirama Senju', 'Tobirama', 'Second Hokage'],
  ['Hiruzen Sarutobi', 'Hiruzen', 'Third Hokage'],
  ['Minato Namikaze', 'Minato', 'Fourth Hokage', 'Yellow Flash'],
  ['Jiraiya', 'Pervy Sage'],
  ['Nagato', 'Pain', 'Pein'],
  ['Kaguya Otsutsuki', 'Kaguya', 'Kaguya Ōtsutsuki'],
  ['Might Guy', 'Might Gai'],
  ['Killer Bee', 'Killer B'],
  ['Gaara', 'Gaara of the Sand'],
  ['Kurama', 'Nine-Tails', 'Kyuubi', 'Nine Tails'],

  // ---------- Bleach ----------
  ['Ichigo Kurosaki', 'Ichigo', 'Kurosaki Ichigo'],
  ['Sosuke Aizen', 'Aizen', 'Sousuke Aizen', 'Aizen Sosuke'],
  ['Genryusai Shigekuni Yamamoto', 'Yamamoto', 'Head Captain Yamamoto', 'Shigekuni Yamamoto-Genryusai'],
  ['Yhwach', 'Juhabach', 'Yhwach'],
  ['Kenpachi Zaraki', 'Kenpachi', 'Zaraki Kenpachi'],
  ['Byakuya Kuchiki', 'Byakuya', 'Kuchiki Byakuya'],
  ['Toshiro Hitsugaya', 'Hitsugaya', 'Toshiro', 'Hitsugaya Toshiro'],
  ['Rukia Kuchiki', 'Rukia', 'Kuchiki Rukia'],
  ['Kisuke Urahara', 'Urahara', 'Urahara Kisuke'],
  ['Yoruichi Shihoin', 'Yoruichi', 'Shihoin Yoruichi'],
  ['Ulquiorra Cifer', 'Ulquiorra', 'Ulquiorra Schiffer'],
  ['Grimmjow Jaegerjaquez', 'Grimmjow'],
  ['Coyote Starrk', 'Starrk', 'Stark'],
  ['Orihime Inoue', 'Orihime', 'Inoue Orihime'],
  ['Uryu Ishida', 'Uryu', 'Ishida', 'Uryuu Ishida'],
  ['Mayuri Kurotsuchi', 'Mayuri'],
  ['Shunsui Kyoraku', 'Kyoraku', 'Shunsui'],

  // ---------- Dragon Ball ----------
  ['Goku', 'Son Goku', 'Kakarot', 'Kakarotto'],
  ['Vegeta', 'Prince Vegeta'],
  ['Gohan', 'Son Gohan'],
  ['Goten', 'Son Goten'],
  ['Piccolo', 'Piccolo Jr.', 'Ma Junior'],
  ['Frieza', 'Freeza', 'Freezer'],
  ['Majin Buu', 'Buu', 'Majin Boo'],
  ['Android 17', 'Lapis'],
  ['Android 18', 'Lazuli'],
  ['Beerus', 'Bills', 'Lord Beerus'],
  ['Whis', 'Wiss'],
  ['Jiren', 'Jiren the Grey'],
  ['Broly', 'Broli'],
  ['Master Roshi', 'Roshi', 'Muten Roshi', 'Kame-Sennin'],
  ['Tien Shinhan', 'Tien', 'Tenshinhan'],
  ['Zeno', 'Zen-Oh', 'Grand Zeno'],

  // ---------- One Punch Man ----------
  ['Saitama', 'Caped Baldy', 'One Punch Man'],
  ['Genos', 'Demon Cyborg'],
  ['Garou', 'Hero Hunter', 'Human Monster Garou'],
  ['Tatsumaki', 'Terrible Tornado'],
  ['Fubuki', 'Blizzard of Hell'],
  ['Boros', 'Lord Boros'],
  ['Bang', 'Silver Fang', 'Bang (Silver Fang)'],
  ['Atomic Samurai', 'Kamikaze'],
  ['Blast'],
  ['Mumen Rider', 'Licenseless Rider'],
  ['Metal Bat', 'Badd'],
  ['Child Emperor', 'Dosukoi Child Emperor'],
];

// Lower-case, curly quotes and accents flattened, punctuation dropped, spaces collapsed.
export function normalise(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ALIAS = new Map();
GROUPS.forEach((names, i) => {
  for (const n of names) {
    const k = normalise(n);
    if (!ALIAS.has(k)) ALIAS.set(k, `#${i}`);
  }
});

// "Akainu (Sakazuki)" -> { main: 'Akainu', extras: ['Sakazuki'] }. Handles a missing space before "(".
function split(name) {
  const extras = [];
  const main = String(name ?? '').replace(/[([]([^)\]]*)[)\]]/g, (_, inner) => { extras.push(inner); return ' '; });
  return { main, extras };
}

export function identityKey(name) {
  const { main, extras } = split(name);
  const m = normalise(main);
  const ex = extras.map(normalise).filter(Boolean);
  const whole = normalise(name);
  if (ALIAS.has(whole) && !ex.length) return ALIAS.get(whole);
  const id = ALIAS.get(m) ?? ex.map((e) => ALIAS.get(e)).find(Boolean) ?? null;
  // Bracketed names that are just another name for the same character don't make a new entry.
  const variants = ex.filter((e) => !(id && ALIAS.get(e) === id) && e !== m).sort();
  const base = id ?? (m || whole);
  return variants.length ? `${base}|${variants.join('|')}` : base;
}

export function looseKey(name) {
  const { main, extras } = split(name);
  const m = normalise(main);
  return ALIAS.get(m) ?? extras.map(normalise).map((e) => ALIAS.get(e)).find(Boolean) ?? m;
}

// Groups of entries that may be the same character, for a person to review. items: [{ id, name }]
export function possibleDuplicates(items) {
  const by = new Map();
  for (const it of items) {
    const k = looseKey(it.name);
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(it);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

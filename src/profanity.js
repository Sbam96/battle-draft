// Profanity filter for gaming names and role names (R6.6).
// Character names are deliberately NOT filtered: they come from the anime verse.

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

// Real names and words the dataset would otherwise flag.
const ALLOWED = [
  'dickson', 'dickens', 'dickinson', 'grayson', 'cocktail', 'hancock', 'peacock', 'shiitake',
  'assassin', 'assassins', 'assassination', 'class', 'classic', 'compass', 'grass', 'glass', 'brass',
  'bass', 'mass', 'massive', 'pass', 'passion', 'embassy', 'cassie', 'scunthorpe', 'cockpit', 'woodcock',
];

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
  whitelistedTerms: ALLOWED,
});

export function isProfane(text) {
  return matcher.hasMatch(String(text));
}

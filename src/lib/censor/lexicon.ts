/**
 * The built-in profanity lexicon, in tiers so "sensitivity" means something
 * concrete rather than a vague dial.
 *
 * Deliberately **profanity only — no slurs.** Slur detection is not a lookup:
 * the same word can be a slur or reclaimed speech depending on who is speaking,
 * and the lists are locale-specific. Wrongly bleeping a speaker is a visible,
 * publishable error, so the product ships the part that can be done reliably
 * and leaves the rest to an explicit, user-authored `denyList` that the user
 * reviews before applying.
 *
 * Terms are stored as bare stems. `detect.ts` matches whole words with a small
 * set of inflections, so "class" never trips on "ass" — matching substrings
 * would produce exactly the false positives this feature cannot afford.
 */

export type CensorTier = "strong" | "common" | "mild";

/** Low sensitivity catches only `strong`; medium adds `common`; high adds `mild`. */
export type CensorSensitivity = "LOW" | "MEDIUM" | "HIGH";

export const TIERS_BY_SENSITIVITY: Record<CensorSensitivity, CensorTier[]> = {
  LOW: ["strong"],
  MEDIUM: ["strong", "common"],
  HIGH: ["strong", "common", "mild"],
};

/**
 * The harshest terms — caught at every sensitivity.
 *
 * Entries are *verb stems* where one exists, not the agent noun, because
 * `detect.ts` folds inflections down rather than up. Listing "motherfucker"
 * alone caught "motherfucker" and "motherfuckers" but missed "motherfucking",
 * since stripping "-ing" yields "motherfuck". The agent nouns are kept
 * alongside the stems so the list still reads as words rather than fragments.
 */
const STRONG = [
  "fuck",
  "motherfuck",
  "motherfucker",
  "cunt",
  "cock",
  "cocksuck",
  "cocksucker",
  "twat",
  "prick",
];

/** Everyday profanity — caught at medium and above. */
const COMMON = [
  "shit",
  "bullshit",
  "bitch",
  "asshole",
  "arsehole",
  "bastard",
  "dick",
  "dickhead",
  "piss",
  "pissed",
  "slut",
  "whore",
  "douche",
  "douchebag",
  "jackass",
  "dumbass",
  "smartass",
  "bollocks",
  "bugger",
  "wank",
  "wanker",
];

/** Mild or borderline — only at high sensitivity, where over-catching is the
 *  point. `god` and `jesus` are here because they are exclamations some
 *  publishers mask, not because they are profanity everywhere. */
const MILD = [
  "damn",
  "goddamn",
  "hell",
  "crap",
  "arse",
  "ass",
  "bloody",
  "bastardly",
  "jesus",
  "christ",
  "god",
];

export const LEXICON: Record<CensorTier, readonly string[]> = {
  strong: STRONG,
  common: COMMON,
  mild: MILD,
};

/** Every stem for a sensitivity, as a lookup keyed by stem -> tier. */
export function lexiconFor(sensitivity: CensorSensitivity): Map<string, CensorTier> {
  const out = new Map<string, CensorTier>();
  for (const tier of TIERS_BY_SENSITIVITY[sensitivity]) {
    for (const term of LEXICON[tier]) {
      // A term listed in several tiers keeps its harshest classification.
      if (!out.has(term)) out.set(term, tier);
    }
  }
  return out;
}

/**
 * The built-in censor lexicon, in tiers so "sensitivity" means something
 * concrete rather than a vague dial.
 *
 * Terms are stored as bare stems. `detect.ts` matches whole words with a small
 * set of inflections, so "class" never trips on "ass" — matching substrings
 * would produce exactly the false positives this feature cannot afford.
 *
 * ## On the slur tier
 *
 * Slurs are kept in their own tier rather than folded into `strong`, for two
 * reasons that matter in use.
 *
 * First, they are caught at *every* sensitivity. Sensitivity is a dial for how
 * much ordinary swearing to mask; it is not a reason to let a slur through, so
 * lowering it must not disable them.
 *
 * Second, and more importantly, a separate tier is visible. Slur detection is
 * genuinely not a clean lookup — several of these terms are reclaimed in
 * ordinary speech, some are ordinary words in other senses ("a chink in the
 * armour", "faggot" as the British dish, "retard" as a verb, "fag" as a
 * cigarette), and the lines move by region and by speaker. Wrongly bleeping
 * someone is a visible, publishable error.
 *
 * So the design does not pretend the list is authoritative. Every match is
 * shown in the review panel tagged with its tier before anything is applied,
 * and one click moves a term to the clip's allow-list. That review step is what
 * makes shipping this list defensible; without it, it would not be.
 */

export type CensorTier = "slur" | "strong" | "common" | "mild";

/** Low catches slurs + `strong`; medium adds `common`; high adds `mild`. */
export type CensorSensitivity = "LOW" | "MEDIUM" | "HIGH";

export const TIERS_BY_SENSITIVITY: Record<CensorSensitivity, CensorTier[]> = {
  LOW: ["slur", "strong"],
  MEDIUM: ["slur", "strong", "common"],
  HIGH: ["slur", "strong", "common", "mild"],
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
  "fuckwit",
  "fuckhead",
  "fuckface",
  "dumbfuck",
  "clusterfuck",
  "cunt",
  "cock",
  "cocksuck",
  "cocksucker",
  "twat",
  "prick",
];

/**
 * Slurs — caught at every sensitivity, and tagged as their own tier in the
 * review panel so the user can see what was matched before it is applied.
 *
 * Terms whose everyday meaning overwhelms the slur sense are deliberately
 * absent, because a filter that masks "the ace of spades", "graham cracker",
 * "a nip of whisky" or "that's lame" is one people switch off entirely, which
 * protects nobody. The ones kept here that *do* carry an innocent sense
 * ("chink", "fag", "faggot", "gimp", "retard" as a verb) are included because
 * the slur use is common enough to be worth catching — the review step and the
 * allow-list are how the innocent uses get through.
 */
const SLUR = [
  // racial / ethnic
  "nigger",
  "nigga",
  "chink",
  "chinaman",
  "gook",
  "spic",
  "wetback",
  "beaner",
  "kike",
  "hebe",
  "wop",
  "dago",
  "paki",
  "raghead",
  "towelhead",
  "sandnigger",
  "coon",
  "jigaboo",
  "pickaninny",
  "sambo",
  "redskin",
  "injun",
  "squaw",
  "mulatto",
  "zipperhead",
  "jap",
  "abo",
  "boong",
  "kaffir",
  "honky",
  // homophobic / transphobic
  "faggot",
  "fag",
  "dyke",
  "tranny",
  "shemale",
  "poof",
  "poofter",
  // ableist
  "retard",
  "retarded",
  "spastic",
  "spaz",
  "mongoloid",
  "cripple",
  "gimp",
  "midget",
];

/** Everyday profanity — caught at medium and above. */
const COMMON = [
  "shit",
  "bullshit",
  "shite",
  "shithead",
  "shitbag",
  "bitch",
  "asshole",
  "arsehole",
  "asswipe",
  "assclown",
  "bastard",
  "dick",
  "dickhead",
  "piss",
  "pissed",
  "slut",
  "skank",
  "slag",
  "whore",
  "douche",
  "douchebag",
  "jackass",
  "dumbass",
  "smartass",
  "jackoff",
  "jerkoff",
  "bollock",
  "bollocks",
  "bugger",
  "wank",
  "wanker",
  "tosser",
  "knobhead",
  "bellend",
  "minge",
  // crude / anatomical
  "cum",
  "jizz",
  "boner",
  "dildo",
  "tits",
  "titty",
  "nutsack",
  "ballsack",
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
  "frig",
  "frigging",
  "prat",
  "pillock",
  "jesus",
  "christ",
  "god",
];

export const LEXICON: Record<CensorTier, readonly string[]> = {
  slur: SLUR,
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

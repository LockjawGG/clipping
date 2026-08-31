/**
 * How far the clip's own audio drops while a narration line plays.
 *
 * Narration is a voice talking over a voice. Ducking it part-way leaves both
 * audible at once, which is the one thing narration must not do — you end up
 * hearing the speaker and the reading of the speaker together, neither
 * intelligible. So the range reaches actual silence and that is the default:
 * the narration covers what it is narrating.
 *
 * The gain is computed here rather than at each call site because the preview
 * and the export both need it and must agree. They compute it from the same
 * number and previously each did their own `10 ** (db / 20)`, which is fine
 * until one of them changes.
 */

/**
 * The bottom of the range, in dB. Treated as true silence rather than
 * `10 ** (-60 / 20)` ≈ 0.001, so "silent" means silent rather than very nearly
 * so — an amplitude that small is inaudible, but zero is unarguable.
 */
export const DUCK_SILENT_DB = -60;

/** The default for a new narration: cover the audio underneath it. */
export const DUCK_DEFAULT_DB = DUCK_SILENT_DB;

/**
 * Linear gain for a duck level in dB. 0 dB leaves the audio alone; anything at
 * or below {@link DUCK_SILENT_DB} is silence.
 */
export function duckGain(db: number): number {
  if (db >= 0) return 1;
  if (db <= DUCK_SILENT_DB) return 0;
  return Math.pow(10, db / 20);
}

/** How the level reads in the UI: a number of dB, or the word for zero. */
export function duckLabel(db: number): string {
  return db <= DUCK_SILENT_DB ? "silent" : `${db.toFixed(0)} dB`;
}

/**
 * Transcript translation targets, isomorphic (no server-only imports) so the
 * editor can list them.
 *
 * "en" goes through Whisper's own speech-translation (best quality, no model
 * download). Every other target is offline text translation of the existing
 * transcript via Argos, which auto-pivots through English.
 */
export const TRANSLATE_TARGETS = [
  "en", "es", "fr", "de", "it", "pt", "nl", "ru", "pl", "uk", "tr", "ar",
  "he", "hi", "ja", "ko", "zh", "vi", "th", "id", "sv", "cs", "el", "ro", "hu",
] as const;

export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number];

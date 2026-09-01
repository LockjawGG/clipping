/**
 * String hygiene for text that crosses a process boundary.
 *
 * Speech engines occasionally emit unpaired UTF-16 surrogates — a multi-byte
 * character split across tokens leaves half a pair behind. JavaScript strings
 * carry them silently, and Postgres stores them, but anything that has to
 * *encode* the string as UTF-8 (Piper, JSON.stringify→disk, ffmpeg metadata)
 * throws `surrogates not allowed`. Strip the lone halves; real pairs (emoji,
 * CJK extensions) pass through untouched.
 */
export function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

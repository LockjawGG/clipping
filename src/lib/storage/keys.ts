/**
 * Storage keys are always server-generated (`videos/<cuid>/source.mp4`, and the
 * like). They are never a client-supplied filename. `assertSafeKey` enforces
 * that invariant so a key can be joined onto a local directory or handed to the
 * S3 SDK without a second thought.
 *
 * Allowed: slash-separated segments of `[A-Za-z0-9._-]`, each segment starting
 * with an alphanumeric. No leading/trailing slash, no empty segment, no `..`,
 * no backslash, no drive letter, no control characters.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.includes("\0") || key.includes("\\")) return false;
  if (key.startsWith("/") || key.endsWith("/")) return false;
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (!SEGMENT.test(segment)) return false;
  }
  return true;
}

export function assertSafeKey(key: string): asserts key is string {
  if (!isSafeKey(key)) {
    throw new Error(`unsafe storage key: ${JSON.stringify(key)}`);
  }
}

/** Joins key segments and validates the result. */
export function storageKey(...parts: Array<string | number>): string {
  const key = parts
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0)
    .join("/");
  assertSafeKey(key);
  return key;
}

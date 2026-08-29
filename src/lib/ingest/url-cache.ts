import { createHash } from "node:crypto";

/**
 * URL normalisation for the "already transcribed this link" cache.
 *
 * Deliberately conservative: only strips things that provably don't change which
 * video you get — the fragment, a default port, a trailing slash on the root,
 * and a denylist of well-known tracking / analytics params. Host is lowercased
 * (case-insensitive per the RFC); the path and remaining query are left as-is.
 */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "si", // youtube share id
  "feature", // youtube
  "spm", // bilibili / taobao
  "_hsenc",
  "_hsmi",
]);

/** Canonical form of a source URL, or the trimmed input if it can't be parsed. */
export function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.hash = "";
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  let out = u.toString();
  // Drop a lone trailing slash on the root path ("https://x.com/" -> "https://x.com").
  if (u.pathname === "/" && !u.search) out = out.replace(/\/$/, "");
  return out;
}

/** SHA-256 (hex) of the normalised URL — the cache key stored on `Video`. */
export function sourceUrlHash(rawOrNormalized: string): string {
  return createHash("sha256").update(normalizeSourceUrl(rawOrNormalized)).digest("hex");
}

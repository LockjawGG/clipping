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

/** A YouTube video id: exactly 11 URL-safe base64 chars. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Fold YouTube's many URL forms for the same video onto one canonical
 * `youtube.com/watch?v=<id>` — `youtu.be/<id>`, `/shorts/<id>`, `/live/<id>`,
 * `/embed/<id>`, and the `m.`/`music.` hosts. Non-YouTube URLs pass through.
 */
function canonicalizeYouTube(u: URL): void {
  const host = u.hostname;
  const isYt =
    host === "youtu.be" ||
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com";
  if (!isYt) return;

  let id: string | null = null;
  if (host === "youtu.be") {
    id = u.pathname.slice(1).split("/")[0] || null;
  } else if (u.pathname === "/watch") {
    id = u.searchParams.get("v");
  } else {
    const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
    if (m) id = m[1];
  }
  if (!id || !YT_ID.test(id)) return;

  u.hostname = "youtube.com";
  u.pathname = "/watch";
  u.search = "";
  u.searchParams.set("v", id);
}

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
  canonicalizeYouTube(u);
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

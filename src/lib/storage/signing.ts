import { createHmac, timingSafeEqual } from "node:crypto";

import { assertSafeKey, isSafeKey } from "./keys.ts";

/**
 * HMAC tokens for the local storage provider's upload/download URLs.
 *
 * The S3 provider gets real presigned URLs from the AWS SDK. The local provider
 * has no such thing, so it points the browser at an API route (added in a later
 * PR) guarded by one of these tokens. The token binds a single key + action +
 * expiry; the route recomputes the HMAC and rejects anything else.
 *
 * Token wire format: `<expEpochSeconds>.<base64url(hmacSha256)>`
 */
export type StorageAction = "put" | "get";

const SEP = ".";

function mac(secret: string, action: StorageAction, key: string, expSec: number): Buffer {
  return createHmac("sha256", secret)
    .update(`${action}\n${key}\n${expSec}`)
    .digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SignParams {
  secret: string;
  action: StorageAction;
  key: string;
  /** Seconds from now until the token expires. */
  expiresInSec: number;
  /**
   * Round the expiry up to a multiple of this many seconds. Repeated calls for
   * the same key inside one `bucketSec` window then produce a byte-identical
   * token, so a URL passed to React as a prop stays referentially stable across
   * re-renders (no `<video>` remount on every ingest poll). The token stays
   * valid for at least `expiresInSec` and at most `expiresInSec + bucketSec`.
   * Omit for a fresh token every call.
   */
  bucketSec?: number;
  /** Clock injection point for tests. */
  now?: () => number;
}

export function signStorageToken({
  secret,
  action,
  key,
  expiresInSec,
  bucketSec,
  now = Date.now,
}: SignParams): string {
  if (!secret) throw new Error("a signing secret is required");
  assertSafeKey(key);
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    throw new Error(`invalid expiry: ${expiresInSec}`);
  }
  const rawExp = Math.floor(now() / 1000) + Math.floor(expiresInSec);
  const expSec =
    bucketSec && bucketSec > 0 ? Math.ceil(rawExp / bucketSec) * bucketSec : rawExp;
  return `${expSec}${SEP}${b64url(mac(secret, action, key, expSec))}`;
}

export interface VerifyParams {
  secret: string;
  action: StorageAction;
  key: string;
  token: string;
  now?: () => number;
}

export type VerifyResult = { ok: true; expiresAt: number } | { ok: false; reason: string };

export function verifyStorageToken({
  secret,
  action,
  key,
  token,
  now = Date.now,
}: VerifyParams): VerifyResult {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  if (!isSafeKey(key)) return { ok: false, reason: "unsafe key" };
  if (typeof token !== "string" || !token.includes(SEP)) {
    return { ok: false, reason: "malformed token" };
  }

  const idx = token.indexOf(SEP);
  const expPart = token.slice(0, idx);
  const sigPart = token.slice(idx + 1);
  const expSec = Number(expPart);
  if (!Number.isInteger(expSec) || expSec <= 0) return { ok: false, reason: "malformed token" };

  const expected = b64url(mac(secret, action, key, expSec));
  const a = Buffer.from(expected);
  const b = Buffer.from(sigPart);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }
  if (Math.floor(now() / 1000) >= expSec) {
    return { ok: false, reason: "token expired" };
  }
  return { ok: true, expiresAt: expSec * 1000 };
}

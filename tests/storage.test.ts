import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeKey, isSafeKey, storageKey } from "../src/lib/storage/keys.ts";
import { signStorageToken, verifyStorageToken } from "../src/lib/storage/signing.ts";
import { LocalStorageProvider } from "../src/lib/storage/local.ts";

// --- key safety ---------------------------------------------------------

test("isSafeKey accepts server-generated keys", () => {
  for (const k of ["a", "videos/abc123/source.mp4", "renders/c1/clip-01.mp4", "x_y.z-1/2"]) {
    assert.equal(isSafeKey(k), true, k);
  }
});

test("isSafeKey rejects traversal, absolute, and hostile keys", () => {
  for (const k of [
    "",
    "/etc/passwd",
    "videos/../secret",
    "..",
    "a//b",
    "a/",
    "/a",
    "a\\b",
    "C:\\windows",
    "a\0b",
    "-flag",
    "space here",
  ]) {
    assert.equal(isSafeKey(k), false, k);
  }
});

test("assertSafeKey throws on a bad key and storageKey joins a good one", () => {
  assert.throws(() => assertSafeKey("../x"));
  assert.equal(storageKey("videos", "abc", "source.mp4"), "videos/abc/source.mp4");
  assert.throws(() => storageKey("videos", "..", "x"));
});

// --- signed tokens -----------------------------------------------------

const SECRET = "test-secret-000";

test("a freshly signed token verifies for the same key and action", () => {
  const token = signStorageToken({ secret: SECRET, action: "put", key: "videos/a/x.mp4", expiresInSec: 300 });
  const res = verifyStorageToken({ secret: SECRET, action: "put", key: "videos/a/x.mp4", token });
  assert.equal(res.ok, true);
});

test("a token does not verify for a different key, action, or secret", () => {
  const token = signStorageToken({ secret: SECRET, action: "put", key: "videos/a/x.mp4", expiresInSec: 300 });
  assert.equal(verifyStorageToken({ secret: SECRET, action: "get", key: "videos/a/x.mp4", token }).ok, false);
  assert.equal(verifyStorageToken({ secret: SECRET, action: "put", key: "videos/a/y.mp4", token }).ok, false);
  assert.equal(verifyStorageToken({ secret: "other", action: "put", key: "videos/a/x.mp4", token }).ok, false);
});

test("an expired token is rejected", () => {
  const base = 1_000_000_000_000;
  const token = signStorageToken({
    secret: SECRET,
    action: "get",
    key: "a/b",
    expiresInSec: 60,
    now: () => base,
  });
  const res = verifyStorageToken({
    secret: SECRET,
    action: "get",
    key: "a/b",
    token,
    now: () => base + 61_000,
  });
  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /expired/);
});

test("a tampered signature is rejected", () => {
  const token = signStorageToken({ secret: SECRET, action: "put", key: "a/b", expiresInSec: 300 });
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(verifyStorageToken({ secret: SECRET, action: "put", key: "a/b", token: tampered }).ok, false);
});

// --- local provider --------------------------------------------------

async function withProvider(fn: (p: LocalStorageProvider, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "clipper-store-"));
  try {
    await fn(
      new LocalStorageProvider({ baseDir: dir, publicBaseUrl: "http://localhost:3000/", secret: SECRET }),
      dir,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("local provider round-trips a file through put / exists / get / delete", async () => {
  await withProvider(async (p, dir) => {
    const srcPath = join(dir, "in.bin");
    const outPath = join(dir, "out.bin");
    const payload = Buffer.from("clipper local storage payload");
    await writeFile(srcPath, payload);

    assert.equal(await p.exists("videos/v1/source.mp4"), false);
    await p.putFile("videos/v1/source.mp4", srcPath, "video/mp4");
    assert.equal(await p.exists("videos/v1/source.mp4"), true);

    await p.getToFile("videos/v1/source.mp4", outPath);
    assert.deepEqual(await readFile(outPath), payload);

    await p.delete("videos/v1/source.mp4");
    assert.equal(await p.exists("videos/v1/source.mp4"), false);
  });
});

test("local provider refuses a key that escapes the storage root", async () => {
  await withProvider(async (p, dir) => {
    const srcPath = join(dir, "in.bin");
    await writeFile(srcPath, "x");
    await assert.rejects(() => p.putFile("../escape.mp4", srcPath, "application/octet-stream"));
    await assert.rejects(() => p.getToFile("../../etc/passwd", join(dir, "out")));
  });
});

test("local provider signed URLs carry a token that verifies", async () => {
  await withProvider(async (p) => {
    const up = new URL(await p.createUploadUrl("videos/v1/source.mp4", "video/mp4"));
    assert.equal(up.pathname, "/api/storage/local/videos/v1/source.mp4");
    assert.equal(up.searchParams.get("action"), "put");
    assert.equal(
      verifyStorageToken({
        secret: SECRET,
        action: "put",
        key: "videos/v1/source.mp4",
        token: up.searchParams.get("token")!,
      }).ok,
      true,
    );

    const down = new URL(await p.createDownloadUrl("videos/v1/source.mp4"));
    assert.equal(down.searchParams.get("action"), "get");
    assert.equal(
      verifyStorageToken({
        secret: SECRET,
        action: "get",
        key: "videos/v1/source.mp4",
        token: down.searchParams.get("token")!,
      }).ok,
      true,
    );
  });
});

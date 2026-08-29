import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSourceUrl, sourceUrlHash } from "../src/lib/ingest/url-cache.ts";

test("normalizeSourceUrl lowercases scheme + host, drops the fragment and a www. prefix", () => {
  assert.equal(
    normalizeSourceUrl("HTTPS://WWW.YouTube.com/watch?v=abc#t=30"),
    "https://youtube.com/watch?v=abc",
  );
  assert.equal(
    normalizeSourceUrl("https://youtube.com/watch?v=abc"),
    normalizeSourceUrl("https://www.youtube.com/watch?v=abc"),
  );
});

test("normalizeSourceUrl strips known tracking params, keeps the rest, sorts", () => {
  assert.equal(
    normalizeSourceUrl("https://youtu.be/abc?si=xyz&utm_source=news&list=PL1&t=5"),
    "https://youtu.be/abc?list=PL1&t=5",
  );
});

test("normalizeSourceUrl leaves the path case intact and drops a default port", () => {
  assert.equal(
    normalizeSourceUrl("https://example.com:443/Path/To/Video.MP4"),
    "https://example.com/Path/To/Video.MP4",
  );
});

test("normalizeSourceUrl trims a lone trailing slash on the root only", () => {
  assert.equal(normalizeSourceUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeSourceUrl("https://example.com/a/"), "https://example.com/a/");
});

test("normalizeSourceUrl returns the trimmed input when it can't be parsed", () => {
  assert.equal(normalizeSourceUrl("  not a url  "), "not a url");
});

test("sourceUrlHash is stable across tracking-param / fragment noise", () => {
  const a = sourceUrlHash("https://youtu.be/abc?si=one#x");
  const b = sourceUrlHash("HTTPS://youtu.be/abc?si=two");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("sourceUrlHash differs for genuinely different URLs", () => {
  assert.notEqual(
    sourceUrlHash("https://youtu.be/abc"),
    sourceUrlHash("https://youtu.be/xyz"),
  );
});

test("normalizeSourceUrl folds YouTube's URL forms onto watch?v=<id>", () => {
  const ID = "dQw4w9WgXcQ";
  const canonical = `https://youtube.com/watch?v=${ID}`;
  for (const form of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=42&si=abc`,
    `https://www.youtube.com/watch?v=${ID}&list=PLxxxx&index=3`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}?autoplay=1`,
    `HTTPS://YOUTU.BE/${ID}#t=10`,
  ]) {
    assert.equal(normalizeSourceUrl(form), canonical, form);
  }
});

test("normalizeSourceUrl leaves non-YouTube and malformed-id YouTube URLs alone", () => {
  assert.equal(
    normalizeSourceUrl("https://vimeo.com/dQw4w9WgXcQ"),
    "https://vimeo.com/dQw4w9WgXcQ",
  );
  // 'abc' isn't a valid 11-char id -> no rewrite
  assert.equal(
    normalizeSourceUrl("https://youtube.com/watch?v=abc"),
    "https://youtube.com/watch?v=abc",
  );
});

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

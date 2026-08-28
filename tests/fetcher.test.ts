import test from "node:test";
import assert from "node:assert/strict";

import {
  FetchError,
  MAX_SOURCE_HEIGHT,
  buildProbeArgs,
  buildYtDlpArgs,
  classifyFetchError,
} from "../src/lib/pipeline/fetcher.ts";

// --- arg builders ------------------------------------------------------

test("buildYtDlpArgs caps the source resolution and keeps the mp4 preference", () => {
  const args = buildYtDlpArgs("https://x.example/v", "/tmp/videos/v/source", 500_000_000, "chrome");
  const s = args[args.indexOf("-S") + 1];
  assert.match(s, new RegExp(`res:${MAX_SOURCE_HEIGHT}`));
  assert.ok(args.includes("--merge-output-format") && args[args.indexOf("--merge-output-format") + 1] === "mp4");
  // url is argv[0] — never concatenated into a shell string
  assert.equal(args[0], "https://x.example/v");
  const imp = args.indexOf("--impersonate");
  assert.ok(imp >= 0 && args[imp + 1] === "chrome");
});

test("buildProbeArgs is download-free and single-json", () => {
  const args = buildProbeArgs("https://x.example/v", "chrome");
  assert.ok(args.includes("--skip-download"));
  assert.ok(args.includes("--dump-single-json"));
  assert.ok(args.includes("--no-playlist"));
  assert.ok(!args.includes("-o")); // writes nothing
  assert.equal(args[0], "https://x.example/v");

  const noImp = buildProbeArgs("https://x.example/v", "");
  assert.equal(noImp.includes("--impersonate"), false);
});

// --- error classification -------------------------------------------

test("classifyFetchError maps common yt-dlp failures to actionable kinds", () => {
  const cases: Array<[string, string]> = [
    ["ERROR: Unsupported URL: https://example.com/page", "unsupported"],
    ["ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", "unavailable"],
    ["ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "auth"],
    ["ERROR: [youtube] abc: This video requires authentication; use --cookies", "auth"],
    ["ERROR: [generic] Video not available in your country. Geo-restricted", "restricted"],
    ["ERROR: unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>", "network"],
    ["ERROR: [generic] Read timed out.", "network"],
    ["ERROR: [youtube] abc: Requested format is not available. Use --list-formats", "no_stream"],
    ["ERROR: [generic] Unable to extract video url", "no_stream"],
    ["ERROR: File is larger than max-filesize (900.00MiB > 500.00MiB). Aborting.", "too_large"],
    ["ERROR: something nobody has ever seen before", "unknown"],
  ];
  for (const [stderr, expected] of cases) {
    const { kind, message } = classifyFetchError(stderr);
    assert.equal(kind, expected, `\n"${stderr}"\n  got ${kind}, want ${expected}`);
    assert.ok(message.length > 0 && !message.includes("ERROR"), "message is user-facing");
  }
});

test("classifyFetchError checks size / auth before the generic 'removed' phrasing", () => {
  assert.equal(
    classifyFetchError("Private video. This video has been removed").kind,
    "auth",
  );
  assert.equal(
    classifyFetchError("File is larger than max-filesize; video unavailable").kind,
    "too_large",
  );
});

// --- FetchError ----------------------------------------------------

test("FetchError carries a kind and the technical tail, and reads as an Error", () => {
  const e = new FetchError("network", "Couldn’t reach the video source.", "getaddrinfo failed");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "FetchError");
  assert.equal(e.kind, "network");
  assert.equal(e.technical, "getaddrinfo failed");
  assert.equal(e.message, "Couldn’t reach the video source.");
});

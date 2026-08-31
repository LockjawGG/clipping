import test from "node:test";
import assert from "node:assert/strict";

import {
  FetchError,
  MAX_SOURCE_HEIGHT,
  buildProbeArgs,
  buildPlaylistProbeArgs,
  buildYtDlpArgs,
  isLikelyPlaylistUrl,
  parsePlaylistJson,
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

  // The format chain has to end somewhere that matches whatever the source
  // actually offers. A video with no muxed format and no mp4/m4a streams — VP9
  // or AV1 with opus, which is ordinary now — matched none of the earlier
  // branches, and yt-dlp reported "Requested format is not available" for
  // something it could have fetched.
  const fmt = args[args.indexOf("-f") + 1];
  const branches = fmt.split("/");
  assert.ok(branches.includes("bv*+ba"), `no codec-agnostic branch in "${fmt}"`);
  assert.ok(
    branches.indexOf("bv*+ba") > branches.indexOf("b[ext=mp4]"),
    "the mp4 preference must still be tried first",
  );
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

test("only explicit playlist markers take the playlist path", () => {
  assert.equal(isLikelyPlaylistUrl("https://www.youtube.com/playlist?list=PLx"), true);
  assert.equal(isLikelyPlaylistUrl("https://www.youtube.com/watch?v=a&list=PLx"), true);
  assert.equal(isLikelyPlaylistUrl("https://youtu.be/abc?list=RDabc"), true);
  // A plain watch link must never become a surprise bulk import.
  assert.equal(isLikelyPlaylistUrl("https://www.youtube.com/watch?v=abc"), false);
  assert.equal(isLikelyPlaylistUrl("https://example.com/v.mp4"), false);
  // "playlist" merely appearing in a path segment name is not a marker.
  assert.equal(isLikelyPlaylistUrl("https://example.com/playlists/cool.mp4"), false);
});

test("the playlist probe enumerates flat and never downloads", () => {
  const args = buildPlaylistProbeArgs("https://www.youtube.com/playlist?list=PLx", "chrome");
  assert.ok(args.includes("--flat-playlist"), "flat, or a long list probes for minutes");
  assert.ok(args.includes("--yes-playlist"));
  assert.ok(args.includes("--skip-download"));
  assert.ok(!args.includes("--no-playlist"));
  assert.equal(args[0], "https://www.youtube.com/playlist?list=PLx");
});

test("parsePlaylistJson maps entries and survives yt-dlp's variations", () => {
  const r = parsePlaylistJson({
    _type: "playlist",
    title: "Field Trip",
    playlist_count: 4,
    entries: [
      { url: "https://www.youtube.com/watch?v=a1", title: "One", duration: 61.4 },
      // YouTube flat entries sometimes carry only the id.
      { id: "a2", title: "Two" },
      // Junk entries appear for deleted/private videos; they are skipped.
      null,
      { title: "no url or id" },
    ],
  });
  assert.ok(r);
  assert.equal(r?.title, "Field Trip");
  assert.equal(r?.total, 4, "the source's own count survives even when entries were dropped");
  assert.deepEqual(r?.entries.map((e) => e.url), [
    "https://www.youtube.com/watch?v=a1",
    "https://www.youtube.com/watch?v=a2",
  ]);
  assert.equal(r?.entries[0].durationSec, 61);

  // A single video is not a playlist, whatever the URL looked like.
  assert.equal(parsePlaylistJson({ _type: "video", id: "x" }), null);
});

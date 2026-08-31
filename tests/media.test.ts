import test from "node:test";
import assert from "node:assert/strict";

import { analyzeUrl, ytdlpInfo } from "../src/lib/api/media.ts";
import { FetchError, type MediaProbe, type ProbeResult } from "../src/lib/pipeline/fetcher.ts";

const okProbe = (over: Partial<ProbeResult> = {}): MediaProbe => ({
  probePlaylist: async () => null,
  probe: async () => ({
    supported: true,
    title: "Example Video",
    durationSec: 1122,
    thumbnail: "https://img/thumb.jpg",
    source: "YouTube",
    hasVideo: true,
    hasAudio: true,
    approxBytes: 48_000_000,
    isLive: false,
    ...over,
  }),
  version: async () => "2026.01.15",
});

test("analyzeUrl rejects a non-URL before probing", async () => {
  await assert.rejects(() => analyzeUrl(okProbe(), { url: "not a url" }));
});

test("analyzeUrl returns a clean preview on success", async () => {
  const r = await analyzeUrl(okProbe(), { url: "https://youtube.com/watch?v=x" });
  assert.deepEqual(r, {
    ok: true,
    title: "Example Video",
    durationSec: 1122,
    thumbnail: "https://img/thumb.jpg",
    source: "YouTube",
    hasVideo: true,
    hasAudio: true,
    approxBytes: 48_000_000,
    isLive: false,
  });
});

test("analyzeUrl surfaces a FetchError as a classified, user-facing failure", async () => {
  const probe: MediaProbe = {
    probePlaylist: async () => null,
    probe: async () => {
      throw new FetchError("auth", "This video needs an account to access.", "Private video");
    },
    version: async () => "2026.01.15",
  };
  const r = await analyzeUrl(probe, { url: "https://youtube.com/watch?v=priv" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "auth");
    assert.match(r.message, /account/);
    assert.equal(r.technical, "Private video");
  }
});

test("analyzeUrl wraps an unexpected error as kind 'unknown'", async () => {
  const probe: MediaProbe = {
    probePlaylist: async () => null,
    probe: async () => {
      throw new Error("kaboom");
    },
    version: async () => null,
  };
  const r = await analyzeUrl(probe, { url: "https://x.example/v" });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "unknown");
    assert.equal(r.technical, "kaboom");
  }
});

test("ytdlpInfo reports the version and a display-only update command", async () => {
  assert.deepEqual(await ytdlpInfo(okProbe()), {
    installed: true,
    version: "2026.01.15",
    updateCommand: "pip install -U yt-dlp",
  });
  const missing: MediaProbe = { ...okProbe(), version: async () => null };
  const info = await ytdlpInfo(missing);
  assert.equal(info.installed, false);
  assert.equal(info.version, null);
});

test("analyzeUrl answers a playlist link as a playlist, capped honestly", async () => {
  const probe: MediaProbe = {
    probe: async () => {
      throw new Error("single-video probe must not run for a playlist link");
    },
    probePlaylist: async () => ({
      title: "My Mix",
      total: 250,
      entries: Array.from({ length: 250 }, (_, i) => ({
        url: `https://www.youtube.com/watch?v=v${i}`,
        title: `Video ${i}`,
      })),
    }),
    version: async () => "2026.01.15",
  };
  const r = await analyzeUrl(probe, { url: "https://www.youtube.com/playlist?list=PLx" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.playlist, "playlist links must be answered as playlists");
    assert.equal(r.playlist?.total, 250);
    // The cap is part of the answer, not a surprise at ingest time.
    assert.equal(r.playlist?.willAdd, 100);
    assert.equal(r.playlist?.firstTitles.length, 3);
  }
});

test("a watch link without a list marker never takes the playlist path", async () => {
  const probe: MediaProbe = {
    probePlaylist: async () => {
      throw new Error("must not enumerate a plain watch link");
    },
    probe: async () => ({
      supported: true, hasVideo: true, hasAudio: true, isLive: false,
    }),
    version: async () => null,
  };
  const r = await analyzeUrl(probe, { url: "https://www.youtube.com/watch?v=solo" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.playlist, undefined);
});

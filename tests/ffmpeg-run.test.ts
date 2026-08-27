import test from "node:test";
import assert from "node:assert/strict";

import { parseProbeOutput } from "../src/lib/ffmpeg/run.ts";

test("parseProbeOutput normalises a typical video+audio probe", () => {
  const info = parseProbeOutput({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        r_frame_rate: "30000/1001",
      },
      { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
    ],
    format: { duration: "123.456", size: "10485760" },
  });

  assert.equal(info.durationMs, 123_456);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.equal(info.fps, 29.97);
  assert.equal(info.videoCodec, "h264");
  assert.equal(info.audioCodec, "aac");
  assert.equal(info.hasAudio, true);
  assert.equal(info.audioChannels, 2);
  assert.equal(info.sampleRate, 48_000);
  assert.equal(info.sizeBytes, 10_485_760);
});

test("parseProbeOutput handles a video with no audio track", () => {
  const info = parseProbeOutput({
    streams: [{ codec_type: "video", codec_name: "vp9", width: 720, height: 1280, r_frame_rate: "24/1" }],
    format: { duration: "8" },
  });
  assert.equal(info.hasAudio, false);
  assert.equal(info.audioCodec, null);
  assert.equal(info.audioChannels, null);
  assert.equal(info.fps, 24);
  assert.equal(info.durationMs, 8000);
});

test("parseProbeOutput falls back to a stream duration when format lacks one", () => {
  const info = parseProbeOutput({
    streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, duration: "5.5" }],
  });
  assert.equal(info.durationMs, 5500);
  assert.equal(info.fps, null); // no frame-rate field
});

test("parseProbeOutput is total on garbage input", () => {
  const info = parseProbeOutput(null);
  assert.equal(info.durationMs, 0);
  assert.equal(info.hasAudio, false);
  assert.equal(info.width, null);
});

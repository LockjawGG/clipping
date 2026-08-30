/**
 * Runs the generated argv arrays through the real ffmpeg binary.
 *
 * Kept separate from the unit suite because it needs ffmpeg on PATH and writes
 * to disk. Note execFile with no shell — that is the whole point of returning
 * argv arrays instead of command strings.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCutArgs,
  buildReframeArgs,
  buildExtractAudioArgs,
  buildProbeArgs,
  buildCensorAudioArgs,
  buildConcatArgs,
  buildVideoLayerArgs,
  concatListLine,
} from "../src/lib/ffmpeg/args.ts";
import { buildCues, toSrt } from "../src/lib/captions/layout.ts";

const run = promisify(execFile);
// The OS temp dir, not a hardcoded /tmp: on Windows that resolved to C:\tmp,
// which is not where anything lives, so every check failed on a path error
// rather than on anything it was meant to test.
const DIR = join(tmpdir(), "clipper-integration");
const SRC = join(DIR, "src.mp4");

/**
 * Build the fixture the checks run against.
 *
 * It used to be assumed to already exist, which meant a clean checkout got six
 * failures that read like code bugs and were really "you did not put a video
 * there". Generating it makes the suite self-contained, and synthetic input is
 * better here anyway: colour bars and a 440 Hz tone are exactly reproducible,
 * so a drift or a level is the code's doing and not the clip's.
 */
async function makeFixture(): Promise<void> {
  await run("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    SRC,
  ]);
}

async function main() {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  try {
    await makeFixture();
  } catch (e) {
    console.log(`  FAIL  fixture: ${String(e).split("\n").slice(-3).join(" ")}`);
    console.log("\ncould not build the test clip — is ffmpeg on PATH?");
    process.exit(1);
  }
  let failures = 0;
  const ok = (label: string, detail = "") => console.log(`  pass  ${label}${detail ? ` (${detail})` : ""}`);
  const bad = (label: string, err: unknown) => {
    failures++;
    console.log(`  FAIL  ${label}\n        ${String(err).split("\n").slice(-3).join("\n        ")}`);
  };

  // probe
  try {
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: SRC }));
    const meta = JSON.parse(stdout);
    const v = meta.streams.find((s: any) => s.codec_type === "video");
    ok("probe", `${v.width}x${v.height} ${Math.round(Number(meta.format.duration))}s`);
  } catch (e) {
    bad("probe", e);
  }

  // audio extraction
  try {
    await run("ffmpeg", buildExtractAudioArgs({ inputPath: SRC, outputPath: join(DIR, "audio.wav") }));
    const { size } = await stat(join(DIR, "audio.wav"));
    ok("extract audio", `${(size / 1024).toFixed(0)}KB 16kHz mono`);
  } catch (e) {
    bad("extract audio", e);
  }

  // frame-accurate cut
  try {
    await run("ffmpeg", buildCutArgs({ inputPath: SRC, outputPath: join(DIR, "clip.mp4"), startMs: 2500, endMs: 8250 }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: join(DIR, "clip.mp4") }));
    const duration = Number(JSON.parse(stdout).format.duration);
    const driftMs = Math.abs(duration * 1000 - 5750);
    if (driftMs > 500) throw new Error(`cut drifted ${driftMs.toFixed(0)}ms`);
    ok("cut 2.5s-8.25s", `${duration.toFixed(3)}s, drift ${driftMs.toFixed(0)}ms`);
  } catch (e) {
    bad("cut", e);
  }

  // subtitle burn onto a 9:16 reframe
  try {
    const cues = buildCues([
      { text: "Burned", startMs: 0, endMs: 900 },
      { text: "in", startMs: 900, endMs: 1400 },
      { text: "captions.", startMs: 1400, endMs: 2600 },
      { text: "Second", startMs: 3000, endMs: 3800 },
      { text: "cue", startMs: 3800, endMs: 4400 },
      { text: "here.", startMs: 4400, endMs: 5200 },
    ]);
    await writeFile(join(DIR, "subs.srt"), toSrt(cues, 0), "utf8");
    await run("ffmpeg", buildReframeArgs({
      inputPath: join(DIR, "clip.mp4"),
      outputPath: join(DIR, "final_9x16.mp4"),
      aspect: "9:16",
      focalX: 0.5,
      focalY: 0.4,
      subtitlePath: join(DIR, "subs.srt"),
    }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: join(DIR, "final_9x16.mp4") }));
    const v = JSON.parse(stdout).streams.find((s: any) => s.codec_type === "video");
    if (v.width !== 1080 || v.height !== 1920) throw new Error(`got ${v.width}x${v.height}`);
    ok("reframe 9:16 + burn subs", `${v.width}x${v.height}, ${cues.length} cues`);
  } catch (e) {
    bad("reframe + burn", e);
  }

  // blurred-background variant
  try {
    await run("ffmpeg", buildReframeArgs({
      inputPath: join(DIR, "clip.mp4"),
      outputPath: join(DIR, "final_blur.mp4"),
      aspect: "9:16",
      blurredBackground: true,
    }));
    ok("reframe with blurred background");
  } catch (e) {
    bad("blurred background", e);
  }

  // Joining pieces end to end — the timeline's whole job. Two cuts of the same
  // source stream-copy, so the check is that the demuxer accepts the list and
  // the result is exactly as long as the pieces put together.
  try {
    const a = join(DIR, "piece-a.mp4");
    const b = join(DIR, "piece-b.mp4");
    await run("ffmpeg", buildCutArgs({ inputPath: SRC, outputPath: a, startMs: 0, endMs: 2_000 }));
    await run("ffmpeg", buildCutArgs({ inputPath: SRC, outputPath: b, startMs: 8_000, endMs: 11_000 }));
    await writeFile(join(DIR, "join.txt"), [a, b].map(concatListLine).join("\n") + "\n", "utf8");
    await run("ffmpeg", buildConcatArgs({
      listPath: join(DIR, "join.txt"),
      outputPath: join(DIR, "joined.mp4"),
    }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: join(DIR, "joined.mp4") }));
    const duration = Number(JSON.parse(stdout).format.duration);
    if (Math.abs(duration - 5) > 0.4) throw new Error(`joined to ${duration.toFixed(2)}s, expected ~5s`);
    ok("concat two cuts", `${duration.toFixed(2)}s from 2s + 3s`);
  } catch (e) {
    bad("concat", e);
  }

  // Laying a piece from an upper lane over the base. Only ffmpeg can say
  // whether the scale/pad/setpts/overlay chain actually builds.
  try {
    const layer = join(DIR, "layer.mp4");
    await run("ffmpeg", buildCutArgs({ inputPath: SRC, outputPath: layer, startMs: 5_000, endMs: 7_000 }));
    await run("ffmpeg", buildVideoLayerArgs({
      inputPath: join(DIR, "clip.mp4"),
      outputPath: join(DIR, "layered.mp4"),
      // The base's own frame size: layers are fitted into the base, so passing
      // anything else just makes the layer smaller than the picture.
      width: 1280,
      height: 720,
      layers: [{ path: layer, startSec: 1.5 }],
    }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: join(DIR, "layered.mp4") }));
    const meta = JSON.parse(stdout);
    const v = meta.streams.find((s: any) => s.codec_type === "video");
    if (v.width !== 1280 || v.height !== 720) throw new Error(`got ${v.width}x${v.height}`);
    // The base must run its full length: a layer covers part of it, not all.
    const duration = Number(meta.format.duration);
    if (duration < 5) throw new Error(`base was truncated to ${duration.toFixed(2)}s`);
    ok("layer over base", `${v.width}x${v.height}, base still ${duration.toFixed(2)}s`);
  } catch (e) {
    bad("video layer", e);
  }

  // Per-span censoring, with three different treatments in one graph. The unit
  // tests assert the filter string; only ffmpeg can say whether it is valid,
  // and this is the graph whose input count varies with the spans, which is
  // exactly the kind of thing that is easy to get subtly wrong.
  try {
    await run("ffmpeg", buildCensorAudioArgs({
      inputPath: join(DIR, "clip.mp4"),
      outputPath: join(DIR, "censored.mp4"),
      mode: "BEEP",
      spans: [
        { startSec: 0.5, endSec: 1.0 },                 // follows the clip: beep
        { startSec: 2.0, endSec: 2.5, mode: "TONE" },
        { startSec: 3.0, endSec: 3.5, mode: "MUTE" },
      ],
    }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: join(DIR, "censored.mp4") }));
    const meta = JSON.parse(stdout);
    const audio = meta.streams.find((s: any) => s.codec_type === "audio");
    if (!audio) throw new Error("censored output has no audio stream");
    // The pass must not change the length: it replaces sound, it does not cut.
    const before = Number(JSON.parse(
      (await run("ffprobe", buildProbeArgs({ inputPath: join(DIR, "clip.mp4") }))).stdout,
    ).format.duration);
    const after = Number(meta.format.duration);
    if (Math.abs(after - before) > 0.15) {
      throw new Error(`duration changed ${before.toFixed(2)}s -> ${after.toFixed(2)}s`);
    }
    ok("censor audio, three treatments", `${after.toFixed(2)}s, unchanged length`);
  } catch (e) {
    bad("censor audio", e);
  }

  // Muting every span takes a different branch: nothing is mixed in at all.
  try {
    await run("ffmpeg", buildCensorAudioArgs({
      inputPath: join(DIR, "clip.mp4"),
      outputPath: join(DIR, "muted.mp4"),
      mode: "MUTE",
      spans: [{ startSec: 1.0, endSec: 2.0 }],
    }));
    await stat(join(DIR, "muted.mp4"));
    ok("censor audio, all muted", "no generator, duck only");
  } catch (e) {
    bad("censor audio (mute)", e);
  }

  // A filename that would be catastrophic under a shell. No embedded slashes,
  // so it is a single legal filename rather than a path through directories
  // that don't exist.
  try {
    const nasty = join(DIR, "clip; touch PWNED; echo $(id).mp4");
    await run("ffmpeg", ["-y", "-i", SRC, "-t", "1", "-c", "copy", nasty]);

    // The canary is what matters: if any shell had seen that string, this exists.
    let pwned = false;
    try { await stat(join(DIR, "PWNED")); pwned = true; } catch { /* expected */ }
    if (pwned) throw new Error("shell metacharacters were interpreted");

    // And the literal filename was created, proving it was treated as one arg.
    await stat(nasty);
    ok("shell metacharacters inert", "argv only, canary never fired");
  } catch (e) {
    bad("shell safety", e);
  }

  console.log(failures === 0 ? "\nall integration checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

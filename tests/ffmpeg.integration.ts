/**
 * Runs the generated argv arrays through the real ffmpeg binary.
 *
 * Kept separate from the unit suite because it needs ffmpeg on PATH and writes
 * to disk. Note execFile with no shell — that is the whole point of returning
 * argv arrays instead of command strings.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

import { buildCutArgs, buildReframeArgs, buildExtractAudioArgs, buildProbeArgs } from "../src/lib/ffmpeg/args.ts";
import { buildCues, toSrt } from "../src/lib/captions/layout.ts";

const run = promisify(execFile);
const DIR = "/tmp/vt";
const SRC = `${DIR}/src.mp4`;

async function main() {
  await mkdir(DIR, { recursive: true });
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
    await run("ffmpeg", buildExtractAudioArgs({ inputPath: SRC, outputPath: `${DIR}/audio.wav` }));
    const { size } = await stat(`${DIR}/audio.wav`);
    ok("extract audio", `${(size / 1024).toFixed(0)}KB 16kHz mono`);
  } catch (e) {
    bad("extract audio", e);
  }

  // frame-accurate cut
  try {
    await run("ffmpeg", buildCutArgs({ inputPath: SRC, outputPath: `${DIR}/clip.mp4`, startMs: 2500, endMs: 8250 }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: `${DIR}/clip.mp4` }));
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
    await writeFile(`${DIR}/subs.srt`, toSrt(cues, 0), "utf8");
    await run("ffmpeg", buildReframeArgs({
      inputPath: `${DIR}/clip.mp4`,
      outputPath: `${DIR}/final_9x16.mp4`,
      aspect: "9:16",
      focalX: 0.5,
      focalY: 0.4,
      subtitlePath: `${DIR}/subs.srt`,
    }));
    const { stdout } = await run("ffprobe", buildProbeArgs({ inputPath: `${DIR}/final_9x16.mp4` }));
    const v = JSON.parse(stdout).streams.find((s: any) => s.codec_type === "video");
    if (v.width !== 1080 || v.height !== 1920) throw new Error(`got ${v.width}x${v.height}`);
    ok("reframe 9:16 + burn subs", `${v.width}x${v.height}, ${cues.length} cues`);
  } catch (e) {
    bad("reframe + burn", e);
  }

  // blurred-background variant
  try {
    await run("ffmpeg", buildReframeArgs({
      inputPath: `${DIR}/clip.mp4`,
      outputPath: `${DIR}/final_blur.mp4`,
      aspect: "9:16",
      blurredBackground: true,
    }));
    ok("reframe with blurred background");
  } catch (e) {
    bad("blurred background", e);
  }

  // A filename that would be catastrophic under a shell. No embedded slashes,
  // so it is a single legal filename rather than a path through directories
  // that don't exist.
  try {
    const nasty = `${DIR}/clip; touch PWNED; echo $(id).mp4`;
    await run("ffmpeg", ["-y", "-i", SRC, "-t", "1", "-c", "copy", nasty]);

    // The canary is what matters: if any shell had seen that string, this exists.
    let pwned = false;
    try { await stat(`${DIR}/PWNED`); pwned = true; } catch { /* expected */ }
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

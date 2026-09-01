import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProviderUnavailableError, type TranscriptionProvider } from "../providers/types.ts";
import { beamSizeFor } from "../api/settings.ts";
import { stripLoneSurrogates } from "../text.ts";
import type { Segment, TranscribeOptions, TranscriptResult, Word } from "../providers/types.ts";

/**
 * Whisper through whisper.cpp: one executable and one model file, no Python.
 *
 * This exists for the packaged desktop build, which lands on machines that have
 * no Python and no way to get one. The reference engine stays the default where
 * it is installed — see the note on quality below.
 *
 * Two flags are not optional:
 *
 *   -l auto        whisper.cpp defaults to English rather than detecting.
 *                  Pointed at Korean audio it emits "[SPEAKING KOREAN]" as a
 *                  sound-event label instead of transcribing a word.
 *
 *   --suppress-nst Without it, a clip with music under the speech comes back as
 *                  "[MUSIC]" and nothing else — the whole transcript replaced
 *                  by a label. With it, the same clip matched the reference
 *                  engine word for word.
 *
 * Quality, measured rather than assumed: on English it matched the reference
 * exactly. On a Korean clip it dropped a repeated phrase and misheard two
 * others, so it is a fallback rather than a replacement.
 */
export interface WhisperCppOptions {
  /** Path to `whisper-cli.exe`. */
  binary: string;
  /**
   * Optional GPU build of the same executable, tried ahead of `binary`.
   *
   * Preferred, never required: it is a pack the user drops in, so a driver
   * update or a half-deleted directory can break it at any time. A failure of
   * it falls back to `binary` rather than failing the job.
   */
  gpuBinary?: string;
  /** Path to a ggml model file. */
  model: string;
  tempDir: string;
  beamSize?: number;
}

interface CppToken {
  text: string;
  offsets?: { from: number; to: number };
  p?: number;
}

interface CppSegment {
  offsets?: { from: number; to: number };
  text?: string;
  tokens?: CppToken[];
}

interface CppJson {
  transcription?: CppSegment[];
  result?: { language?: string };
}

/**
 * The model quality "fast" should use, when it can be better than a greedy
 * pass: the small sibling of the configured model, if that file is installed.
 * The zip build ships it (a real ~3x speedup); the single-exe build cannot
 * (the installer format tops out at 2GB with one model), so there this
 * returns null and fast falls back to a beam-1 pass on the configured model.
 */
export function fastWhisperCppModel(
  configured: string,
  exists: (p: string) => boolean,
): string | null {
  const sibling = configured.replace(/medium|large(?:-v\d+)?/i, "small");
  if (sibling === configured) return null;
  return exists(sibling) ? sibling : null;
}

/**
 * Which binary leads a run, and what a failure of it may retry on.
 *
 * `fallback` is non-null only when the GPU build leads, so a CPU failure can
 * never be retried on the same CPU binary — that would double the wait before
 * reporting the same error. A GPU path already known broken is skipped
 * outright, and a `gpuBinary` equal to `binary` is not a second engine.
 */
export function planWhisperCppRun(opts: {
  binary: string;
  gpuBinary?: string;
  gpuBroken?: boolean;
}): { binary: string; fallback: string | null } {
  const { binary, gpuBinary, gpuBroken } = opts;
  if (!gpuBinary || gpuBroken || gpuBinary === binary) return { binary, fallback: null };
  return { binary: gpuBinary, fallback: binary };
}

/**
 * Did a run fail because the caller cancelled it, rather than because the
 * engine is broken?
 *
 * An abort must not fall back: the retry would burn a full decode nobody is
 * waiting for, and demoting the GPU path over a user pressing cancel would
 * cost every later job in the process. An aborted child rejects with an
 * AbortError, but a signal landing mid-decode can also surface as a nonzero
 * exit, so the signal itself is the more reliable witness of the two.
 */
export function isAbortFailure(err: unknown, signal?: { aborted: boolean }): boolean {
  if (signal?.aborted) return true;
  const e = err as { name?: string; code?: string } | null | undefined;
  return e?.name === "AbortError" || e?.code === "ABORT_ERR";
}

/**
 * GPU binaries that have failed once in this process.
 *
 * Keyed by path, so a repaired pack installed elsewhere is not tarred with the
 * old one's failure. Never cleared: a build that cannot run will not start
 * working mid-process, and every re-check costs a full decode before failing.
 */
const brokenGpuBinaries = new Set<string>();

/**
 * Special markers whisper.cpp emits inline. Not text. `[_BEG_]` ends with an
 * underscore but timestamp markers do not (`[_TT_443]`), so the match is on
 * the `[_` opener alone - requiring the closing underscore let every
 * timestamp token straight through.
 */
function isSpecial(text: string): boolean {
  return /^\[_[^\]]*\]$/.test(text.trim());
}

/**
 * Markers glued to real words - "world.[_TT_443]" arrives as ONE token, so the
 * whole-token check above never sees it and the marker rode into captions.
 * Applied to assembled text, not per token, like the surrogate scrub.
 */
export function stripSpecialMarkers(text: string): string {
  return text.replace(/\[_[^\]]*\]/g, "");
}

/**
 * Tokens into words.
 *
 * whisper.cpp reports timings per *token*, and a token is not a word: long
 * words arrive in pieces, and punctuation arrives on its own. The tokeniser
 * marks a word boundary by a leading space, so a token that starts with one
 * begins a new word and everything after it belongs to that word until the next.
 *
 * Getting this wrong is quiet rather than loud — captions still render, they
 * just highlight the wrong span — so it is pinned by tests.
 */
export function wordsFromTokens(tokens: readonly CppToken[]): Word[] {
  const words: Word[] = [];
  let probs: number[] = [];

  const flush = () => {
    if (words.length === 0 || probs.length === 0) return;
    const last = words[words.length - 1];
    last.confidence = probs.reduce((a, b) => a + b, 0) / probs.length;
    probs = [];
  };

  for (const t of tokens) {
    const raw = t.text ?? "";
    if (!raw || isSpecial(raw)) continue;
    const startsWord = raw.startsWith(" ");
    const text = raw.trim();
    if (!text) continue;

    const from = t.offsets?.from ?? 0;
    const to = Math.max(from, t.offsets?.to ?? from);

    if (startsWord || words.length === 0) {
      flush();
      words.push({ text, startMs: from, endMs: to });
    } else {
      // A continuation: a subword piece, or punctuation hugging the word.
      const last = words[words.length - 1];
      last.text += text;
      last.endMs = Math.max(last.endMs, to);
    }
    if (typeof t.p === "number") probs.push(t.p);
  }
  flush();
  return words;
}

/** Pure: whisper.cpp's `-ojf` JSON → TranscriptResult. Exported for tests. */
export function parseWhisperCppJson(raw: CppJson, model: string): TranscriptResult {
  const segments: Segment[] = (raw.transcription ?? []).map((s) => {
    // Sanitize after assembly, not per token: a character split across two
    // tokens joins back into a valid pair here, and only what stays unpaired
    // is junk that would crash downstream UTF-8 encoders (Piper).
    const words = wordsFromTokens(s.tokens ?? [])
      .map((w) => ({
        ...w,
        text: stripSpecialMarkers(stripLoneSurrogates(w.text)).trim(),
      }))
      .filter((w) => w.text.length > 0);
    const startMs = s.offsets?.from ?? words[0]?.startMs ?? 0;
    const endMs = Math.max(startMs, s.offsets?.to ?? words[words.length - 1]?.endMs ?? startMs);
    const text = stripSpecialMarkers(stripLoneSurrogates(s.text ?? words.map((w) => w.text).join(" "))).trim();
    return { text, startMs, endMs, words };
  });

  return {
    provider: "whisper-cpp",
    model,
    // whisper.cpp reports what it detected; "" would be a lie, and the caller
    // treats an unknown language as "not translated" either way.
    language: raw.result?.language ?? "",
    segments: segments.filter((s) => s.text.length > 0),
  };
}

export class WhisperCppProvider implements TranscriptionProvider {
  readonly name = "whisper-cpp";

  private readonly opts: WhisperCppOptions;

  constructor(opts: WhisperCppOptions) {
    this.opts = opts;
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<TranscriptResult> {
    const work = await fs.mkdtemp(path.join(this.opts.tempDir, "wcpp-"));
    const outBase = path.join(work, "out");
    try {

      const quality = options.quality ?? "accurate";
      // Fast prefers the small sibling model when installed; without it, the
      // same model decoded greedily. Accurate is always the configured model.
      const fastModel = quality === "fast" ? fastWhisperCppModel(this.opts.model, existsSync) : null;
      const model = fastModel ?? this.opts.model;
      const beam = fastModel ? (this.opts.beamSize ?? 5) : beamSizeFor(quality, this.opts.beamSize ?? 5);
      const args = [
        "-m", model,
        "-f", audioPath,
        // Detect rather than assume English — see the note at the top.
        "-l", options.language ?? "auto",
        // Without this a clip with music comes back as "[MUSIC]" and nothing else.
        "--suppress-nst",
        "-ojf",
        "-of", outBase,
        "-bs", String(beam),
        "--no-prints",
      ];
      if (options.task === "translate") args.push("-tr");
      if (options.vocabulary?.length) args.push("--prompt", options.vocabulary.join(", "));

      const gpuBinary = this.opts.gpuBinary;
      const plan = planWhisperCppRun({
        binary: this.opts.binary,
        gpuBinary,
        gpuBroken: gpuBinary ? brokenGpuBinaries.has(gpuBinary) : false,
      });
      try {
        return await this.runAndParse(plan.binary, args, options, outBase, model);
      } catch (err) {
        if (plan.fallback === null || isAbortFailure(err, options.signal)) throw err;
        // One failure is enough to stop preferring it: the same build fails the
        // same way for every later job, each time after a full wasted decode.
        if (gpuBinary) brokenGpuBinaries.add(gpuBinary);
        // A crashed run can leave a truncated out.json behind. Drop it, so the
        // CPU pass is read from its own output and not the GPU's wreckage.
        await fs.rm(`${outBase}.json`, { force: true }).catch(() => {});
        return await this.runAndParse(plan.fallback, args, options, outBase, model);
      }
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runAndParse(
    binary: string,
    args: string[],
    options: TranscribeOptions,
    outBase: string,
    model: string,
  ): Promise<TranscriptResult> {
    await this.run(binary, args, options);
    const json = JSON.parse(await fs.readFile(`${outBase}.json`, "utf8")) as CppJson;
    // Report the model actually used, so a fast run is auditable later.
    return parseWhisperCppJson(json, path.basename(model));
  }

  private run(binary: string, args: string[], options: TranscribeOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Leave a few cores for this process so the job heartbeat keeps firing,
      // matching what the other local engines reserve.
      const cores = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 3);
      const child = spawn(binary, [...args, "-t", String(cores)], {
        signal: options.signal,
        windowsHide: true,
      });

      let stderr = "";
      const alive = () => options.onActivity?.();
      child.stdout?.on("data", alive);
      child.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
        alive();
      });

      child.on("error", (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          reject(
            new ProviderUnavailableError(
              "transcription:whisper-cpp",
              // Name the variable that actually points at the missing file:
              // sending someone to WHISPER_CPP_BINARY over a broken GPU pack
              // is a wrong turn. Only reachable when the run is not retried.
              `whisper-cli not found at "${binary}" — set ${
                binary === this.opts.gpuBinary ? "WHISPER_CPP_GPU_BINARY" : "WHISPER_CPP_BINARY"
              }`,
            ),
          );
          return;
        }
        reject(err);
      });

      child.on("close", (code) => {
        if (code === 0) return resolve();
        if (/failed to load|no such file/i.test(stderr)) {
          reject(
            new ProviderUnavailableError(
              "transcription:whisper-cpp",
              `could not load the model at "${this.opts.model}" — set WHISPER_CPP_MODEL`,
            ),
          );
          return;
        }
        reject(new Error(`whisper-cli exited ${code}: ${stderr.trim().slice(-400)}`));
      });
    });
  }
}

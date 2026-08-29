import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import {
  ProviderUnavailableError,
  type Segment,
  type TranscribeOptions,
  type TranscriptionProvider,
  type TranscriptResult,
  type Word,
} from "../providers/types.ts";
import { clamp01, meanConfidence, normalizeLanguage, secToMs } from "./normalize.ts";


/** Shape of the JSON the OpenAI `whisper` CLI writes with `--output_format json`. */
interface WhisperJson {
  text?: string;
  language?: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
    no_speech_prob?: number;
    words?: Array<{ word: string; start: number; end: number; probability?: number }>;
  }>;
}

/** Pure: CLI JSON → TranscriptResult. Exported for tests. */
export function parseWhisperJson(raw: WhisperJson, model: string): TranscriptResult {
  const segments: Segment[] = (raw.segments ?? []).map((s) => {
    const words: Word[] = (s.words ?? []).map((w) => {
      const startMs = secToMs(w.start);
      return {
        text: w.word.trim(),
        startMs,
        endMs: Math.max(startMs, secToMs(w.end)),
        ...(typeof w.probability === "number" ? { confidence: clamp01(w.probability) } : {}),
      };
    });
    const startMs = secToMs(s.start);
    // avg_logprob is a natural-log probability; exp() puts it back on 0..1.
    const confidence =
      typeof s.avg_logprob === "number" ? clamp01(Math.exp(s.avg_logprob)) : undefined;
    return {
      text: s.text.trim(),
      startMs,
      endMs: Math.max(startMs, secToMs(s.end)),
      words,
      ...(confidence !== undefined ? { confidence } : {}),
    };
  });

  return {
    provider: "whisper-local",
    model,
    language: normalizeLanguage(raw.language),
    confidence: meanConfidence(segments.map((s) => s.confidence)),
    segments,
  };
}

export interface WhisperLocalOptions {
  binary: string;
  model: string;
  /** Where the CLI writes its JSON. A per-call subdir is created under this. */
  tempDir?: string;
  /** Beam-search width. Higher = more accurate, slower. CLI default is 5. */
  beamSize?: number;
}

/**
 * The CLI streams each decoded segment as `[MM:SS.mmm --> MM:SS.mmm]  text`
 * (with an `HH:` field once past an hour). The *end* of the latest cue is how
 * far into the audio it has got — the only progress signal whisper offers.
 * Returns the cue end in ms, or null for any other line.
 */
export function parseWhisperCueEndMs(line: string): number | null {
  const m = /-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})\]/.exec(line);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  return (
    (Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 +
    Number(frac.padEnd(3, "0"))
  );
}

/**
 * Windows exit codes for "the exe exists but its runtime wouldn't load" —
 * 0xC0000142 STATUS_DLL_INIT_FAILED, 0xC0000135 STATUS_DLL_NOT_FOUND,
 * 0xC000007B STATUS_INVALID_IMAGE_FORMAT. Common (and intermittent) with the
 * pip `Scripts\*.exe` console-script shims when spawned from a non-console
 * parent. Retrying the spawn almost always clears it.
 */
const FLAKY_EXIT = new Set([3221225794, 3221225781, 3221225595]);

function isTransientSpawn(err: unknown, binaryExists: boolean): boolean {
  const e = err as NodeJS.ErrnoException & { message?: string };
  if (binaryExists && e.code === "ENOENT") return true; // shim vanished for a beat
  if (e.code === "EBUSY" || e.code === "ETXTBSY" || e.code === "EAGAIN") return true;
  const m = /exited (\d+)/.exec(e.message ?? "");
  return m ? FLAKY_EXIT.has(Number(m[1])) : false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WhisperLocalProvider implements TranscriptionProvider {
  readonly name = "whisper-local";

  private readonly opts: WhisperLocalOptions;

  constructor(opts: WhisperLocalOptions) {
    this.opts = opts;
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<TranscriptResult> {
    const outDir = await mkdtemp(join(this.opts.tempDir ?? tmpdir(), "whisper-"));
    const args = [
      audioPath,
      "--model",
      this.opts.model,
      "--output_format",
      "json",
      "--output_dir",
      outDir,
      "--word_timestamps",
      "True",
      // Accuracy-leaning defaults:
      //  - fp16 False: full-precision decode (CPU forces this anyway; explicit
      //    here so it's also true on a GPU box and silences the warning).
      //  - condition_on_previous_text True: carry context across segments so a
      //    long recording stays coherent (this is the default, pinned for clarity).
      "--fp16",
      "False",
      "--condition_on_previous_text",
      "True",
      "--beam_size",
      String(this.opts.beamSize ?? 5),
    ];
    if (options.language) args.push("--language", options.language);
    // Prime the decoder with domain terms it routinely mangles.
    if (options.vocabulary?.length) {
      args.push("--initial_prompt", options.vocabulary.join(", "));
    }

    const binaryExists = existsSync(this.opts.binary);
    const jsonPath = join(outDir, `${basename(audioPath, extname(audioPath))}.json`);
    try {
      // The pip console-script shim on Windows is flaky when spawned from a
      // non-console parent: it either fails to start, or "runs" (exit 0) while
      // the real Python whisper never executes and no JSON is written. Retry
      // both cases a few times before giving up.
      let raw: WhisperJson | null = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          await this.run(args, options);
          if (existsSync(jsonPath)) {
            raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperJson;
            break;
          }
          // ran but produced nothing — treat as transient
          if (attempt === 4 || options.signal?.aborted) {
            throw new Error("whisper produced no output");
          }
        } catch (err) {
          if (attempt === 4 || options.signal?.aborted || !isTransientSpawn(err, binaryExists)) {
            throw err;
          }
        }
        await sleep(attempt * 500);
      }
      if (!raw) throw new Error("whisper produced no output after 4 attempts");
      return parseWhisperJson(raw, this.opts.model);
    } catch (err) {
      if (!binaryExists && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProviderUnavailableError(
          "transcription:whisper-local",
          `the "${this.opts.binary}" binary is not on PATH (set WHISPER_BINARY)`,
        );
      }
      throw err;
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }

  /**
   * Spawn the CLI, streaming its cue lines so `onProgress` can report how far
   * into the audio it has decoded. Rejects with an execFile-shaped error so the
   * ENOENT branch above still works.
   */
  private run(args: string[], options: TranscribeOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Leave a few cores for this process so the job heartbeat keeps firing.
      const cores = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 3);
      const child = spawn(this.opts.binary, args, {
        signal: options.signal,
        env: {
          ...process.env,
          // Python is block-buffered on a pipe; without this its cue lines sit
          // in a buffer until exit and `onProgress` never fires mid-run.
          PYTHONUNBUFFERED: "1",
          // Whisper prints the transcript to stdout. On Windows that's cp1252,
          // so any non-Latin text raises UnicodeEncodeError *inside* whisper and
          // it silently "Skips" the file — no JSON, exit 0. Force UTF-8 so it
          // always finishes and writes its output.
          PYTHONIOENCODING: "utf-8",
          OMP_NUM_THREADS: String(cores),
          MKL_NUM_THREADS: String(cores),
        },
      });
      let stderr = "";
      let last = 0;

      const scan = (buf: string): string => {
        const lines = buf.split("\n");
        const rest = lines.pop() ?? "";
        // Any output at all is a sign of life — keep the lease alive.
        if (lines.length) options.onActivity?.();
        if (!options.onProgress || !options.durationMs) return rest;
        for (const line of lines) {
          const endMs = parseWhisperCueEndMs(line);
          if (endMs === null) continue;
          const f = Math.min(1, endMs / options.durationMs);
          if (f > last + 0.005) {
            last = f;
            options.onProgress(f);
          }
        }
        return rest;
      };
      let outPending = "";
      let errPending = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (outPending = scan(outPending + c)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        errPending = scan(errPending + c);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve();
        const tail = stderr.split("\n").filter(Boolean).slice(-3).join("\n").trim();
        reject(new Error(`whisper exited ${code}${tail ? `:\n${tail}` : ""}`));
      });
    });
  }
}

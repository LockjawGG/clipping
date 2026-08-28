import { spawn } from "node:child_process";
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
    ];
    if (options.language) args.push("--language", options.language);

    try {
      await this.run(args, options);
      const jsonPath = join(outDir, `${basename(audioPath, extname(audioPath))}.json`);
      const raw = JSON.parse(await readFile(jsonPath, "utf8")) as WhisperJson;
      return parseWhisperJson(raw, this.opts.model);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
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

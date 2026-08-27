import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

import {
  ProviderUnavailableError,
  type Segment,
  type TranscribeOptions,
  type TranscriptionProvider,
  type TranscriptResult,
  type Word,
} from "../providers/types.ts";
import { clamp01, meanConfidence, normalizeLanguage, secToMs } from "./normalize.ts";

const run = promisify(execFile);

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
      await run(this.opts.binary, args, { signal: options.signal, maxBuffer: 32 * 1024 * 1024 });
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
}

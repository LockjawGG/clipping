import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProviderUnavailableError, type TranscriptionProvider } from "../providers/types.ts";
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

/** Special markers whisper.cpp emits inline, e.g. `[_BEG_]`. Not text. */
function isSpecial(text: string): boolean {
  return /^\[_.*_\]$/.test(text.trim());
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
    const words = wordsFromTokens(s.tokens ?? []);
    const startMs = s.offsets?.from ?? words[0]?.startMs ?? 0;
    const endMs = Math.max(startMs, s.offsets?.to ?? words[words.length - 1]?.endMs ?? startMs);
    const text = (s.text ?? words.map((w) => w.text).join(" ")).trim();
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
      const args = [
        "-m", this.opts.model,
        "-f", audioPath,
        // Detect rather than assume English — see the note at the top.
        "-l", options.language ?? "auto",
        // Without this a clip with music comes back as "[MUSIC]" and nothing else.
        "--suppress-nst",
        "-ojf",
        "-of", outBase,
        "-bs", String(this.opts.beamSize ?? 5),
        "--no-prints",
      ];
      if (options.task === "translate") args.push("-tr");
      if (options.vocabulary?.length) args.push("--prompt", options.vocabulary.join(", "));

      await this.run(args, options);
      const json = JSON.parse(await fs.readFile(`${outBase}.json`, "utf8")) as CppJson;
      return parseWhisperCppJson(json, path.basename(this.opts.model));
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(args: string[], options: TranscribeOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Leave a few cores for this process so the job heartbeat keeps firing,
      // matching what the other local engines reserve.
      const cores = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 3);
      const child = spawn(this.opts.binary, [...args, "-t", String(cores)], {
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
              `whisper-cli not found at "${this.opts.binary}" — set WHISPER_CPP_BINARY`,
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

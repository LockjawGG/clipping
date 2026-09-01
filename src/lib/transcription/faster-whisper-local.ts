import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { ProviderUnavailableError, type TranscriptionProvider } from "../providers/types.ts";
import { beamSizeFor } from "../api/settings.ts";
import type { TranscribeOptions, TranscriptResult } from "../providers/types.ts";
import { parseWhisperJson } from "./whisper-local.ts";

/**
 * Whisper via faster-whisper (CTranslate2) instead of the reference PyTorch CLI.
 *
 * Same weights, same decoding parameters, a different runtime. On the CPU-only
 * setup this project runs on it is about twice as fast per job, and on the
 * clips it was checked against it produced the reference engine's output
 * character for character.
 *
 * It emits its JSON in one go at the end rather than streaming cue lines, so
 * unlike the CLI provider there is no per-cue progress to report — only that it
 * is still alive. Long jobs therefore sit at whatever fraction the caller set
 * before this ran, which is why `onActivity` is still pinged: the worker's
 * lease has to keep renewing even when the number on screen does not move.
 */
export interface FasterWhisperOptions {
  /** Python interpreter to run the helper with. */
  python: string;
  /** Model id or local path, e.g. `small`, `large-v3`. */
  model: string;
  beamSize?: number;
  /**
   * CTranslate2 compute type. `float32` unless you have measured otherwise —
   * the int8 variants are meaningfully faster and produce wrong transcripts,
   * substituting or repeating whole phrases.
   */
  computeType?: string;
}

/** Absolute path to the helper, which ships beside the app's other scripts. */
function helperScript(): string {
  return path.resolve(process.cwd(), "scripts", "faster_whisper_transcribe.py");
}

export class FasterWhisperLocalProvider implements TranscriptionProvider {
  readonly name = "faster-whisper-local";

  private readonly opts: FasterWhisperOptions;

  constructor(opts: FasterWhisperOptions) {
    this.opts = opts;
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<TranscriptResult> {
    const request = {
      audio: audioPath,
      model: this.opts.model,
      // Quality "fast" is a greedy pass over the same model - see beamSizeFor.
      beam_size: beamSizeFor(options.quality ?? "accurate", this.opts.beamSize ?? 5),
      compute_type: this.opts.computeType ?? "float32",
      language: options.language ?? null,
      task: options.task ?? "transcribe",
      initial_prompt: options.vocabulary?.length ? options.vocabulary.join(", ") : null,
    };

    const raw = await this.run(JSON.stringify(request), options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderUnavailableError(
        "transcription:faster-whisper-local",
        "the helper produced no JSON — check that `faster-whisper` is installed for PYTHON_BIN",
      );
    }
    // The helper mirrors the CLI's JSON shape, so both engines parse identically.
    return parseWhisperJson(parsed as never, this.opts.model);
  }

  private run(payload: string, options: TranscribeOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      // Leave a few cores for this process so the job heartbeat keeps firing —
      // the same reservation the CLI provider makes.
      const cores = Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 3);
      const child = spawn(this.opts.python, [helperScript(), payload], {
        signal: options.signal,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          // The helper writes UTF-8 bytes to stdout directly, but anything else
          // Python prints (warnings, tracebacks) still goes through the console
          // encoding, which is cp1252 here and raises on non-Latin text.
          PYTHONIOENCODING: "utf-8",
          OMP_NUM_THREADS: String(cores),
          MKL_NUM_THREADS: String(cores),
        },
      });

      const out: Buffer[] = [];
      let stderr = "";
      child.stdout.on("data", (b: Buffer) => {
        out.push(b);
        options.onActivity?.();
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString();
        // Model loading and decoding both report here. No cue timings to read a
        // fraction from, but it is proof the job has not wedged.
        options.onActivity?.();
      });

      child.on("error", (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          reject(
            new ProviderUnavailableError(
              "transcription:faster-whisper-local",
              `python not found at "${this.opts.python}" — set PYTHON_BIN`,
            ),
          );
          return;
        }
        reject(err);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString("utf-8"));
          return;
        }
        if (/ModuleNotFoundError.*faster_whisper|No module named ['"]faster_whisper/.test(stderr)) {
          reject(
            new ProviderUnavailableError(
              "transcription:faster-whisper-local",
              "install it with `pip install faster-whisper`",
            ),
          );
          return;
        }
        reject(new Error(`faster-whisper exited ${code}: ${stderr.trim().slice(-400)}`));
      });
    });
  }
}

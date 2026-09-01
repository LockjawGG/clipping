import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { executableExists } from "../providers/executable.ts";
import { ProviderUnavailableError } from "../providers/types.ts";
import { stripLoneSurrogates } from "../text.ts";
import type { SynthesisResult, SynthesizeOptions, TtsProvider, TtsVoice } from "./types.ts";

/**
 * Piper: local, offline, multilingual neural TTS driven as a CLI binary.
 *
 * Chosen for exactly the reasons `whisper-local` was: it runs on the machine
 * the renders already run on, it needs no key, and the integration is the same
 * "point an env var at a binary" story the project already tells. Cloud voices
 * sit behind the same `TtsProvider` interface when quality matters more than
 * privacy.
 *
 * A Piper voice is a pair of files — `<name>.onnx` and `<name>.onnx.json`. The
 * model directory is scanned for those, so adding a language is dropping two
 * files in a folder rather than a code change.
 */

export interface PiperOptions {
  /** Path to the piper executable. */
  binary: string;
  /** Directory holding `*.onnx` voice models. */
  voiceDir: string;
  /** Voice used when none is requested. */
  defaultVoiceId?: string;
}

/** `en_US-amy-medium.onnx` -> { id, language, label }. */
export function parseVoiceFile(file: string): TtsVoice | null {
  if (!file.endsWith(".onnx")) return null;
  const id = basename(file, ".onnx");
  // Piper names models `<lang>_<REGION>-<voice>-<quality>`.
  const m = /^([a-z]{2})(?:_([A-Z]{2}))?-(.+?)(?:-(low|medium|high|x_low))?$/.exec(id);
  if (!m) return { id, label: id, language: "en" };
  const [, lang, region, name, quality] = m;
  return {
    id,
    language: region ? `${lang}-${region}` : lang,
    label: quality ? `${name} (${quality})` : name,
  };
}

/** The sample rate from a RIFF/WAVE header, falling back to Piper's default. */
export async function readWavSampleRate(path: string, fallback = 22_050): Promise<number> {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(44), 0, 44, 0);
    if (bytesRead < 28 || buffer.toString("ascii", 0, 4) !== "RIFF") return fallback;
    const rate = buffer.readUInt32LE(24);
    return rate > 0 ? rate : fallback;
  } catch {
    return fallback;
  } finally {
    await handle.close();
  }
}

/** WAV byte length -> ms. Piper writes 16-bit mono at the model's rate. */
export function wavDurationMs(bytes: number, sampleRate: number, channels = 1): number {
  const bytesPerSample = 2;
  const frames = Math.max(0, bytes - 44) / (bytesPerSample * Math.max(1, channels));
  return Math.round((frames / Math.max(1, sampleRate)) * 1000);
}

export class PiperTtsProvider implements TtsProvider {
  readonly name = "piper-local";
  private readonly opts: PiperOptions;

  constructor(opts: PiperOptions) {
    this.opts = opts;
  }

  /** Throws with an actionable hint when the binary or models are missing. */
  private assertAvailable(): void {
    if (!executableExists(this.opts.binary)) {
      throw new ProviderUnavailableError(
        "tts:piper-local",
        `piper binary "${this.opts.binary}" not found on PATH or at that path — install Piper, or set PIPER_BINARY to its location`,
      );
    }
    if (!existsSync(this.opts.voiceDir)) {
      throw new ProviderUnavailableError(
        "tts:piper-local",
        `no voice models at "${this.opts.voiceDir}" — download a Piper voice and set PIPER_VOICE_DIR`,
      );
    }
  }

  /**
   * Listing voices asserts availability first. "I cannot run at all" and "I run
   * but have no models installed" are different problems with different fixes,
   * and collapsing the first into an empty list made the UI offer a Generate
   * button that could only fail once pressed.
   */
  async voices(): Promise<TtsVoice[]> {
    this.assertAvailable();
    return readdirSync(this.opts.voiceDir)
      .map(parseVoiceFile)
      .filter((v): v is TtsVoice => v !== null)
      .sort((a, b) => a.language.localeCompare(b.language) || a.label.localeCompare(b.label));
  }

  async synthesize(
    text: string,
    outputPath: string,
    options: SynthesizeOptions = {},
  ): Promise<SynthesisResult> {
    this.assertAvailable();

    // Lone UTF-16 surrogates (seen in engine-emitted transcripts) crash the
    // UTF-8 encode inside Piper; strip them rather than fail the narration.
    const clean = stripLoneSurrogates(text).trim();
    if (!clean) throw new Error("nothing to synthesize");

    const available = await this.voices();
    const voiceId =
      options.voiceId ??
      this.opts.defaultVoiceId ??
      // Prefer a voice in the requested language, else whatever is installed.
      available.find((v) => options.language && v.language.startsWith(options.language))?.id ??
      available[0]?.id;
    if (!voiceId) {
      throw new ProviderUnavailableError(
        "tts:piper-local",
        `no voice models in "${this.opts.voiceDir}"`,
      );
    }

    const model = join(this.opts.voiceDir, `${voiceId}.onnx`);
    if (!existsSync(model)) {
      throw new ProviderUnavailableError("tts:piper-local", `voice "${voiceId}" is not installed`);
    }

    await mkdir(dirname(outputPath), { recursive: true });

    const args = ["--model", model, "--output_file", outputPath];
    // Piper expresses speed as seconds-per-phoneme, so it is the reciprocal of
    // a rate: 2x faster is a length scale of 0.5.
    if (options.speed && options.speed !== 1) {
      args.push("--length_scale", String(1 / Math.max(0.5, Math.min(2, options.speed))));
    }
    // Piper pads every utterance with a sentence-final pause. Harmless for a
    // whole line, but a line assembled from parts would inherit one at each
    // join and run visibly longer than the same words read in one go.
    if (options.sentenceSilenceSec !== undefined) {
      args.push("--sentence_silence", String(Math.max(0, options.sentenceSilenceSec)));
    }

    await this.run(args, clean, options.signal);

    const info = await stat(outputPath).catch(() => null);
    if (!info || info.size <= 44) {
      throw new Error("piper produced no audio");
    }
    // Read the rate out of the header rather than assuming Piper's 22.05 kHz
    // default: it varies by voice model, and a caller splicing audio into this
    // line needs the real one or the join resamples.
    const sampleRate = await readWavSampleRate(outputPath);
    return {
      audioPath: outputPath,
      durationMs: wavDurationMs(info.size, sampleRate),
      sampleRate,
      provider: this.name,
      voiceId,
    };
  }

  private run(args: string[], input: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.binary, args, {
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...process.env,
          // The pip-installed piper is Python, and on Windows it decodes stdin
          // with the console codepage (cp1252). Korean UTF-8 bytes then arrive
          // as surrogate-escaped garbage and eSpeak dies re-encoding them --
          // "surrogates not allowed" on byte 0x9D. Pin the pipe to UTF-8; the
          // standalone C++ piper ignores both variables.
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
        },
      });
      let stderr = "";

      const onAbort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr?.on("data", (d: Buffer) => {
        // Keep the tail only; Piper is chatty about model loading.
        stderr = (stderr + d.toString()).slice(-2000);
      });
      child.on("error", (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(
          new ProviderUnavailableError(
            "tts:piper-local",
            `could not run "${this.opts.binary}": ${err.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (code === 0) resolve();
        else reject(new Error(`piper exited ${code}: ${stderr.trim()}`));
      });

      child.stdin?.end(input, "utf8");
    });
  }
}

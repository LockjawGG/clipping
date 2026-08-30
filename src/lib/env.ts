import { z } from "zod";

/**
 * Runtime configuration, parsed once from `process.env`.
 *
 * Provider-specific secrets (S3 keys, API keys) are intentionally optional here.
 * Whether a given provider is usable is decided when it is constructed, which is
 * where `ProviderUnavailableError` is thrown with an actionable hint. This schema
 * only enforces the values the app cannot start without.
 *
 * Set `SKIP_ENV_VALIDATION=1` to bypass parsing (used during `next build`, which
 * never connects to anything).
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),

  NEXTAUTH_SECRET: z.string().min(1).optional(),
  NEXTAUTH_URL: z.string().url().default("http://localhost:3000"),

  STORAGE_PROVIDER: z.enum(["s3", "local"]).default("local"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOCAL_STORAGE_DIR: z.string().default("./.storage"),

  TRANSCRIPTION_PROVIDER: z
    .enum(["whisper-local", "openai", "deepgram"])
    .default("whisper-local"),
  WHISPER_BINARY: z.string().default("whisper"),
  // Python used to run scripts/translate.py (Argos Translate, fully offline).
  PYTHON_BIN: z.string().default("python"),
  // Accuracy ladder (CPU speed drops roughly 2x per rung):
  //   base(.en) « small(.en) « medium(.en) « large-v3
  // Use the ".en" variant for English-only recordings — more accurate at a
  // given size. large-v3 is multilingual only.
  WHISPER_MODEL: z.string().default("large-v3"),
  /** Whisper beam-search width. Higher = more accurate + slower. CLI default 5. */
  WHISPER_BEAM_SIZE: z.coerce.number().int().min(1).max(10).default(5),
  /**
   * Force a transcription language for live recordings (ISO code, e.g. "es").
   * Empty (the default) auto-detects: the finalize pass sees the whole
   * recording so detection is reliable, and any language is transcribed.
   */
  LIVE_LANGUAGE: z.string().default(""),
  // Text-to-speech for voiceovers. Local-first by default: Piper is a CLI
  // binary with offline multilingual voices, the same integration shape as
  // WHISPER_BINARY.
  TTS_PROVIDER: z.enum(["piper-local"]).default("piper-local"),
  PIPER_BINARY: z.string().default("piper"),
  /** Directory of `*.onnx` Piper voice models. */
  PIPER_VOICE_DIR: z.string().default("./.voices"),
  /** Voice id used when a request does not name one. */
  PIPER_VOICE: z.string().default(""),

  OPENAI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),

  ANALYSIS_PROVIDER: z
    .enum(["anthropic", "openai", "heuristic"])
    .default("heuristic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Interpreted by whichever ANALYSIS_PROVIDER is active — a Claude id for
  // "anthropic", a GPT id for "openai", ignored by "heuristic".
  ANALYSIS_MODEL: z.string().default("claude-opus-5"),

  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  // Browser fingerprint yt-dlp impersonates (`--impersonate`). Needed for
  // Rumble and other Cloudflare-fronted hosts. "" disables it.
  YTDLP_IMPERSONATE: z.string().default("chrome"),
  TEMP_DIR: z.string().default("/tmp/clipper"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

function load(): Env {
  if (process.env.SKIP_ENV_VALIDATION) {
    return process.env as unknown as Env;
  }
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Lazily-validated environment. Throws on first access if config is invalid. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    cached ??= load();
    return cached[prop as keyof Env];
  },
});

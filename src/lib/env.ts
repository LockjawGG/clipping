import { z } from "zod";

import { assertBetaIsolation, betaRoots } from "./beta-guard.ts";

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
  /**
   * Run without accounts, as a single local user.
   *
   * The desktop build sets this. It is a personal application whose data sits
   * on the machine it runs on, reachable only over loopback — a sign-in screen
   * there guards nothing and is pure friction. Everything still hangs off a
   * User row so ownership checks, projects and the schema are unchanged; the
   * app just stops asking who you are.
   *
   * It genuinely disables authentication, so it must never be set on anything
   * reachable from a network. Nothing sets it but the desktop shell.
   */
  DESKTOP_SINGLE_USER: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
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
    .enum(["whisper-local", "faster-whisper-local", "whisper-cpp", "openai", "deepgram"])
    .default("whisper-local"),
  /**
   * CTranslate2 compute type for `faster-whisper-local`. Leave it at float32:
   * the int8 variants run noticeably faster and get words wrong, replacing or
   * repeating whole phrases rather than degrading gracefully.
   */
  FASTER_WHISPER_COMPUTE_TYPE: z.string().default("float32"),
  WHISPER_BINARY: z.string().default("whisper"),
  /** whisper.cpp: one executable and one model file, for machines without Python. */
  WHISPER_CPP_BINARY: z.string().default("whisper-cli"),
  /**
   * A GPU build of the same whisper-cli, tried ahead of WHISPER_CPP_BINARY.
   *
   * No default: unset means CPU only, which is what a machine without the
   * acceleration pack must keep getting. The GPU path is preferred, never
   * required — the provider falls back to WHISPER_CPP_BINARY when it fails.
   */
  WHISPER_CPP_GPU_BINARY: z.string().optional(),
  WHISPER_CPP_MODEL: z.string().default(""),
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
    .enum(["anthropic", "openai", "heuristic", "ollama"])
    .default("heuristic"),
  /** Local LLM (Ollama) server origin; the assistant and "ollama" analysis use it. */
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434"),
  /** Preferred local model; any installed model is used when this is absent. */
  OLLAMA_MODEL: z.string().default("llama3.2"),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Interpreted by whichever ANALYSIS_PROVIDER is active — a Claude id for
  // "anthropic", a GPT id for "openai", ignored by "heuristic".
  ANALYSIS_MODEL: z.string().default("claude-opus-5"),

  /**
   * Path to a file holding the shared secret for POST /api/telemetry/ingest.
   *
   * Unset — the default — means ingest is off and the route answers 501. That
   * is deliberate: the endpoint exists so an out-of-process orchestrator can
   * relay what its agents are doing onto the Agent Brain page, and a
   * write endpoint is not something an app should carry switched on by
   * default. A file rather than the value itself, so the secret never lands in
   * a process listing or a shell history.
   */
  TELEMETRY_KEY_FILE: z.string().optional(),

  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  // Browser fingerprint yt-dlp impersonates (`--impersonate`). Needed for
  // Rumble and other Cloudflare-fronted hosts. "" disables it.
  /**
   * Most videos ingested from one playlist link. YouTube "Mix" radios are
   * endless and even honest playlists run to hundreds; without a ceiling one
   * pasted link could fill the disk. Entries past the cap are reported, not
   * silently dropped.
   */
  PLAYLIST_MAX: z.coerce.number().int().min(1).max(500).default(100),
  YTDLP_IMPERSONATE: z.string().default("chrome"),
  TEMP_DIR: z.string().default("/tmp/clipper"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** The project root, or null in a runtime that has no filesystem to speak of. */
function checkoutRoot(): string | null {
  if (process.env.NEXT_RUNTIME === "edge") return null;
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function load(): Env {
  if (process.env.SKIP_ENV_VALIDATION) {
    // `next build` sets this: it never connects to anything, and it runs in the
    // production checkout too. Validating there would be checking a config the
    // build does not use.
    return process.env as unknown as Env;
  }
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  // Shape first, then destination. A perfectly valid configuration pointed at
  // the production database is the failure mode that matters on this machine,
  // and it is only detectable once the values have parsed. A no-op unless
  // CLIPPER_BETA=1, so the production checkout is unaffected.
  //
  // Skipped in the Edge runtime, which the auth middleware runs in: there is no
  // `process.cwd()` there (calling it is a hard error), so the roots cannot be
  // derived — and there is nothing to protect either, since Edge code cannot
  // open a database connection or write a file. Every process that *can* do
  // damage — the Node server, the worker, the Electron shell — still checks.
  const root = checkoutRoot();
  if (root) {
    assertBetaIsolation({
      env: process.env,
      ...betaRoots({
        checkoutRoot: root,
        appData: process.env.APPDATA,
        userData: process.env.CLIPPER_USER_DATA,
      }),
      cwd: root,
      packaged: process.env.CLIPPER_PACKAGED === "1",
    });
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

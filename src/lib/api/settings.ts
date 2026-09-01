import { z } from "zod";

/**
 * The Settings tab's data: one JSON row per user.
 *
 * Everything here is a preference with a default, never queried data — which is
 * why it is one JSON column instead of columns per knob. Parsing is lenient on
 * purpose: a settings row written by a newer build must not brick an older one,
 * so unknown keys pass through and bad values fall back to their defaults
 * individually rather than failing the whole object.
 */

export const CAPTION_PRESET_IDS = ["CLASSIC", "BOLD", "VIRAL", "MINIMAL", "KARAOKE"] as const;

const settingsSchema = z.object({
  /**
   * Words the censor must always let through / always catch, seeded into every
   * new clip. The clip's own lists stay editable per clip afterwards — these
   * are the starting point, not a live link.
   */
  censorAllowList: z.array(z.string().min(1).max(60)).max(500).catch([]),
  censorDenyList: z.array(z.string().min(1).max(60)).max(500).catch([]),

  /**
   * accurate = the medium model, fast = small. Both ship with the desktop
   * build; the labels say what they cost rather than pretending it's free.
   */
  transcriptionQuality: z.enum(["accurate", "fast"]).catch("accurate"),
  /** BCP-47-ish code to pin transcription to, or "" for auto-detect. */
  transcriptionLanguage: z.string().max(16).catch(""),

  /** Default voice id for new narrations; "" = the app's own default. */
  voiceId: z.string().max(120).catch(""),
  /** Default duck level for new narrations, dB. -60 is silence. */
  duckDb: z.number().min(-60).max(0).catch(-60),
  /** Default narration speed for new narrations. */
  voiceSpeed: z.number().min(0.5).max(2).catch(1),

  /** Most videos one pasted playlist link may import. */
  playlistMax: z.number().int().min(1).max(500).catch(100),

  /**
   * "How I edit", in the user's own words — the yap-style instruction set.
   * Injected into every AI prompt (clip suggestions and the assistant), so
   * the model edits the way this user edits, not the way the average of the
   * internet edits. Empty means no extra steering.
   */
  styleInstructions: z.string().max(4000).catch(""),

  /** Preferred local assistant model; "" = whatever Ollama has installed. */
  assistantModel: z.string().max(120).catch(""),

  /** Caption template new clips start from. */
  defaultCaptionPreset: z.enum(CAPTION_PRESET_IDS).catch("CLASSIC"),

  /** Aspect ratio new clips start from. */
  defaultAspectRatio: z
    .enum(["VERTICAL_9_16", "SQUARE_1_1", "LANDSCAPE_16_9", "PORTRAIT_4_5"])
    .catch("VERTICAL_9_16"),
});

export type UserSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: UserSettings = settingsSchema.parse({});

/** Lenient parse: bad or missing fields fall back individually. */
export function parseSettings(json: string | null | undefined): UserSettings {
  if (!json) return { ...DEFAULT_SETTINGS };
  try {
    return settingsSchema.parse(JSON.parse(json));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Validate a client-sent patch; unknown keys are dropped, bad values rejected. */
export const updateSettingsSchema = settingsSchema.partial().strict();

export interface SettingsDb {
  userSettings: {
    findUnique(args: { where: { userId: string } }): Promise<{ json: string } | null>;
    upsert(args: {
      where: { userId: string };
      create: { userId: string; json: string };
      update: { json: string };
    }): Promise<unknown>;
  };
}

export async function getSettings(db: SettingsDb, userId: string): Promise<UserSettings> {
  const row = await db.userSettings.findUnique({ where: { userId } });
  return parseSettings(row?.json);
}

/**
 * Concurrent PUTs are the Settings tab's normal behavior — each control saves
 * itself, so two quick changes are two overlapping read-modify-writes, and the
 * later read erases the earlier write. One server process serves each user
 * (dev and desktop alike), so a per-user promise chain is a sufficient lock.
 */
const updateLocks = new Map<string, Promise<unknown>>();

export async function updateSettings(
  db: SettingsDb,
  userId: string,
  input: unknown,
): Promise<UserSettings> {
  // Validate before queueing: bad input rejects immediately, never holds the lock.
  const patch = updateSettingsSchema.parse(input);
  const prev = updateLocks.get(userId) ?? Promise.resolve();
  const task = prev
    .catch(() => {}) // an earlier failed write must not poison the queue
    .then(async () => {
      const current = await getSettings(db, userId);
      const next = { ...current, ...patch };
      await db.userSettings.upsert({
        where: { userId },
        create: { userId, json: JSON.stringify(next) },
        update: { json: JSON.stringify(next) },
      });
      return next;
    });
  updateLocks.set(userId, task);
  try {
    return await task;
  } finally {
    if (updateLocks.get(userId) === task) updateLocks.delete(userId);
  }
}

/**
 * What a new clip's censor lists start as.
 *
 * Seeded at creation rather than read live: a clip keeps behaving the way it
 * was reviewed even if the global lists change later, and the per-clip editors
 * keep working on plain columns exactly as before.
 */
export function censorSeed(s: UserSettings): { censorAllowList: string[]; censorDenyList: string[] } {
  return {
    censorAllowList: [...s.censorAllowList],
    censorDenyList: [...s.censorDenyList],
  };
}

/**
 * Decode beam width for a quality choice.
 *
 * "fast" is greedy decoding of the *same* model, not a smaller model: a second
 * model file cannot ship (the packaged exe already sits at the installer
 * format's 2GB ceiling with one), and a greedy pass on the accurate model
 * measured ~25% quicker with near-identical text — differences were at the
 * punctuation level. One knob, every engine, no dev/desktop divergence.
 */
export function beamSizeFor(quality: "accurate" | "fast", accurateBeam = 5): number {
  return quality === "fast" ? 1 : accurateBeam;
}

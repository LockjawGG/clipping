import { z } from "zod";

import { ApiError } from "./http.ts";

/**
 * Per-word caption styling — the fourth layer, kept deliberately separate from:
 *   1. the raw transcript (TranscriptWord: text + timing),
 *   2. the per-clip base style (SubtitleConfig),
 *   3. the visual render.
 *
 * A `CaptionWordStyle` row overrides the base style for ONE transcript word on
 * ONE clip. Keyed by word id, so correcting a word's spelling keeps its styling;
 * regenerating the transcript changes the ids and the overrides cascade away.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The style attributes a single word can carry. `null` clears that attribute. */
export const wordStyleSchema = z
  .object({
    color: z.string().regex(HEX, "expected #RRGGBB").nullable(),
    bold: z.boolean().nullable(),
    italic: z.boolean().nullable(),
    sizeScale: z.number().min(0.3).max(4).nullable(),
  })
  .partial();

export type WordStylePatch = z.infer<typeof wordStyleSchema>;

export const applyWordStylesSchema = z.object({
  wordIds: z.array(z.string().min(1)).min(1).max(500),
  style: wordStyleSchema,
});

export interface WordStyle {
  color: string | null;
  bold: boolean | null;
  italic: boolean | null;
  sizeScale: number | null;
}

interface StyleRow {
  id: string;
  clipId: string;
  wordId: string;
  color: string | null;
  bold: boolean | null;
  italic: boolean | null;
  sizeScale: number | null;
}

interface ClipLite {
  id: string;
  video: { projectId: string };
}

export interface CaptionStyleDb {
  clip: {
    findUnique(args: { where: { id: string }; select?: unknown }): Promise<ClipLite | null>;
  };
  captionWordStyle: {
    findMany(args: { where: { clipId: string } }): Promise<StyleRow[]>;
    findUnique(args: {
      where: { clipId_wordId: { clipId: string; wordId: string } };
    }): Promise<StyleRow | null>;
    upsert(args: {
      where: { clipId_wordId: { clipId: string; wordId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<StyleRow>;
    deleteMany(args: { where: { clipId: string; wordId?: { in: string[] } } }): Promise<unknown>;
  };
}

export interface CaptionStyleServiceDeps {
  db: CaptionStyleDb;
  assertProjectOwned: (projectId: string) => Promise<void>;
}

const ATTRS = ["color", "bold", "italic", "sizeScale"] as const;

async function ownedClip(deps: CaptionStyleServiceDeps, clipId: string): Promise<void> {
  const clip = await deps.db.clip.findUnique({
    where: { id: clipId },
    select: { id: true, video: { select: { projectId: true } } },
  });
  if (!clip) throw new ApiError(404, "clip not found");
  await deps.assertProjectOwned(clip.video.projectId);
}

function toStyle(row: StyleRow): WordStyle {
  return { color: row.color, bold: row.bold, italic: row.italic, sizeScale: row.sizeScale };
}

/** Non-empty means at least one attribute is set. */
function hasAny(s: WordStyle): boolean {
  return s.color !== null || s.bold !== null || s.italic !== null || s.sizeScale !== null;
}

export async function listClipWordStyles(
  deps: CaptionStyleServiceDeps,
  clipId: string,
): Promise<Record<string, WordStyle>> {
  await ownedClip(deps, clipId);
  const rows = await deps.db.captionWordStyle.findMany({ where: { clipId } });
  const out: Record<string, WordStyle> = {};
  for (const r of rows) out[r.wordId] = toStyle(r);
  return out;
}

/**
 * Merge `style` onto every word in `wordIds`. An attribute set to `null` is
 * removed; an attribute left `undefined` is untouched. A word whose row ends up
 * with no attributes is deleted.
 */
export async function applyWordStyles(
  deps: CaptionStyleServiceDeps,
  clipId: string,
  input: unknown,
): Promise<Record<string, WordStyle>> {
  const { wordIds, style } = applyWordStylesSchema.parse(input);
  await ownedClip(deps, clipId);

  const clearIds: string[] = [];
  for (const wordId of [...new Set(wordIds)]) {
    const existing = await deps.db.captionWordStyle.findUnique({
      where: { clipId_wordId: { clipId, wordId } },
    });
    const merged: WordStyle = {
      color: style.color !== undefined ? style.color : (existing?.color ?? null),
      bold: style.bold !== undefined ? style.bold : (existing?.bold ?? null),
      italic: style.italic !== undefined ? style.italic : (existing?.italic ?? null),
      sizeScale: style.sizeScale !== undefined ? style.sizeScale : (existing?.sizeScale ?? null),
    };
    if (!hasAny(merged)) {
      clearIds.push(wordId);
      continue;
    }
    await deps.db.captionWordStyle.upsert({
      where: { clipId_wordId: { clipId, wordId } },
      create: { clipId, wordId, ...merged },
      update: { ...merged },
    });
  }
  if (clearIds.length) {
    await deps.db.captionWordStyle.deleteMany({ where: { clipId, wordId: { in: clearIds } } });
  }
  return listClipWordStyles(deps, clipId);
}

/** Remove styling for the given words, or all of the clip's words when omitted. */
export async function clearClipWordStyles(
  deps: CaptionStyleServiceDeps,
  clipId: string,
  wordIds?: string[],
): Promise<Record<string, WordStyle>> {
  await ownedClip(deps, clipId);
  await deps.db.captionWordStyle.deleteMany({
    where: wordIds?.length ? { clipId, wordId: { in: wordIds } } : { clipId },
  });
  return listClipWordStyles(deps, clipId);
}

/** Whether every attribute of a patch is `null` (i.e. "reset these words"). */
export function isResetPatch(style: WordStylePatch): boolean {
  return ATTRS.every((k) => style[k] === undefined || style[k] === null);
}

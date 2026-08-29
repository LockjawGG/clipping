import { z } from "zod";

import { ApiError } from "./http.ts";

/**
 * A user's saved Text & Captions styles ("Mine" in the template browser).
 * `style` is a JSON partial TextStyle; `wordRules` a JSON WordRule[]. Kept
 * opaque here — the editor parses them.
 */

export const TEXT_PRESET_KINDS = ["caption", "text"] as const;
export type TextPresetKind = (typeof TEXT_PRESET_KINDS)[number];

export const createTextPresetSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(TEXT_PRESET_KINDS).default("caption"),
  style: z.string().min(2).max(20000),
  animation: z.string().max(40).default("NONE"),
  wordRules: z.string().max(8000).nullable().optional(),
});

interface PresetRow {
  id: string;
  name: string;
  kind: string;
  style: string;
  animation: string;
  wordRules: string | null;
  createdAt: Date;
}

export interface TextPresetDb {
  textPreset: {
    findMany(args: {
      where: { userId: string; kind?: string };
      orderBy?: unknown;
    }): Promise<PresetRow[]>;
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; userId: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<PresetRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

export interface TextPresetServiceDeps {
  db: TextPresetDb;
  userId: string;
}

function toView(r: PresetRow) {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    style: r.style,
    animation: r.animation,
    wordRules: r.wordRules,
    createdAt: r.createdAt,
  };
}

export type TextPresetView = ReturnType<typeof toView>;

export async function listTextPresets(
  deps: TextPresetServiceDeps,
  kind?: string,
): Promise<TextPresetView[]> {
  const where: { userId: string; kind?: string } = { userId: deps.userId };
  if (kind && (TEXT_PRESET_KINDS as readonly string[]).includes(kind)) where.kind = kind;
  const rows = await deps.db.textPreset.findMany({ where, orderBy: { createdAt: "desc" } });
  return rows.map(toView);
}

export async function createTextPreset(
  deps: TextPresetServiceDeps,
  input: unknown,
): Promise<TextPresetView> {
  const parsed = createTextPresetSchema.parse(input);
  // reject a style blob that is not a JSON object
  try {
    const obj = JSON.parse(parsed.style);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
  } catch {
    throw new ApiError(422, "style must be a JSON object");
  }
  const row = await deps.db.textPreset.create({
    data: {
      userId: deps.userId,
      name: parsed.name,
      kind: parsed.kind,
      style: parsed.style,
      animation: parsed.animation,
      wordRules: parsed.wordRules ?? null,
    },
  });
  return toView(row);
}

export async function deleteTextPreset(deps: TextPresetServiceDeps, id: string) {
  const row = await deps.db.textPreset.findUnique({ where: { id } });
  if (!row || row.userId !== deps.userId) throw new ApiError(404, "not found");
  await deps.db.textPreset.delete({ where: { id } });
  return { id, deleted: true };
}

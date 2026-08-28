import { z } from "zod";

import { readJson, route } from "@/lib/api/http.ts";
import { captionStyleService } from "@/lib/api/service.ts";
import {
  applyWordStyles,
  clearClipWordStyles,
  listClipWordStyles,
} from "@/lib/api/caption-styles.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clips/:id/word-styles — { [wordId]: WordStyle } for the clip. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await listClipWordStyles(captionStyleService(userId), id));
});

/** PUT /api/clips/:id/word-styles — merge a style patch onto the given words. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await applyWordStyles(captionStyleService(userId), id, await readJson(req)));
});

const clearSchema = z.object({ wordIds: z.array(z.string().min(1)).optional() });

/** DELETE /api/clips/:id/word-styles — reset styling (all words, or `wordIds`). */
export const DELETE = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const { wordIds } = clearSchema.parse(await readJson(req).catch(() => ({})));
  return Response.json(await clearClipWordStyles(captionStyleService(userId), id, wordIds));
});

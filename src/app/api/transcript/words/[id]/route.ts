import { readJson, route } from "@/lib/api/http.ts";
import { transcriptService } from "@/lib/api/service.ts";
import { updateWord } from "@/lib/api/transcript.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/transcript/words/:id — fix one word's text (timings untouched). */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await updateWord(transcriptService(userId), id, await readJson(req)));
});

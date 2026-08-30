import { route } from "@/lib/api/http.ts";
import { voiceoverService } from "@/lib/api/service.ts";
import { deleteVoiceover, getVoiceover, upsertVoiceover } from "@/lib/api/voiceover.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/clips/:id/voiceover — current settings and synthesis status. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await getVoiceover(voiceoverService(userId), id));
});

/** PUT /api/clips/:id/voiceover — save settings and queue synthesis. */
export const PUT = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  return Response.json(await upsertVoiceover(voiceoverService(userId), id, body), { status: 202 });
});

/** DELETE /api/clips/:id/voiceover — remove the narration. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteVoiceover(voiceoverService(userId), id));
});

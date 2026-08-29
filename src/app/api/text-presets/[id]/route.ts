import { route } from "@/lib/api/http.ts";
import { textPresetService } from "@/lib/api/service.ts";
import { deleteTextPreset } from "@/lib/api/text-presets.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/text-presets/:id — remove a saved style. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  return Response.json(await deleteTextPreset(textPresetService(userId), id));
});

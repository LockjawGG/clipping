import { readJson, route } from "@/lib/api/http.ts";
import { textPresetService } from "@/lib/api/service.ts";
import { createTextPreset, listTextPresets } from "@/lib/api/text-presets.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/text-presets?kind=caption — the user's saved styles. */
export const GET = route(async (req: Request) => {
  const userId = await requireUserId();
  const kind = new URL(req.url).searchParams.get("kind") ?? undefined;
  return Response.json(await listTextPresets(textPresetService(userId), kind));
});

/** POST /api/text-presets — save the current style. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json(await createTextPreset(textPresetService(userId), await readJson(req)), {
    status: 201,
  });
});

import { readJson, route } from "@/lib/api/http.ts";
import { getSettings, updateSettings } from "@/lib/api/settings.ts";
import { db } from "@/lib/db.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/settings — the user's Settings-tab values, defaults filled in. */
export const GET = route(async () => {
  const userId = await requireUserId();
  return Response.json(await getSettings(db, userId));
});

/** PUT /api/settings — patch any subset; returns the full result. */
export const PUT = route(async (req: Request) => {
  const userId = await requireUserId();
  return Response.json(await updateSettings(db, userId, await readJson(req)));
});

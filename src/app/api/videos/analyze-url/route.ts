import { readJson, route } from "@/lib/api/http.ts";
import { mediaProbe } from "@/lib/api/service.ts";
import { analyzeUrl } from "@/lib/api/media.ts";
import { getSettings } from "@/lib/api/settings.ts";
import { db } from "@/lib/db.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/videos/analyze-url { url } — preview a link before ingesting it.
 *  Creates nothing. Returns `{ ok:true, … }` or `{ ok:false, kind, message }`. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const prefs = await getSettings(db, userId);
  return Response.json(await analyzeUrl(mediaProbe(), await readJson(req), prefs.playlistMax));
});

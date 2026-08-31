import { readJson, route } from "@/lib/api/http.ts";
import { mediaProbe } from "@/lib/api/service.ts";
import { analyzeUrl } from "@/lib/api/media.ts";
import { env } from "@/lib/env.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/videos/analyze-url { url } — preview a link before ingesting it.
 *  Creates nothing. Returns `{ ok:true, … }` or `{ ok:false, kind, message }`. */
export const POST = route(async (req: Request) => {
  await requireUserId();
  return Response.json(await analyzeUrl(mediaProbe(), await readJson(req), env.PLAYLIST_MAX));
});

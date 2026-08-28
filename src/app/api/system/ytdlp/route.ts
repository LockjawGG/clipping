import { route } from "@/lib/api/http.ts";
import { mediaProbe } from "@/lib/api/service.ts";
import { ytdlpInfo } from "@/lib/api/media.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/system/ytdlp — installed downloader version + update command. */
export const GET = route(async () => {
  await requireUserId();
  return Response.json(await ytdlpInfo(mediaProbe()));
});

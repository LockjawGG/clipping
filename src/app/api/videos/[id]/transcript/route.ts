import { ApiError, route } from "@/lib/api/http.ts";
import { transcriptService } from "@/lib/api/service.ts";
import {
  exportTranscript,
  TRANSCRIPT_FORMATS,
  type TranscriptFormat,
} from "@/lib/api/transcript.ts";
import { requireUserId } from "@/lib/auth/session.ts";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/videos/:id/transcript?format=srt|vtt|txt&lang=  — download the transcript. */
export const GET = route<Ctx>(async (req, { params }) => {
  const userId = await requireUserId();
  const { id } = await params;
  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "srt") as TranscriptFormat;
  if (!TRANSCRIPT_FORMATS.includes(format)) throw new ApiError(400, "format must be srt, vtt or txt");
  const lang = url.searchParams.get("lang") ?? "";

  const { filename, contentType, body } = await exportTranscript(transcriptService(userId), id, {
    format,
    lang,
  });
  return new Response(body, {
    headers: {
      "content-type": `${contentType}; charset=utf-8`,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});

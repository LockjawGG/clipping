import { z } from "zod";

import { FetchError, type FetchErrorKind, type MediaProbe } from "../pipeline/fetcher.ts";

/**
 * URL analyze / downloader-info for the "add from link" flow. These never touch
 * the database — analyzing a link creates nothing. The actual ingest still goes
 * through `createVideoFromUrl` afterwards, unchanged.
 */

export const analyzeUrlSchema = z.object({ url: z.string().trim().url() });

export type AnalyzeResult =
  | {
      ok: true;
      title: string | null;
      durationSec: number | null;
      thumbnail: string | null;
      source: string | null;
      hasVideo: boolean;
      hasAudio: boolean;
      approxBytes: number | null;
      isLive: boolean;
    }
  | { ok: false; kind: FetchErrorKind; message: string; technical: string };

/** Probe a URL and return a preview shape, or a classified reason it can't be used. */
export async function analyzeUrl(probe: MediaProbe, input: unknown): Promise<AnalyzeResult> {
  const { url } = analyzeUrlSchema.parse(input);
  try {
    const p = await probe.probe(url);
    return {
      ok: true,
      title: p.title ?? null,
      durationSec: p.durationSec ?? null,
      thumbnail: p.thumbnail ?? null,
      source: p.source ?? null,
      hasVideo: p.hasVideo,
      hasAudio: p.hasAudio,
      approxBytes: p.approxBytes ?? null,
      isLive: p.isLive,
    };
  } catch (e) {
    if (e instanceof FetchError) {
      return { ok: false, kind: e.kind, message: e.message, technical: e.technical };
    }
    return {
      ok: false,
      kind: "unknown",
      message: "Couldn’t analyze that link.",
      technical: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The installed yt-dlp version + how to update it (display only — no auto-run). */
export async function ytdlpInfo(probe: MediaProbe): Promise<{
  installed: boolean;
  version: string | null;
  updateCommand: string;
}> {
  const version = await probe.version();
  return { installed: version !== null, version, updateCommand: "pip install -U yt-dlp" };
}

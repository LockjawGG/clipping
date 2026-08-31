import { z } from "zod";

import { FetchError, type FetchErrorKind, type MediaProbe } from "../pipeline/fetcher.ts";
import { isLikelyPlaylistUrl } from "../pipeline/fetcher.ts";

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
      /** Present when the link is a playlist: what one click would import. */
      playlist?: {
        title: string | null;
        total: number;
        willAdd: number;
        firstTitles: string[];
      };
    }
  | { ok: false; kind: FetchErrorKind; message: string; technical: string };

/** Probe a URL and return a preview shape, or a classified reason it can't be used. */
export async function analyzeUrl(
  probe: MediaProbe,
  input: unknown,
  // The route passes the configured ceiling; a default here keeps the service
  // free of env coupling and keeps tests honest about what they assert.
  playlistMax = 100,
): Promise<AnalyzeResult> {
  const { url } = analyzeUrlSchema.parse(input);
  try {
    // A link that names a playlist is answered as one: how many videos, and
    // how many of them one click would actually add. Only explicit playlist
    // markers take this path, so a plain watch link never surprises anyone.
    if (isLikelyPlaylistUrl(url)) {
      const pl = await probe.probePlaylist(url);
      if (pl && pl.entries.length > 1) {
        return {
          ok: true,
          playlist: {
            title: pl.title,
            total: pl.total,
            willAdd: Math.min(pl.entries.length, playlistMax),
            firstTitles: pl.entries.slice(0, 3).map((e) => e.title ?? e.url),
          },
          title: pl.title,
          durationSec: null,
          thumbnail: null,
          source: "YouTube playlist",
          hasVideo: true,
          hasAudio: true,
          approxBytes: null,
          isLive: false,
        };
      }
    }
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

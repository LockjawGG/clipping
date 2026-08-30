import type { Ffmpeg, MediaInfo } from "../ffmpeg/run.ts";
import type { TextTranslator } from "../translation/text.ts";
import type { CaptionStyle } from "../captions/presets.ts";
import type { TextStyle } from "../captions/text-style.ts";
import type { WordRule } from "../captions/word-rules.ts";
import type { FaceDetector } from "../faces/detector.ts";
import type { MediaFetcher } from "./fetcher.ts";
import type { CaptionRenderer } from "./remotion.ts";
import type { JobKind } from "../jobs/types.ts";
import type {
  AnalysisProvider,
  Segment,
  StorageProvider,
  TranscriptionProvider,
  TranscriptResult,
  ClipSuggestion,
} from "../providers/types.ts";

/**
 * The pipeline handlers talk to narrow repository interfaces, not the Prisma
 * client directly — same seam as `JobStore` in the worker. Prisma-backed
 * implementations live in `repos.ts`; tests pass in-memory fakes.
 */

export interface VideoRow {
  id: string;
  storageKey: string;
  durationMs: number | null;
  status: string;
}

export interface VideoRepo {
  get(id: string): Promise<VideoRow | null>;
  /** Persist probe results and advance status past PROBING. */
  applyProbe(id: string, info: MediaInfo): Promise<void>;
  setStatus(id: string, status: string): Promise<void>;
  setError(id: string, message: string): Promise<void>;
  /** Replace the display filename (used after FETCH learns the real title). */
  setFilename(id: string, originalFilename: string): Promise<void>;
  /** Point the video at a different object, e.g. when finalising changes container. */
  setStorageKey(id: string, storageKey: string): Promise<void>;
  /** The video's project's custom transcription terms, parsed to a clean list. */
  transcriptionTerms(id: string): Promise<string[]>;
}

export interface TranscriptRepo {
  /**
   * Replace the transcript for a video. `translatedTo` picks which one: ""
   * (default) is the source transcription, a language code is a translation.
   */
  save(
    videoId: string,
    result: TranscriptResult,
    opts?: { translatedTo?: string },
  ): Promise<{ segmentCount: number }>;
  /** Segments of one transcript. `translatedTo` "" (default) = the source. */
  loadSegments(videoId: string, translatedTo?: string): Promise<Segment[]>;
  /** Detected language of the source transcript, or null if there is none. */
  primaryLanguage(videoId: string): Promise<string | null>;
  /**
   * Append segments to the video's transcript (creating it if absent) — used by
   * rolling live transcription. Segment/word start/end are already offset to the
   * session timeline. Returns the index range written.
   */
  appendSegments(
    videoId: string,
    input: { provider: string; language: string; segments: Segment[] },
  ): Promise<{ appended: number; fromIndex: number }>;
}

export interface ClipRepo {
  /** Replace the AI-suggested clips for the video. Returns how many were written. */
  replaceSuggested(videoId: string, clips: ClipSuggestion[]): Promise<number>;
}

export type DbAspectRatio = "VERTICAL_9_16" | "SQUARE_1_1" | "LANDSCAPE_16_9" | "PORTRAIT_4_5";

/** Everything the RENDER handler needs about one clip. */
export interface RenderTarget {
  clipId: string;
  videoId: string;
  sourceKey: string;
  startMs: number;
  endMs: number;
  aspectRatio: DbAspectRatio;
  focalX: number | null;
  focalY: number | null;
  quality: "P720" | "P1080" | "ORIGINAL";
  burnCaptions: boolean;
  /** Prisma CaptionAnimation enum value; "NONE" means a static ffmpeg burn. */
  captionAnimation: string;
  /** The scalar style, for the fast ffmpeg `force_style` burn. */
  captionStyle: CaptionStyle | null;
  /** The resolved rich style (scalar columns + styleJson). Drives the Remotion
   *  path; null when the clip has no caption config. */
  textStyle: TextStyle | null;
  /** Word-level rules (karaoke / highlight / emphasis) for the Remotion path. */
  wordRules: WordRule[];
  /** Library images/GIFs pinned onto this clip, bottom-to-top. */
  overlays: RenderOverlay[];
  /** Freestanding text elements, composited by Remotion over the reframed clip. */
  textOverlays: RenderTextOverlay[];
  /** Per-word caption overrides, keyed by transcript word id. */
  wordStyles: Record<string, { color: string | null; bold: boolean | null; italic: boolean | null }>;
}

/** One image/GIF overlay on a clip. Times are clip-relative ms; null = clip edge. */
export interface RenderOverlay {
  storageKey: string;
  /** True for animated GIFs, so the compositor loops the source. */
  animated: boolean;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startMs: number | null;
  endMs: number | null;
  /**
   * JSON `ElementAnimSpec`; null = static. A layer with motion cannot be
   * composited by the ffmpeg `overlay` filter — it has no per-frame scale or
   * rotation — so it is promoted to the Remotion path instead, the same tier
   * decision `captionNeedsRemotion` makes for captions.
   */
  animationJson: string | null;
}

/** An image/GIF overlay that Remotion composites, with its bytes on disk. */
export interface RenderImageLayer extends Omit<RenderOverlay, "storageKey"> {
  /** Absolute local path to the downloaded image / GIF. */
  path: string;
}

/** One freestanding text element. Position is a normalised 0..1 centre point. */
export interface RenderTextOverlay {
  text: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startMs: number | null;
  endMs: number | null;
  /** JSON partial TextStyle; null = default style. */
  styleJson: string | null;
  /** JSON `ElementAnimSpec` of preset ids + overrides; null = static. */
  animationJson: string | null;
}

export interface RenderResult {
  outputKey: string;
  sizeBytes: number | null;
  durationMs: number;
}

export interface RenderRepo {
  loadTarget(renderId: string): Promise<RenderTarget | null>;
  begin(renderId: string): Promise<void>;
  complete(renderId: string, result: RenderResult): Promise<void>;
  fail(renderId: string, message: string): Promise<void>;
}

export interface ThumbnailTarget {
  clipId: string;
  sourceKey: string;
  startMs: number;
  endMs: number;
}

export interface VideoPosterTarget {
  videoId: string;
  sourceKey: string;
  durationMs: number | null;
  /** True when the video already has a poster — the handler skips it then. */
  hasThumbnail: boolean;
}

export interface ThumbnailRepo {
  /** One clip. Returns null if it doesn't exist. */
  target(clipId: string): Promise<ThumbnailTarget | null>;
  /** Every clip of the video that has no thumbnail yet. */
  targetsForVideo(videoId: string): Promise<ThumbnailTarget[]>;
  setKey(clipId: string, thumbnailKey: string): Promise<void>;
  /** The video itself, for a poster frame. Null if the video is gone. */
  videoPosterTarget(videoId: string): Promise<VideoPosterTarget | null>;
  setVideoKey(videoId: string, thumbnailKey: string): Promise<void>;
}

/** Map the Prisma aspect enum to the `args.ts` preset string. */
export function toAspectPreset(a: DbAspectRatio): "9:16" | "1:1" | "16:9" | "4:5" {
  switch (a) {
    case "SQUARE_1_1":
      return "1:1";
    case "LANDSCAPE_16_9":
      return "16:9";
    case "PORTRAIT_4_5":
      return "4:5";
    default:
      return "9:16";
  }
}

export interface JobQueue {
  enqueue(input: { videoId: string; kind: JobKind; payload?: unknown }): Promise<string>;
}

/**
 * Downloads a video's source to disk once and hands the same path back to every
 * step, instead of re-fetching the (often GB-sized) file per job. `evict` is
 * called by the last ingest step.
 */
export interface SourceCache {
  /** Where this video's source lives (or would live) on disk. */
  localPath(videoId: string): string;
  ensureLocal(videoId: string, storageKey: string, signal?: AbortSignal): Promise<string>;
  evict(videoId: string): Promise<void>;
}

export interface LiveChunkRow {
  id: string;
  videoId: string;
  index: number;
  startMs: number;
  storageKey: string;
  status: string;
  /** Size the browser reported uploading, when it said. */
  bytes: number | null;
}

export interface LiveChunkRepo {
  get(id: string): Promise<LiveChunkRow | null>;
  setStatus(id: string, status: string): Promise<void>;
  /** All chunks of a video, in capture order. */
  listForVideo(videoId: string): Promise<LiveChunkRow[]>;
  /** Drop a video's chunk rows once they've been reassembled into the source. */
  deleteForVideo(videoId: string): Promise<void>;
}

export interface PipelineDeps {
  ffmpeg: Ffmpeg;
  storage: StorageProvider;
  source: SourceCache;
  transcription: TranscriptionProvider;
  analysis: AnalysisProvider;
  videos: VideoRepo;
  transcripts: TranscriptRepo;
  textTranslator: TextTranslator;
  clips: ClipRepo;
  renders: RenderRepo;
  thumbnails: ThumbnailRepo;
  liveChunks: LiveChunkRepo;
  captions: CaptionRenderer;
  faces: FaceDetector;
  fetcher: MediaFetcher;
  queue: JobQueue;
  /** Absolute scratch directory (env.TEMP_DIR). */
  tempDir: string;
}

/** Join scratch-path parts with "/" so `assertSafePath` accepts the result. */
export function scratchPath(tempDir: string, ...parts: string[]): string {
  return [tempDir.replace(/[\\/]+$/, ""), ...parts.map((p) => String(p))].join("/");
}

/** Per-job scratch directory — the worker wipes this after each job. */
export function jobWorkDir(tempDir: string, jobId: string): string {
  return scratchPath(tempDir, "work", jobId);
}

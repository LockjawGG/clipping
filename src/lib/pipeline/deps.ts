import type { Ffmpeg, MediaInfo } from "../ffmpeg/run.ts";
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
}

export interface TranscriptRepo {
  /** Replace any existing transcript for the video. Returns the segment count. */
  save(videoId: string, result: TranscriptResult): Promise<{ segmentCount: number }>;
  loadSegments(videoId: string): Promise<Segment[]>;
}

export interface ClipRepo {
  /** Replace the AI-suggested clips for the video. Returns how many were written. */
  replaceSuggested(videoId: string, clips: ClipSuggestion[]): Promise<number>;
}

export interface JobQueue {
  enqueue(input: { videoId: string; kind: JobKind; payload?: unknown }): Promise<string>;
}

export interface PipelineDeps {
  ffmpeg: Ffmpeg;
  storage: StorageProvider;
  transcription: TranscriptionProvider;
  analysis: AnalysisProvider;
  videos: VideoRepo;
  transcripts: TranscriptRepo;
  clips: ClipRepo;
  queue: JobQueue;
  /** POSIX-absolute scratch directory (env.TEMP_DIR). */
  tempDir: string;
}

/** Join scratch-path parts with "/" so `assertSafePath` accepts the result. */
export function scratchPath(tempDir: string, ...parts: string[]): string {
  return [tempDir.replace(/\/+$/, ""), ...parts].join("/");
}

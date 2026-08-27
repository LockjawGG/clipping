import type { FocalPoint } from "./track.ts";

export interface DetectOptions {
  /** Clip duration, so the detector can bound its sampling. */
  durationMs: number;
  /** Source frame dimensions, if known. */
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

/**
 * Emits a raw focal-point track for a video: where the subject (a face,
 * usually) is over time, normalised 0..1 in the source frame. `track.ts`
 * smooths and resamples the result before it drives a crop.
 */
export interface FaceDetector {
  readonly name: string;
  detectTrack(videoPath: string, options: DetectOptions): Promise<FocalPoint[]>;
}

/**
 * The default: no detection. RENDER falls back to a static centre crop.
 * Swap in a real detector (MediaPipe, a face-api model, an OpenCV pass) by
 * implementing `FaceDetector` and wiring it into `buildPipelineDeps`.
 */
export class NullFaceDetector implements FaceDetector {
  readonly name = "none";

  async detectTrack(_videoPath: string, _options: DetectOptions): Promise<FocalPoint[]> {
    return [];
  }
}

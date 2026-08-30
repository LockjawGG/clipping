import type { JobHandlerMap } from "../jobs/types.ts";
import type { PipelineDeps } from "./deps.ts";
import {
  analyzeHandler,
  audioFeaturesHandler,
  extractAudioHandler,
  fetchHandler,
  probeHandler,
  renderHandler,
  thumbnailHandler,
  transcribeHandler,
  workerRunHandler,
  voiceoverHandler,
} from "./handlers.ts";
import { liveFinalizeHandler, liveTranscribeHandler } from "./live-handlers.ts";
import { translateHandler } from "./translate-handler.ts";

export * from "./deps.ts";
export {
  fetchHandler,
  probeHandler,
  extractAudioHandler,
  audioFeaturesHandler,
  transcribeHandler,
  analyzeHandler,
  renderHandler,
  thumbnailHandler,
  workerRunHandler,
  voiceoverHandler,
} from "./handlers.ts";
export { liveTranscribeHandler, liveFinalizeHandler } from "./live-handlers.ts";
export { translateHandler } from "./translate-handler.ts";

/** The full pipeline handler map. */
export const PIPELINE_HANDLERS: JobHandlerMap<PipelineDeps> = {
  FETCH: fetchHandler,
  PROBE: probeHandler,
  EXTRACT_AUDIO: extractAudioHandler,
  TRANSCRIBE: transcribeHandler,
  ANALYZE: analyzeHandler,
  RENDER: renderHandler,
  THUMBNAIL: thumbnailHandler,
  LIVE_TRANSCRIBE: liveTranscribeHandler,
  LIVE_FINALIZE: liveFinalizeHandler,
  TRANSLATE: translateHandler,
  AUDIO_FEATURES: audioFeaturesHandler,
  WORKER_RUN: workerRunHandler,
  VOICEOVER: voiceoverHandler,
};

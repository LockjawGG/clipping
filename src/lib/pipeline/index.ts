import type { JobHandlerMap } from "../jobs/types.ts";
import type { PipelineDeps } from "./deps.ts";
import {
  analyzeHandler,
  extractAudioHandler,
  fetchHandler,
  probeHandler,
  renderHandler,
  thumbnailHandler,
  transcribeHandler,
} from "./handlers.ts";

export * from "./deps.ts";
export {
  fetchHandler,
  probeHandler,
  extractAudioHandler,
  transcribeHandler,
  analyzeHandler,
  renderHandler,
  thumbnailHandler,
} from "./handlers.ts";

/** The full pipeline handler map. */
export const PIPELINE_HANDLERS: JobHandlerMap<PipelineDeps> = {
  FETCH: fetchHandler,
  PROBE: probeHandler,
  EXTRACT_AUDIO: extractAudioHandler,
  TRANSCRIBE: transcribeHandler,
  ANALYZE: analyzeHandler,
  RENDER: renderHandler,
  THUMBNAIL: thumbnailHandler,
};

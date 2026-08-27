import type { JobHandlerMap } from "../jobs/types.ts";
import type { PipelineDeps } from "./deps.ts";
import {
  analyzeHandler,
  extractAudioHandler,
  probeHandler,
  renderHandler,
  transcribeHandler,
} from "./handlers.ts";

export * from "./deps.ts";
export {
  probeHandler,
  extractAudioHandler,
  transcribeHandler,
  analyzeHandler,
  renderHandler,
} from "./handlers.ts";

/** The handler map. THUMBNAIL lands with the thumbnail feature. */
export const PIPELINE_HANDLERS: JobHandlerMap<PipelineDeps> = {
  PROBE: probeHandler,
  EXTRACT_AUDIO: extractAudioHandler,
  TRANSCRIBE: transcribeHandler,
  ANALYZE: analyzeHandler,
  RENDER: renderHandler,
};

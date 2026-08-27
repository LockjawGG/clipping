import type { JobHandlerMap } from "../jobs/types.ts";
import type { PipelineDeps } from "./deps.ts";
import {
  analyzeHandler,
  extractAudioHandler,
  probeHandler,
  transcribeHandler,
} from "./handlers.ts";

export * from "./deps.ts";
export {
  probeHandler,
  extractAudioHandler,
  transcribeHandler,
  analyzeHandler,
} from "./handlers.ts";

/** The handler map for the ingest chain. RENDER / THUMBNAIL land with rendering. */
export const PIPELINE_HANDLERS: JobHandlerMap<PipelineDeps> = {
  PROBE: probeHandler,
  EXTRACT_AUDIO: extractAudioHandler,
  TRANSCRIBE: transcribeHandler,
  ANALYZE: analyzeHandler,
};

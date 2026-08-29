import type { JobHandler } from "../jobs/types.ts";
import type { PipelineDeps } from "./deps.ts";

interface TranslatePayload {
  /** Target language code, e.g. "es". */
  to?: string;
  /** Source language; falls back to the primary transcript's detected language. */
  from?: string;
}

/**
 * TRANSLATE: render an existing transcript into another language with the
 * offline text translator, stored as a separate Transcript row. The source
 * transcript, the video's status, and its clips are all left alone.
 *
 * Segment timings carry over unchanged; per-word timing does not survive
 * translation, so a translated transcript has segment text only.
 */
export const translateHandler: JobHandler<PipelineDeps> = async ({ job, deps, signal, setProgress }) => {
  const { to, from } = (job.payload ?? {}) as TranslatePayload;
  if (!to) throw new Error("TRANSLATE payload is missing the target language");

  const source = await deps.transcripts.loadSegments(job.videoId, "");
  if (source.length === 0) {
    return { skipped: "no source transcript to translate", translatedTo: to };
  }
  const sourceLang = from ?? (await deps.transcripts.primaryLanguage(job.videoId)) ?? "en";
  await setProgress(0.1);

  const translated = await deps.textTranslator.translate(
    source.map((s, i) => ({ id: String(i), text: s.text })),
    sourceLang,
    to,
  );
  await setProgress(0.85);

  const byId = new Map(translated.map((t) => [t.id, t.text]));
  const { segmentCount } = await deps.transcripts.save(
    job.videoId,
    {
      provider: `translate:${deps.textTranslator.name}`,
      language: to,
      segments: source.map((s, i) => ({
        text: byId.get(String(i)) ?? s.text,
        startMs: s.startMs,
        endMs: s.endMs,
        speaker: s.speaker,
        words: [],
      })),
    },
    { translatedTo: to },
  );
  await setProgress(1);
  void signal;
  return { translatedTo: to, from: sourceLang, segmentCount };
};

import { z } from "zod";

import { ApiError } from "./http.ts";

/**
 * Inline transcript correction: fix a single word's text. Timings are never
 * touched. The parent segment's `text` is rebuilt from its words so
 * segment-level consumers (the render pipeline, exports) stay in sync.
 */

export const updateWordSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => !/[\n\r]/.test(v), "no line breaks"),
});

interface WordWithContext {
  id: string;
  index: number;
  text: string;
  segment: {
    id: string;
    words: Array<{ id: string; index: number; text: string }>;
    transcript: { video: { projectId: string } };
  };
}

export interface ExportSegmentRow {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

export interface TranscriptDb {
  transcriptWord: {
    findUnique(args: { where: { id: string }; include: unknown }): Promise<WordWithContext | null>;
    update(args: { where: { id: string }; data: { text: string } }): Promise<unknown>;
  };
  transcriptSegment: {
    update(args: { where: { id: string }; data: { text: string } }): Promise<unknown>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: unknown;
      select?: unknown;
    }): Promise<ExportSegmentRow[]>;
  };
  video: {
    findUnique(args: {
      where: { id: string };
      select?: unknown;
    }): Promise<{ projectId: string; originalFilename: string } | null>;
  };
}

export interface TranscriptServiceDeps {
  db: TranscriptDb;
  assertProjectOwned: (projectId: string) => Promise<void>;
}

/** Join a segment's words back into display text, collapsing space before punctuation. */
export function joinWords(words: Array<{ text: string }>): string {
  return words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1");
}

export async function updateWord(deps: TranscriptServiceDeps, wordId: string, input: unknown) {
  const { text } = updateWordSchema.parse(input);

  const word = await deps.db.transcriptWord.findUnique({
    where: { id: wordId },
    include: {
      segment: {
        include: {
          words: { orderBy: { index: "asc" }, select: { id: true, index: true, text: true } },
          transcript: { include: { video: { select: { projectId: true } } } },
        },
      },
    },
  });
  if (!word) throw new ApiError(404, "word not found");
  await deps.assertProjectOwned(word.segment.transcript.video.projectId);

  await deps.db.transcriptWord.update({ where: { id: wordId }, data: { text } });

  const rebuilt = word.segment.words.map((w) => (w.id === wordId ? { text } : { text: w.text }));
  await deps.db.transcriptSegment.update({
    where: { id: word.segment.id },
    data: { text: joinWords(rebuilt) },
  });

  return { id: wordId, text, segmentId: word.segment.id };
}

/* --------------------------------------------------------- transcript export */

export const TRANSCRIPT_FORMATS = ["srt", "vtt", "txt"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

function stamp(ms: number, sep: "," | "."): string {
  const t = Math.max(0, Math.round(ms));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${pad(Math.floor(t / 3_600_000))}:` +
    `${pad(Math.floor((t % 3_600_000) / 60_000))}:` +
    `${pad(Math.floor((t % 60_000) / 1000))}${sep}${pad(t % 1000, 3)}`
  );
}

/** Pure: segment rows -> a subtitle / plain-text document. Exported for tests. */
export function formatTranscript(rows: ExportSegmentRow[], format: TranscriptFormat): string {
  const line = (r: ExportSegmentRow) => (r.speaker ? `${r.speaker}: ${r.text}` : r.text);

  if (format === "txt") {
    return rows.map(line).join("\n") + "\n";
  }
  if (format === "vtt") {
    const body = rows
      .map((r) => `${stamp(r.startMs, ".")} --> ${stamp(r.endMs, ".")}\n${line(r)}`)
      .join("\n\n");
    return `WEBVTT\n\n${body}\n`;
  }
  return (
    rows
      .map((r, i) => `${i + 1}\n${stamp(r.startMs, ",")} --> ${stamp(r.endMs, ",")}\n${line(r)}`)
      .join("\n\n") + "\n"
  );
}

/**
 * Build a downloadable transcript for a video in the requested format and
 * language view ("" = the source transcript, a code = a translation).
 */
export async function exportTranscript(
  deps: TranscriptServiceDeps,
  videoId: string,
  opts: { format: TranscriptFormat; lang?: string },
) {
  const video = await deps.db.video.findUnique({
    where: { id: videoId },
    select: { projectId: true, originalFilename: true },
  });
  if (!video) throw new ApiError(404, "video not found");
  await deps.assertProjectOwned(video.projectId);

  const translatedTo = opts.lang ?? "";
  const rows = await deps.db.transcriptSegment.findMany({
    where: { transcript: { videoId, translatedTo } },
    orderBy: { index: "asc" },
    select: { index: true, startMs: true, endMs: true, text: true, speaker: true },
  });
  if (rows.length === 0) throw new ApiError(404, "no transcript for this language");

  const slug =
    video.originalFilename
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "transcript";
  const suffix = translatedTo ? `.${translatedTo}` : "";
  return {
    filename: `${slug}${suffix}.${opts.format}`,
    contentType:
      opts.format === "vtt"
        ? "text/vtt"
        : opts.format === "srt"
          ? "application/x-subrip"
          : "text/plain",
    body: formatTranscript(rows, opts.format),
  };
}



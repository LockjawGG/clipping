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

export interface TranscriptDb {
  transcriptWord: {
    findUnique(args: { where: { id: string }; include: unknown }): Promise<WordWithContext | null>;
    update(args: { where: { id: string }; data: { text: string } }): Promise<unknown>;
  };
  transcriptSegment: {
    update(args: { where: { id: string }; data: { text: string } }): Promise<unknown>;
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

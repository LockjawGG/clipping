import test from "node:test";
import assert from "node:assert/strict";

import { prismaTranscriptRepo } from "../src/lib/pipeline/repos.ts";
import type { TranscriptResult } from "../src/lib/providers/types.ts";

/**
 * A hosted DB times the interactive transaction out when `save` does one
 * `create` per segment for a full-length transcript ("Transaction already
 * closed"). These tests pin the batched behaviour: bulk `createMany`, an
 * explicit long timeout, and words linked to the right segment by index.
 */
function fakeClient() {
  const calls: string[] = [];
  let txOpts: unknown = null;
  const segRows: Array<{ id: string; index: number }> = [];
  const wordBatches: Array<Array<{ segmentId: string; index: number; text: string }>> = [];
  let deleted = 0;

  const tx = {
    transcript: {
      deleteMany: async () => {
        calls.push("transcript.deleteMany");
        deleted++;
        return { count: 1 };
      },
      create: async () => {
        calls.push("transcript.create");
        return { id: "t1" };
      },
    },
    transcriptSegment: {
      createMany: async ({ data }: { data: Array<{ index: number }> }) => {
        calls.push(`segment.createMany(${data.length})`);
        data.forEach((d) => segRows.push({ id: `s${d.index}`, index: d.index }));
        return { count: data.length };
      },
      findMany: async () => {
        calls.push("segment.findMany");
        return [...segRows].sort((a, b) => a.index - b.index);
      },
    },
    transcriptWord: {
      createMany: async ({ data }: { data: Array<{ segmentId: string; index: number; text: string }> }) => {
        calls.push(`word.createMany(${data.length})`);
        wordBatches.push(data);
        return { count: data.length };
      },
    },
  };

  const client = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>, opts: unknown) => {
      txOpts = opts;
      return fn(tx);
    },
  };
  return {
    client: client as unknown as Parameters<typeof prismaTranscriptRepo>[0],
    get calls() {
      return calls;
    },
    get txOpts() {
      return txOpts as { timeout?: number; maxWait?: number } | null;
    },
    get wordBatches() {
      return wordBatches;
    },
    get deleted() {
      return deleted;
    },
  };
}

function transcript(segCount: number, wordsPer: number): TranscriptResult {
  return {
    provider: "whisper-local",
    model: "base",
    language: "en",
    confidence: 0.9,
    segments: Array.from({ length: segCount }, (_, i) => ({
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      text: `segment ${i}`,
      words: Array.from({ length: wordsPer }, (_, w) => ({
        startMs: i * 1000 + w * 100,
        endMs: i * 1000 + w * 100 + 90,
        text: `s${i}w${w}`,
        confidence: 0.8,
      })),
    })),
  };
}

test("save bulk-inserts segments and words with a long transaction timeout", async () => {
  const fc = fakeClient();
  const repo = prismaTranscriptRepo(fc.client);

  const res = await repo.save("vid1", transcript(3, 2));
  assert.deepEqual(res, { segmentCount: 3 });

  // one deleteMany, one transcript.create, one segment.createMany, one findMany,
  // then word.createMany — never a per-segment create loop
  assert.equal(fc.calls.filter((c) => c === "transcript.create").length, 1);
  assert.equal(fc.calls.filter((c) => c.startsWith("segment.createMany")).length, 1);
  assert.ok(fc.calls.includes("segment.createMany(3)"));
  assert.ok(!fc.calls.some((c) => c === "segment.create"));

  // the transaction is given real time, not the 5s default
  assert.ok((fc.txOpts?.timeout ?? 0) >= 60_000, "timeout should be at least 60s");
});

test("save links every word to its segment id by index order", async () => {
  const fc = fakeClient();
  const repo = prismaTranscriptRepo(fc.client);
  await repo.save("vid1", transcript(3, 2));

  const allWords = fc.wordBatches.flat();
  assert.equal(allWords.length, 6);
  // segment 0's words -> s0, segment 2's words -> s2
  assert.deepEqual(
    allWords.filter((w) => w.text.startsWith("s0")).map((w) => w.segmentId),
    ["s0", "s0"],
  );
  assert.deepEqual(
    allWords.filter((w) => w.text.startsWith("s2")).map((w) => w.segmentId),
    ["s2", "s2"],
  );
});

test("save chunks large word sets into batches of 1000", async () => {
  const fc = fakeClient();
  const repo = prismaTranscriptRepo(fc.client);
  // 3 segments * 800 words = 2400 -> 3 word.createMany calls (1000, 1000, 400)
  await repo.save("vid1", transcript(3, 800));

  const wordCalls = fc.calls.filter((c) => c.startsWith("word.createMany"));
  assert.deepEqual(wordCalls, ["word.createMany(1000)", "word.createMany(1000)", "word.createMany(400)"]);
});

test("save clears any previous transcript for the video first", async () => {
  const fc = fakeClient();
  const repo = prismaTranscriptRepo(fc.client);
  await repo.save("vid1", transcript(1, 1));
  assert.equal(fc.deleted, 1);
  assert.equal(fc.calls[0], "transcript.deleteMany");
});

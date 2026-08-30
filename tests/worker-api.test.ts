import test from "node:test";
import assert from "node:assert/strict";

import {
  getWorkerRun,
  latestWorkerRun,
  startWorkerRun,
  updateSuggestion,
  type WorkerServiceDeps,
} from "../src/lib/api/worker.ts";

interface Fixture {
  deps: WorkerServiceDeps;
  enqueued: Array<{ videoId: string; kind: string; payload?: unknown }>;
  created: Array<Record<string, unknown>>;
  updated: Array<{ id: string; data: Record<string, unknown> }>;
  clips: Array<{ videoId: string; input: Record<string, unknown> }>;
}

interface SuggestionFixture {
  id: string;
  kind: string;
  startMs: number;
  endMs: number;
  score: number;
  reason: string;
  payloadJson: Record<string, unknown> | null;
  status: string;
  createdClipId: string | null;
}

const RUN: {
  id: string;
  videoId: string;
  clipId: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  suggestions: SuggestionFixture[];
} = {
  id: "run1",
  videoId: "vidA",
  clipId: null,
  status: "COMPLETED",
  errorMessage: null,
  createdAt: new Date("2026-01-01"),
  finishedAt: new Date("2026-01-01"),
  suggestions: [
    {
      id: "s1",
      kind: "HIGHLIGHT",
      startMs: 1000,
      endMs: 6000,
      score: 0.8,
      reason: "opens on a question · energy in the top quarter",
      payloadJson: { title: "A moment" },
      status: "PENDING",
      createdClipId: null,
    },
  ],
};

function makeDeps(
  over: { videoOwner?: string; suggestion?: Partial<SuggestionFixture> } = {},
): Fixture {
  const enqueued: Fixture["enqueued"] = [];
  const created: Fixture["created"] = [];
  const updated: Fixture["updated"] = [];
  const clips: Fixture["clips"] = [];
  const owner = over.videoOwner ?? "proj-mine";
  const suggestion = { ...RUN.suggestions[0], ...(over.suggestion ?? {}) };

  type W = { where: { id: string }; data?: Record<string, unknown> };
  const deps: WorkerServiceDeps = {
    db: {
      video: {
        findUnique: async ({ where }: W) =>
          where.id === "vidA" ? { id: "vidA", projectId: owner, durationMs: 60_000 } : null,
      },
      workerRun: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "run-new" };
        },
        findUnique: async ({ where }: W) => (where.id === "run1" ? { ...RUN } : null),
        findFirst: async ({ where }: { where: { videoId?: string } }) =>
          where.videoId === "vidA" ? { ...RUN } : null,
      },
      workerSuggestion: {
        findUnique: async ({ where }: W) =>
          where.id === "s1" ? { ...suggestion, run: { videoId: "vidA" } } : null,
        update: async ({ where, data }: Required<W>) => {
          updated.push({ id: where.id, data });
          return { ...suggestion, ...(data as object) } as SuggestionFixture;
        },
      },
    } as unknown as WorkerServiceDeps["db"],
    assertProjectOwned: async (projectId) => {
      if (projectId !== "proj-mine") {
        const e = new Error("not found") as Error & { status: number };
        e.status = 404;
        throw e;
      }
    },
    enqueue: async (input) => {
      enqueued.push(input);
      return "job-1";
    },
    createClip: async (videoId, input) => {
      clips.push({ videoId, input: input as unknown as Record<string, unknown> });
      return { id: "clip-new", appliedDefaults: ["captions"] };
    },
  };
  return { deps, enqueued, created, updated, clips };
}

test("starting a run queues a job and returns the id to poll", async () => {
  const f = makeDeps();
  const out = await startWorkerRun(f.deps, "vidA", { objectives: { deadAir: false } });

  assert.deepEqual(out, { runId: "run-new", status: "QUEUED" });
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.created[0].objectivesJson, { deadAir: false });
  assert.equal(f.enqueued.length, 1);
  assert.equal(f.enqueued[0].kind, "WORKER_RUN");
  assert.deepEqual(f.enqueued[0].payload, { runId: "run-new" });
});

test("run options are passed through to the job, bounded by the schema", async () => {
  const f = makeDeps();
  await startWorkerRun(f.deps, "vidA", { minClipMs: 20_000, maxClipMs: 90_000, maxClips: 5 });
  assert.deepEqual(f.enqueued[0].payload, {
    runId: "run-new",
    minClipMs: 20_000,
    maxClipMs: 90_000,
    maxClips: 5,
  });

  await assert.rejects(() => startWorkerRun(f.deps, "vidA", { maxClips: 999 }));
  await assert.rejects(() => startWorkerRun(f.deps, "vidA", { nonsense: true }));
});

test("a run cannot be started on someone else's video", async () => {
  const f = makeDeps({ videoOwner: "proj-theirs" });
  await assert.rejects(() => startWorkerRun(f.deps, "vidA", {}), /not found/);
  assert.equal(f.enqueued.length, 0, "nothing was queued");
  assert.equal(f.created.length, 0, "no run row was created");
});

test("an unknown video is a 404, not a created run", async () => {
  const f = makeDeps();
  await assert.rejects(() => startWorkerRun(f.deps, "nope", {}), /not found/);
  assert.equal(f.created.length, 0);
});

test("the latest run comes back with its suggestions and their evidence", async () => {
  const f = makeDeps();
  const run = await latestWorkerRun(f.deps, "vidA");
  assert.ok(run);
  assert.equal(run.suggestions.length, 1);
  assert.equal(run.suggestions[0].status, "PENDING", "suggestions start unapplied");
  assert.ok(run.suggestions[0].reason.length > 0, "every suggestion is auditable");
});

test("reading a run checks ownership of its video, not just the run id", async () => {
  const f = makeDeps({ videoOwner: "proj-theirs" });
  await assert.rejects(() => getWorkerRun(f.deps, "run1"), /not found/);
  await assert.rejects(() => latestWorkerRun(f.deps, "vidA"), /not found/);
});

test("accepting a highlight creates the clip it describes", async () => {
  const f = makeDeps({
    suggestion: {
      payloadJson: {
        title: "A moment",
        hook: "wait for it",
        caption: "cap",
        socialTitle: "social",
        hashtags: ["#a", 7, "#b"],
      },
    },
  });
  await updateSuggestion(f.deps, "s1", { status: "ACCEPTED" });

  assert.equal(f.clips.length, 1);
  assert.equal(f.clips[0].videoId, "vidA");
  assert.deepEqual(f.clips[0].input, {
    startMs: 1000,
    endMs: 6000,
    title: "A moment",
    hook: "wait for it",
    caption: "cap",
    socialTitle: "social",
    // Non-string hashtags from a payload are dropped, not passed through.
    hashtags: ["#a", "#b"],
    reason: "opens on a question · energy in the top quarter",
    score: 0.8,
    origin: "AI_SUGGESTED",
  });
  // The suggestion is marked APPLIED and linked to what it produced.
  assert.deepEqual(f.updated, [
    { id: "s1", data: { status: "APPLIED", createdClipId: "clip-new" } },
  ]);
});

test("a highlight with an empty payload still creates a usable clip", async () => {
  const f = makeDeps({ suggestion: { payloadJson: null } });
  await updateSuggestion(f.deps, "s1", { status: "ACCEPTED" });
  assert.equal(f.clips.length, 1);
  assert.equal(f.clips[0].input.title, "Suggested clip");
  assert.deepEqual(f.clips[0].input.hashtags, []);
});

test("accepting twice does not create a second clip", async () => {
  // Idempotent via createdClipId — a duplicate would be the user's to find and
  // delete, which is a worse outcome than a no-op.
  const f = makeDeps({ suggestion: { createdClipId: "clip-existing" } });
  await updateSuggestion(f.deps, "s1", { status: "ACCEPTED" });
  assert.equal(f.clips.length, 0);
  assert.deepEqual(f.updated, [{ id: "s1", data: { status: "APPLIED" } }]);
});

test("accepting a non-highlight records the decision without creating anything", async () => {
  // Dead air and reactions have no single obvious edit to perform, so applying
  // them silently would be doing something the user did not ask for.
  for (const kind of ["DEAD_AIR", "REACTION"]) {
    const f = makeDeps({ suggestion: { kind } });
    await updateSuggestion(f.deps, "s1", { status: "ACCEPTED" });
    assert.equal(f.clips.length, 0, kind);
    assert.deepEqual(f.updated, [{ id: "s1", data: { status: "ACCEPTED" } }], kind);
  }
});

test("rejecting a highlight creates nothing", async () => {
  const f = makeDeps();
  await updateSuggestion(f.deps, "s1", { status: "REJECTED" });
  assert.equal(f.clips.length, 0);
  assert.deepEqual(f.updated, [{ id: "s1", data: { status: "REJECTED" } }]);
});

test("undo never deletes a clip that was already created", async () => {
  // The user may have edited it since; removing their work to honour an undo of
  // a *decision* would be a far worse surprise than an extra clip.
  const f = makeDeps({ suggestion: { createdClipId: "clip-existing", status: "APPLIED" } });
  await updateSuggestion(f.deps, "s1", { status: "PENDING" });
  assert.equal(f.clips.length, 0);
  assert.deepEqual(f.updated, [{ id: "s1", data: { status: "PENDING" } }]);
});

test("a decision can be taken back", async () => {
  const f = makeDeps();
  await updateSuggestion(f.deps, "s1", { status: "REJECTED" });
  await updateSuggestion(f.deps, "s1", { status: "PENDING" });
  assert.deepEqual(
    f.updated.map((u) => u.data.status),
    ["REJECTED", "PENDING"],
  );
});

test("an invalid status is rejected before it reaches the database", async () => {
  const f = makeDeps();
  await assert.rejects(() => updateSuggestion(f.deps, "s1", { status: "MAYBE" }));
  await assert.rejects(() => updateSuggestion(f.deps, "s1", {}));
  assert.equal(f.updated.length, 0);
});

test("a suggestion on someone else's video cannot be decided", async () => {
  const f = makeDeps({ videoOwner: "proj-theirs" });
  await assert.rejects(() => updateSuggestion(f.deps, "s1", { status: "ACCEPTED" }), /not found/);
  assert.equal(f.updated.length, 0);
});

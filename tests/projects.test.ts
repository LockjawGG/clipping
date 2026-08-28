import test from "node:test";
import assert from "node:assert/strict";

import type { ProjectDb, ProjectServiceDeps } from "../src/lib/api/projects.ts";
import {
  createProject,
  deleteProject,
  listProjects,
  renameProject,
} from "../src/lib/api/projects.ts";
import { ApiError } from "../src/lib/api/http.ts";

interface Row {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  videos: number;
}

function makeDeps(userId = "u1") {
  const rows = new Map<string, Row>([
    ["p1", { id: "p1", userId: "u1", name: "My Project", createdAt: new Date(1), videos: 2 }],
    ["p2", { id: "p2", userId: "u1", name: "B-roll", createdAt: new Date(2), videos: 0 }],
    ["pX", { id: "pX", userId: "someone-else", name: "Theirs", createdAt: new Date(3), videos: 0 }],
  ]);
  let seq = 0;
  const db: ProjectDb = {
    project: {
      findMany: async ({ where }) =>
        [...rows.values()]
          .filter((r) => r.userId === where.userId)
          .sort((a, b) => +a.createdAt - +b.createdAt)
          .map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, _count: { videos: r.videos } })),
      findUnique: async ({ where }) => {
        const r = rows.get(where.id);
        return r ? { id: r.id, userId: r.userId } : null;
      },
      create: async ({ data }) => {
        const id = `new${++seq}`;
        const row = { id, userId: data.userId, name: data.name, createdAt: new Date(100 + seq), videos: 0 };
        rows.set(id, row);
        return { id, name: row.name, createdAt: row.createdAt };
      },
      update: async ({ where, data }) => {
        rows.get(where.id)!.name = data.name;
        return { id: where.id, name: data.name };
      },
      delete: async ({ where }) => {
        rows.delete(where.id);
      },
      count: async ({ where }) => [...rows.values()].filter((r) => r.userId === where.userId).length,
    },
  };
  const deps: ProjectServiceDeps = { db, userId };
  return { deps, rows };
}

test("listProjects returns only the user's projects with video counts", async () => {
  const { deps } = makeDeps();
  const list = await listProjects(deps);
  assert.deepEqual(
    list.map((p) => [p.id, p.videoCount]),
    [
      ["p1", 2],
      ["p2", 0],
    ],
  );
});

test("createProject attaches to the user", async () => {
  const { deps } = makeDeps();
  const p = await createProject(deps, { name: "  Shorts  " });
  assert.equal(p.name, "Shorts");
  assert.equal((await listProjects(deps)).length, 3);
});

test("renameProject changes the name", async () => {
  const { deps, rows } = makeDeps();
  await renameProject(deps, "p2", { name: "Cutdowns" });
  assert.equal(rows.get("p2")!.name, "Cutdowns");
});

test("renameProject on someone else's project is 404", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => renameProject(deps, "pX", { name: "hax" }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test("deleteProject removes an owned project", async () => {
  const { deps, rows } = makeDeps();
  await deleteProject(deps, "p2");
  assert.equal(rows.has("p2"), false);
});

test("deleteProject refuses the user's last project", async () => {
  const { deps } = makeDeps();
  await deleteProject(deps, "p2");
  await assert.rejects(
    () => deleteProject(deps, "p1"),
    (e: unknown) => e instanceof ApiError && e.status === 400,
  );
});

test("deleteProject on someone else's project is 404", async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => deleteProject(deps, "pX"),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  parseSettings,
  updateSettings,
  getSettings,
  censorSeed,
  beamSizeFor,
  type SettingsDb,
  type UserSettings,
} from "../src/lib/api/settings.ts";
import { isOrphan, type OrphanScanInput } from "../src/lib/api/storage-maintenance.ts";

/* ------------------------------------------------------------------------- */
/* parseSettings — leniency is the contract                                   */
/* ------------------------------------------------------------------------- */

test("parseSettings: null, empty and garbage all yield defaults", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings(""), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("not json {"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("{}"), DEFAULT_SETTINGS);
});

test("parseSettings: one bad field falls back alone, the rest survive", () => {
  const s = parseSettings(
    JSON.stringify({
      duckDb: "loud", // wrong type → default
      playlistMax: 9000, // out of range → default
      voiceSpeed: 1.5, // fine → kept
      censorDenyList: ["damn"],
      defaultCaptionPreset: "NEON", // not a preset → default
    }),
  );
  assert.equal(s.duckDb, -60);
  assert.equal(s.playlistMax, 100);
  assert.equal(s.voiceSpeed, 1.5);
  assert.deepEqual(s.censorDenyList, ["damn"]);
  assert.equal(s.defaultCaptionPreset, "CLASSIC");
});

test("parseSettings: a row written by a newer build (unknown keys) still parses", () => {
  const s = parseSettings(JSON.stringify({ futureKnob: true, playlistMax: 25 }));
  assert.equal(s.playlistMax, 25);
});

/* ------------------------------------------------------------------------- */
/* getSettings / updateSettings over a fake db                                */
/* ------------------------------------------------------------------------- */

function fakeDb(initial?: string): SettingsDb & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  if (initial) rows.set("u1", initial);
  return {
    rows,
    userSettings: {
      async findUnique({ where }) {
        const json = rows.get(where.userId);
        return json === undefined ? null : { json };
      },
      async upsert({ where, create, update }) {
        rows.set(where.userId, rows.has(where.userId) ? update.json : create.json);
        return {};
      },
    },
  };
}

test("updateSettings: patch merges over stored values and persists", async () => {
  const db = fakeDb(JSON.stringify({ voiceSpeed: 1.25 }));
  const next = await updateSettings(db, "u1", { duckDb: -20 });
  assert.equal(next.duckDb, -20);
  assert.equal(next.voiceSpeed, 1.25); // untouched field kept
  const reread = await getSettings(db, "u1");
  assert.deepEqual(reread, next);
});

test("updateSettings: unknown keys are rejected, out-of-range values fall back", async () => {
  const db = fakeDb();
  await assert.rejects(() => updateSettings(db, "u1", { nonsense: 1 }));
  assert.equal(db.rows.size, 0); // nothing written on rejection
  // Field-level .catch(): a bad value saves the default, never the bad value.
  const next = await updateSettings(db, "u1", { duckDb: 5 });
  assert.equal(next.duckDb, -60);
});

test("updateSettings: concurrent patches to different fields both land", async () => {
  // Regression: the Settings tab fires one PUT per control, and three rapid
  // changes once raced — the later read-modify-write erased the earlier write
  // (observed live: transcriptionLanguage lost to the voiceId save).
  const db = fakeDb();
  await Promise.all([
    updateSettings(db, "u1", { transcriptionLanguage: "ko" }),
    updateSettings(db, "u1", { voiceId: "en_US-lessac-high" }),
    updateSettings(db, "u1", { duckDb: -18 }),
  ]);
  const s = await getSettings(db, "u1");
  assert.equal(s.transcriptionLanguage, "ko");
  assert.equal(s.voiceId, "en_US-lessac-high");
  assert.equal(s.duckDb, -18);
});

test("censorSeed: copies, not references — later edits must not alias", () => {
  const s: UserSettings = { ...DEFAULT_SETTINGS, censorDenyList: ["heck"] };
  const seed = censorSeed(s);
  seed.censorDenyList.push("extra");
  assert.deepEqual(s.censorDenyList, ["heck"]);
});

/* ------------------------------------------------------------------------- */
/* beamSizeFor — one setting, every engine                                    */
/* ------------------------------------------------------------------------- */

test("beamSizeFor: accurate keeps the engine's beam, fast decodes greedily", () => {
  // Fast is the same model with beam 1, never a different model file — the
  // packaged exe cannot ship a second model (2GB installer ceiling).
  assert.equal(beamSizeFor("accurate"), 5);
  assert.equal(beamSizeFor("accurate", 8), 8);
  assert.equal(beamSizeFor("fast"), 1);
  assert.equal(beamSizeFor("fast", 8), 1);
});

/* ------------------------------------------------------------------------- */
/* isOrphan — the deletion gate                                               */
/* ------------------------------------------------------------------------- */

const scan: OrphanScanInput = {
  referencedKeys: new Set(["videos/v1/source.mp4", "renders/r1/out.mp4"]),
  liveIds: {
    videos: new Set(["v1"]),
    clips: new Set(["c1"]),
    voiceovers: new Set(["vo1"]),
    renders: new Set(["r1"]),
  },
};

test("isOrphan: referenced keys are never orphans", () => {
  assert.equal(isOrphan("videos/v1/source.mp4", scan), false);
});

test("isOrphan: convention files of a live owner are kept", () => {
  // No column stores audio.wav or poster.jpg — the live video id protects them.
  assert.equal(isOrphan("videos/v1/audio.wav", scan), false);
  assert.equal(isOrphan("clips/c1/thumb.jpg", scan), false);
  assert.equal(isOrphan("voiceovers/vo1/take-3.wav", scan), false);
});

test("isOrphan: files of a deleted owner are orphans", () => {
  assert.equal(isOrphan("videos/gone/audio.wav", scan), true);
  assert.equal(isOrphan("clips/gone/thumb.jpg", scan), true);
  assert.equal(isOrphan("renders/gone/out.mp4", scan), true);
});

test("isOrphan: unknown folders are never deleted", () => {
  assert.equal(isOrphan("assets/a1/logo.png", scan), false);
  assert.equal(isOrphan("stray-file.bin", scan), false);
});

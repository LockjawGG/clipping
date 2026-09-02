# Clipper 1.02 beta — Editing Engine Foundation Spec (v1.3)

Status: implementation contract for Phases 2–4, reconciled after four Codex passes
(plan 24 objections → spec v1 42 → v1.1 36 → v1.2 confirmation: 3 defects + 2 blockers,
all folded into v1.3). Remaining precision items are delivered as golden test vectors in
Phase 2 code (§14), reviewed like any other code.
Owner: Fable 5.1 (apex). ⏩ = deferred to the named phase; v1 doc schema contains only
what Phases 2–4 build.

## 0. The one rule

Every creative feature is either a **new fundamental capability** (primitive, engine,
compiler) or a **configuration** of capabilities we already have (preset or recipe).
Configurations never get their own renderer. A PR adding `XyzEffect.ts` with its own
sampling or drawing for something expressible as an existing primitive + keyframes +
easing is rejected at review.

## 1. Containment and storage

Containment graph (schema invariant): `Clip 1─1 Sequence 1─* SequenceTrack 1─*
SequenceItem`; `Clip 1─* Overlay`; `Clip 1─? SubtitleConfig`; words are `TranscriptWord`
rows of the clip's video. A clip is placed once; a sequence belongs to one clip. The
**document timeline** is the sequence's output timeline; `0 ms` = clip output start.

* **One `EditDoc` per Clip**: `clips.editDocJson jsonb NULL`, `clips.editRev integer NOT
  NULL DEFAULT 0`, `clips.editCursor integer NOT NULL DEFAULT 0` (history cursor, §9).
  `NULL` doc ≡ the canonical empty document `{schemaVersion:1, owned:{}, targets:{}}` at
  rev 0; it is first persisted by the first committed batch.
* `edit_batches` — one immutable row per **committed** request:
  `id (batchId uuid) , clipId, rev (produced; = previous rev for no-op receipts),
  kind ('edit'|'undo'|'redo'|'noop'), origin ('ui'|'ai'|'recipe'), historyPos integer
  NULL (monotonic per clip, only for kind='edit'), groupId (coalescing group; = own id
  unless merged), coalesceKey text NULL, state ('active'|'undone'|'truncated'|'n/a'),
  undoesGroupId NULL, requestHash text, responseJson jsonb, registryVersion, createdAt`.
  Unique `(clipId, id)`, unique `(clipId, historyPos)`. A **group** spans
  `groupStart = min(historyPos)` … `groupEnd = max(historyPos)` of its members; state
  transitions update every member in the same statement.
* `edit_commands`: `batchId FK, batchSeq, commandJson, inverseJson (server-computed),
  schemaVersion`. Unique `(batchId, batchSeq)`. Inverses are applied in **reverse
  `batchSeq` order** (normative).
* ⏩ Phase 10/11: `edit_presets`.

## 2. Field ownership

Single writer per field, enforced on the server.

| Data | Writer in Phases 2–4 | Migrates to doc in |
|---|---|---|
| Effect stacks + keyframes | EditDoc via commands | — |
| `clips.focusTrackJson` (camera) | Focus panel REST | Phase 4b |
| `overlays.*` transform + `animationJson` | Overlay inspector REST | Phase 6 |
| `subtitle_configs.*`, `caption_word_styles` | Caption controls REST | Phase 5 |
| Sequence items/tracks | sequence-editor REST + local snapshot undo | Phase 8 |

1. `EditDoc.owned` is a typed map `{ focusTrack?: Claim; overlays?: Record<id, Claim>;
   captions?: Claim; words?: Record<id, Claim> }`, `Claim = { sinceRev; migration }`.
   A migrating phase adds the claim type, moves reader and writer together, and makes the
   legacy endpoint return `409 owned-by-editdoc` for claimed fields.
2. Databases are never shared across versions (Phase 0 isolation + DB-name guard).
3. **Legacy mutations that touch dependencies lock the clip row first** (`SELECT id FROM
   clips WHERE id=$1 FOR UPDATE`) — in Phases 2–4 that is: sequence item/track routes,
   overlay create/update/delete/reorder, transcript regeneration, clip trim. Lock order is
   always clip row → dependent rows. Anything not in this list may still race; the
   result is an inert orphan (§3), never corruption.
4. Undo scope = the doc. The legacy timeline snapshot undo stays until Phase 8.

## 3. Identities and targets

* ID namespaces: `EffectInstance.id` unique per doc; `Keyframe.id` unique per property;
  DOM/SVG element ids derived as `fx-<instanceId>`. All ids: 12-char base62,
  client-generated, validated server-side.
* Target key grammar (parser is normative; anything else → 422 `bad-target`):
  `clip` | `captions` | `item:<id>` | `overlay:<id>` | `word:<id>`; ⏩ `adj:*`, `fx:*`.
  `TargetKind` = the prefix; `EffectDefinition.targets` lists allowed kinds.
* Liveness of foreign ids is a **server precondition** (§9), never a reducer concern.
  Orphans are structurally valid and inert. `PruneOrphans` carries no payload: the server
  derives the orphan set from the dependency snapshot at execution time.

## 4. Time

* All times are **integer milliseconds** `0 ≤ atMs ≤ 86_400_000`; non-integers are
  rejected (422), not rounded. Domains:

| Target | Domain | 0 ms | On container edit |
|---|---|---|---|
| `clip`, `captions` | document timeline | clip output start | absolute |
| `item:*` | item-local displayed time (0 = `timelineStart`) | item start | head trim / rate change do not shift keyframes; keyframes past the new duration stay stored, inert |
| `overlay:*` | overlay-local (0 = `startMs`) | overlay start | move with the overlay |
| `word:*` | word-local (0 = word start in document time) | word start | move with the word |

* **Frame ↔ document ms (normative):** `frameToDocMs(frame, fps) = Math.round(frame *
  1000 / fps)`; preview `docMs = Math.round(video.currentTime * 1000)` mapped through
  `sequence/compose.ts`. Ranges are start-inclusive, end-exclusive. Test at 24/30/60 fps.
* ⏩ Split/Join (Phase 8): `SplitItem(itemId, atLocalMs, rightId)`: left keeps id; keyframes
  `< at` stay, `≥ at` move right re-based by `−at`; a sampled keyframe is inserted at `at`
  (left) and `0` (right) per animated property; transitions on the cut are removed.
  Inverse `JoinItem` restores stored pre-state.

## 5. Property and keyframe engine

```ts
type Value = number | [number, number] | string /* #rrggbb | #rrggbbaa */ | boolean;
type Ease = { kind: "linear"|"in"|"out"|"inOut" }
  | { kind: "bezier"; x1; y1; x2; y2 }                        // 0 ≤ x1,x2 ≤ 1
  | { kind: "spring"; damping: number; stiffness: number; mass?: number }
  | { kind: "bounce"|"elastic"|"overshoot"; strength?: number }; // 0 < strength ≤ 3, default 1
interface Keyframe { id; atMs; value: Value; ease?: Ease }      // ease = curve INTO this keyframe
interface AnimatableProperty { base: Value; keyframes?: Keyframe[] } // sorted by atMs, unique atMs
```

**Sampling (normative):** no keyframes → `base`. Otherwise `base` is ignored (kept for
when keyframes are removed): `t < k0.atMs` → `k0.value`; `t ≥ kn.atMs` → `kn.value`;
`t == ki.atMs` → `ki.value`; between `ki, ki+1` → `lerp(ki.value, ki+1.value,
ease(ki+1.ease ?? "out")(p))`, `p = (t − ki.atMs)/(ki+1.atMs − ki.atMs)`. One keyframe →
constant. Per kind: number/vec2 linear; color per-channel linear in sRGB + alpha;
bool/enum step at the destination keyframe. Output is **clamped to `ParamSpec` bounds**
after easing.

**Easing (normative functions; golden vectors in `tests/edit-easing.test.ts`):**
`linear/in/out/inOut` = existing `EASINGS` in `anim-eval.ts`. `bezier` = CSS
cubic-bezier solved by Newton (8 iters) then bisection (tolerance 1e-6). `spring` =
existing `springProgress(p, cfg)` blended to end exactly at 1:
`s(p) = springProgress(p) · (1 − w(p)) + 1 · w(p)`, `w(p) = smoothstep(0.85, 1, p)`.
`bounce` = Penner easeOutBounce with amplitude scaled by `strength`. `elastic` =
`1 − 2^(−10p) · cos(p · π · 4.5 · strength)` (p<1), 1 at p=1. `overshoot` = easeOutBack
with `s = 1.70158 · strength`. All return exactly 0 at p=0 and 1 at p=1.

**Canonical numbers (normative):** `canon(x) = Object.is(x,-0) ? 0 : Math.round(x·1e6)/1e6`,
applied on ingest to every numeric value and easing parameter, before validation,
equality, hashing and persistence; non-finite → 422. Equality after `canon` is exact.
JSON serialization uses `JSON.stringify` on canon'd numbers (no exponent for |x| in
[1e-6, 1e21], which the budgets guarantee).

**Performance contract:** a compiled timeline per doc revision (sorted arrays, cached
bezier/spring coefficients, per-target memo), binary search lookups. Benchmark test:
worst-case fixture (256 targets, 4096 keyframes), p95 of 1000 frame resolves recorded
as a baseline file; CI fails on > 2× regression (relative budget, machine-independent).

Adapters (read-only, Phase 4): `fromFocusKeyframes`, `fromMotionKeyframes`.
`AnimTrack` adapted in Phase 5 with stagger/clause kept as explicit instance fields.

## 6. Compositor model and geometry

```
S_item(i)  = source frame of item i (main video: after the camera stage) ▷ item stack
S_video    = S_item composited over VIDEO tracks, track index 0 on top
S_clip     = S_video ▷ clip stack
S_overlays = each overlay ▷ its stack, ordered by overlay-order.ts
S_caption  = caption box ▷ captions stack; each word ▷ word stack
S_out      = S_clip ⊕ S_overlays ⊕ S_caption          (⏩ ⊕ adj:* ⊕ fx:*)
```

**Camera stage** = existing reframe (`focusTrackJson` > `focalX/Y` > face track) producing
the canvas `W × H`. Phase 4 introduces ONE canonical `sampleCamera(track, tMs) →
{ x, y, w, h }` (canvas-space crop rect, canon'd numbers) that BOTH the preview
emulation (overflow-hidden canvas, `<video>` scaled/translated) and
`focus/keyframes.ts focusToSamples` (ffmpeg) call, so parity is a single function plus a
numeric test (≤ 0.5 px). Camera parameters and layer transforms are disjoint sets.

**Layer geometry (normative, column vectors, 3×3 homogeneous, canvas pixels, origin
top-left, y down):** the layer box `B = { x, y, w, h }` is the surface's fitted rect
(clip: `{0,0,W,H}`; overlay: its fitted rect; word: glyph box). Transform params:
`anchor (ax, ay) ∈ [0,1]²`, `position (px, py)` in fractions of `W`, `scale (sx, sy)`,
`rotation θ` degrees. Per instance:

`M_i = T(px·W, py·W) · T(B.x + ax·B.w, B.y + ay·B.h) · R(θ) · S(sx, sy) · T(−(B.x + ax·B.w), −(B.y + ay·B.h))`

Stack array index 0 is the **bottom** (applied first): `M = M_{n−1} · … · M_1 · M_0`.
Numeric example (normative): `B={0,0,1080,1920}`, instance0 `scale 1.2 anchor (0.5,0.5)`,
instance1 `position (0.1, 0)`: `M0 = T(540,960)·S(1.2)·T(−540,−960) =
matrix(1.2,0,0,1.2,−108,−192)`, `M1 = T(108,0)`, `M = M1·M0 = matrix(1.2,0,0,1.2,0,−192)`.
The golden file `tests/fixtures/edit-matrix.json` is authoritative over this prose.
Non-matrix ops: `opacity` multiplies across the stack; `cssFilter` ops are emitted in
stack order (index 0 first); identity ops are elided.
**Serializer (normative):** `matrix(a,b,c,d,e,f)` from `[[a,c,e],[b,d,f],[0,0,1]]` with
canon'd numbers, `-0 → 0`, no `matrix3d`. DOM and Remotion backends call the same
function; the exact-string parity test compares its output for both.

## 7. Effect definitions, IR, backends

```ts
type VisualOp =
  | { op: "matrix"; m: Mat3 } | { op: "opacity"; a: number }
  | { op: "cssFilter"; fn: "blur"|"brightness"|"contrast"|"saturate"|"hue-rotate"|"sepia"|"grayscale"|"invert"; v: number }
  | { op: "svgFilter"; graph: SvgFilterGraph }   // ⏩ Phase 9
  | { op: "clipPath"; path: ClipPathSpec }      // ⏩ Phase 9
  | { op: "ghost"; samples; spreadMs; falloff }  // ⏩ Phase 12
type TimeOp  = …  // ⏩ Phase 8     type AudioOp = …  // ⏩ Phase 13

interface ParamSpec { key; kind: "number"|"vec2"|"color"|"enum"|"bool"; default; min?; max?; step?; options?;
  animatable: boolean; ui: { label; group: "basic"|"advanced"; control? } }
interface EffectDefinition<P> {
  id; name; category; targets: TargetKind[]; params: ParamSpec[]; version: number;
  isIdentity(p: P): boolean;
  compile(p: P, ctx: CompileCtx): { visual?: VisualOp[]; time?: TimeOp[]; audio?: AudioOp[] };
}
```

* Explicit registry `src/lib/edit/effects/index.ts`; `createRegistry(defs)` throws on
  duplicate ids. `REGISTRY_VERSION` = sha256 over the sorted list of effect `id@version`
  **and** preset `id@version@paramsHash` (the catalog is one versioned unit). Requests
  carry `registryVersion`; mismatch → 409 `registry-mismatch` (client refetches).
* Instance validation on `AddEffect` (normative): `effectVersion` must equal the
  registered version (else 422 `effect-version`); param keys must be exactly the spec's
  keys (missing → defaults filled; unknown → 422); every base/keyframe value matches the
  kind and bounds; keyframe ids unique, times sorted/unique; easing params in range. A
  stored instance whose version no longer matches (after a deploy) renders as identity
  with an Inspector warning and rejects edits until a per-effect migration exists.
* Backends: DOM (preview) and Remotion (export) share `ir-to-css.ts`. ⏩ ffmpeg backend.
* **Tier rule (executable):** `tier = "ffmpeg"` iff no enabled non-identity instance
  exists on any target (plus today's caption/overlay gates); else `"remotion"`. Shown in
  the Inspector before export.
* Foundation effect: `transform` {scaleX, scaleY, positionX, positionY, rotation,
  anchorX, anchorY, opacity}. Motion blur ⏩ Phase 12.

## 8. Document schema v1

```ts
interface EditDoc { schemaVersion: 1; owned: OwnedMap; targets: Record<TargetKey, { stack: EffectInstance[] }>;
  ext?: Record<string, unknown> }
interface EffectInstance { id; effectId; effectVersion; enabled: boolean;
  params: Record<string, AnimatableProperty>; label?: string;
  preset?: { id: string; version: number; paramsHash: string }; ext?: Record<string, unknown> }
```

* Parsing uses zod **passthrough** for docs and commands; the reducer edits by structural
  spread at each nesting level, so `ext` and unknown fields outside the mutated path
  survive (tested per command). Inside a mutated object only the named field changes.
* Budgets (UTF-8 bytes of canonical JSON, checked before write; violation 422): doc ≤ 512 KB,
  ≤ 256 targets, ≤ 64 instances/target, ≤ 512 keyframes/property, ≤ 4096 keyframes/doc,
  ≤ 200 commands/batch, expansion ≤ 500 primitives.
* Envelope (`doc-version.ts`, Phase 0): newer → read-only (409 `newer-schema`); older →
  sequential pure migrations; invalid → error, never reset.

## 9. Command protocol (the only write path to the doc)

**Primitive commands only reach the reducer.** Deterministic rules:

| Command | Payload | Rules |
|---|---|---|
| `AddEffect` | target, instance | validation §7; duplicate id 422; appends (index n) |
| `RemoveEffect` | target, instanceId | missing 422 |
| `MoveEffect` | target, instanceId, beforeId \| null | self/no change → no-op; missing 422 |
| `SetEnabled` | target, instanceId, enabled | same → no-op |
| `SetParam` | target, instanceId, key, base | kind/bounds; equal after canon → no-op; ignored by sampling while keyframes exist |
| `SetKeyframe` | target, instanceId, key, keyframe | replaces at equal atMs (keeps the existing id); non-animatable 422 |
| `RemoveKeyframe` | target, instanceId, key, keyframeId | missing 422 |
| `MoveKeyframe` | target, instanceId, key, keyframeId, atMs, value? | collision 422 |
| `PruneOrphans` | — | server-derived key set; no-op when empty |

* `ApplyPreset` is a **client-side expansion** from the versioned catalog into
  `AddEffect` primitives (preset-local keyframes shifted by `atMs`, `preset` provenance
  `{ id, version, paramsHash }` where `paramsHash` = sha256 of canonical JSON of the
  preset's `instances` field at that version). The batch carries `provenance: { presetId,
  version }` for the audit row. **Server validation:** any instance carrying `preset`
  must reference a preset in the current catalog whose `version` and `paramsHash` match
  exactly (else 422 `preset-provenance`); the server never trusts client provenance.
  ⏩ Recipes (Phase 11) expand server-side.
* **Face Zoom is removed from Phases 2–4** (⏩ Phase 14: an adapter command carries the
  resolved anchor keyframes plus the tracking artifact `{trackId, version}`).
* `foreignDependencies(cmd)` (normative): the ids embedded in `target` only. Preset data
  and `ext` never contribute.
* **Dependency snapshot:** `depsHash` = sha256 of canonical JSON of
  `{ items: [{id, timelineStart, sourceIn, sourceOut, order, rate}] sorted by id,
  overlays: [{id, startMs, endMs}] sorted by id, transcriptId, transcriptUpdatedAt }`
  produced by one function in `sequence/compose.ts`. `GET` returns it; every request
  carries the value it last saw. Commands whose target ids are not in the snapshot →
  422 `unknown-target` (except `PruneOrphans`, which is exempt by construction).
* **Transaction (normative):** lock clip row → if `batchId` exists: `requestHash` equal →
  return stored `responseJson`; different → 409 `batch-reused` → `registryVersion`,
  `expectedRev`, `depsHash` checks (409 codes above) → apply commands in order with the
  reducer → if every command was a no-op: insert a `kind:'noop'` receipt at the current
  rev, no history entry, return `{ rev, doc, noop: true }` → else budgets → write doc,
  `rev+1`, `historyPos = max+1`, `groupId` (§ coalescing), truncate redo branch
  (`state:'truncated'` for every `undone` batch with `historyPos > cursor`), set
  `editCursor = historyPos` → insert batch + commands (inverses server-computed) → commit.
  `requestHash` = sha256 of canonical JSON of `{ commands, origin, coalesceKey,
  expectedRev, depsHash, registryVersion }`. Idempotency is guaranteed for committed
  requests only; rejected requests are logged, never stored.
* **Coalescing:** every request is its own immutable batch and revision, with its
  `coalesceKey` stored on the row. Inside the transaction the new batch joins the
  previous batch's `groupId` iff: the previous *edit* batch `P` is the **active tip**
  (`P.state='active'`, `P.historyPos = editCursor = max(historyPos)`, no batch of any
  kind committed after it), `P.coalesceKey = request.coalesceKey ≠ NULL`, and
  `now − P.createdAt ≤ 300 ms`. An intervening undo/redo/noop/other-key batch always
  closes the group. History operates on **groups**: one Inspector-visible step, undone in
  one go (members newest first, each in reverse `batchSeq`).
* **Undo (server, normative):** lock clip → group `G` = the active edit group with the
  largest `groupEnd ≤ editCursor` → none → 409 `nothing-to-undo` → apply its inverses →
  write doc, `rev+1` → insert batch `kind:'undo', undoesGroupId=G, historyPos NULL` →
  mark all members of `G` `undone` → `editCursor = groupEnd` of the preceding active
  group (0 if none). **Redo:** group `R` = the `undone` group with the smallest
  `groupStart > editCursor` → none → 409 `nothing-to-redo` → re-apply its commands
  (members oldest first, forward `batchSeq`) → `rev+1` → batch `kind:'redo'` → mark
  all members `active` → `editCursor = R.groupEnd`. Control batches (`undo`/`redo`/
  `noop`) have `historyPos NULL` and never enter the cursor's history, so consecutive
  undos walk back through edits, never through undos. AI batches are ordinary groups.
* **Idempotent control operations:** undo/redo requests carry a client `batchId` and
  `expectedRev`; `requestHash` = sha256 of `{ op, expectedRev, expectedCursor }`. A
  retry with the same `batchId` and hash returns the stored `responseJson`; a different
  hash → 409 `batch-reused`; `expectedRev`/`expectedCursor` mismatch → 409 with the
  current `{ rev, cursor }`. A lost response can therefore never undo twice.
* Endpoints: `GET /api/clips/:id/edit` → `{ doc, rev, cursor, depsHash, registryVersion,
  readOnly, tier, canUndo, canRedo }`; `POST …/edit/commands`; `POST …/edit/undo`;
  `POST …/edit/redo` (both `{ batchId, expectedRev, expectedCursor }`).
  No snapshot PUT, no import in Phases 2–4. Existing per-user clip ownership check on
  every endpoint.
* Client `EditSession` (`src/lib/edit/session.ts`, no React): optimistic apply with the
  shared reducer; ordered outbound queue; local pre-merge only of unsent commands with one
  base revision and one key. On 409 it refreshes `{doc, rev, depsHash, registryVersion}`,
  re-validates queued commands against the new doc (ids present, kinds/bounds ok) and
  resends; commands that no longer apply surface as "couldn't apply: …" with
  retry/discard. Nothing queued is dropped silently.

## 10. Presets (data only)

```ts
interface PresetDefinition { id; version; name; category; targets: TargetKind[];
  instances: Array<{ effectId; params: Record<string, AnimatableProperty> }>; // preset-local ms ≥ 0
  durationMs; ui: { thumbnail: ThumbnailSpec; customize: string[] }; sfx?: SfxRef }
```

Preset-local `0` = apply time in the target's domain; `base` copied as-is; keyframes
shifted by `atMs`. Save-as-preset normalizes the earliest keyframe to `0`. Phase 4 ships
one data file: Punch In/Out, Slow Push/Pull, Impact, Snap, Smooth, Micro, Comedic,
Extreme. ⏩ Face Zoom (14), recipes (11), procedural seeds (12), tracking refs (14).

## 11. AI and training

* AI edits are `POST …/edit/commands` with `origin:"ai"`; capability discovery via
  read-only `GET /api/edit/catalog` (effects, presets, param specs, `registryVersion`).
* ⏩ Phase 16: training stores the final doc, a state diff from the approved baseline, and
  provenance (preset ids+versions, deviations from defaults). No command subtraction.
  Word payloads carry ids, not text. Each `Render` records `{ schemaVersion,
  registryVersion, buildSha, tier, ffmpegVersion, browserVersion }` in its metadata JSON.

## 12. Parity and testing (acceptance for the vertical slice)

1. Reducer: inverse property test per command; unknown-field preservation per command;
   dependent chain add→set→move→remove undone in reverse order; budgets.
2. Server: idempotent retry returns the stored response; `batch-reused`; `expectedRev`,
   `depsHash`, `registryVersion` conflicts; undo twice walks back two edits; redo after a
   new edit is refused (truncated); AI batch undone by the user; coalesced group undone
   as one step; no-op receipt does not bump rev.
3. Session: queue survives a 409 and re-applies; pre-merge only within one base rev.
4. Resolver: snapshot of resolved matrices at 5 sample times per preset incl. easing
   extrema; easing golden vectors; compiled-timeline benchmark baseline.
5. Geometry parity (primary, exact): DOM and Remotion backends emit identical
   `matrix(...)` strings from the same resolved state, including non-square media and
   non-centered anchors (golden file `tests/fixtures/edit-matrix.json`). Camera: preview
   crop rect equals ffmpeg's from the single `sampleCamera` (≤ 0.5 px).
6. Temporal parity: `frameToDocMs` fixtures at 24/30/60 fps and range boundaries.
7. Pixel parity (secondary, env-gated on the Remotion browser): stills of preview markup
   vs `CaptionedClip` at boundaries and easing extrema, block-SSIM ≥ 0.98 inside the
   layer's region mask, at 1× and 2× DPR.
8. ffmpeg-only clips export unchanged from 1.01 (tier test + existing pipeline tests).
9. Debug inspector (`?debug=1`): target key, stack, keyframes, rev, cursor, depsHash,
   last batch, tier, schema/registry versions, build SHA.

## 13. Phase 2–4 vertical slice — definition of done

Zoom preset "Punch In" on a clip: click card → expanded `AddEffect` batch → instance with
scale keyframes on the `clip` stack → preview shows it (camera stage emulated + layer
matrix) → Customize edits params, diamonds create keyframes → server undo/redo → reload
restores → a script POSTs the same expansion with `origin:"ai"` and the user undoes it →
Remotion export passes §12.5–7 → clips without effects still take the ffmpeg path.

## 14. Golden vectors delivered as code in Phase 2 (not prose)

`tests/fixtures/edit-easing.json` (each ease kind at p = 0, .1, …, 1), `edit-matrix.json`
(§6 convention incl. the two-instance example), `edit-sampling.json` (before/at/after/
between, one keyframe, clamping), `edit-canon.json` (−0, 1e-7, 0.1+0.2), `edit-deps.json`
(depsHash inputs → hash), `edit-history.json` (apply/undo/redo/truncate sequences →
cursor and states). These files are the normative source for the items Codex flagged as
"precision"; the spec text yields to them.

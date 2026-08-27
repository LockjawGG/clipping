# Clipper

An AI video clipping app, built up in stages. The data model, the provider
boundary, and the three algorithms that everything downstream depends on being
correct came first and are covered by tests. A Next.js scaffold is now wired on
top; the upload flow, editors, and render pipeline land in later PRs.

## What is here

| Path | Status |
| --- | --- |
| `prisma/schema.prisma` | Complete schema — users, projects, videos, transcripts, segments, words, clips, subtitle configs, overlays, renders, jobs |
| `src/lib/providers/types.ts` | Provider interfaces for transcription, storage, and clip analysis |
| `src/lib/captions/layout.ts` | Word timings → non-overlapping cues, line breaking, SRT output |
| `src/lib/clips/boundaries.ts` | Sentence snapping, overlap dedupe, runtime cap |
| `src/lib/ffmpeg/args.ts` | argv construction for probe, audio extract, cut, reframe, thumbnail |
| `src/lib/env.ts` | Lazily-validated runtime configuration (zod) |
| `src/lib/db.ts` | PrismaClient singleton |
| `src/lib/storage/` | `StorageProvider` implementations: local disk + S3-compatible (AWS / R2 / MinIO), with a `getStorage()` factory and HMAC-signed URLs for the local backend |
| `src/lib/transcription/` | `TranscriptionProvider` implementations: `whisper-local` (CLI), OpenAI, Deepgram, behind a `getTranscription()` factory. Pure `parseX` functions normalise each provider's response to integer-ms segments + words |
| `src/lib/analysis/` | `AnalysisProvider` implementations: Anthropic (official SDK), OpenAI, and a no-LLM `heuristic` baseline, behind `getAnalysis()`. `refineSuggestions()` runs raw picks through `snapToSentences → dedupeOverlapping → capTotalRuntime` |
| `src/lib/jobs/` | Job worker runtime: `JobWorker` polls `Job(status, runAfter)`, claims rows with a compare-and-swap, dispatches to a per-`kind` handler map, retries with exponential backoff + jitter. `createPrismaJobStore` / `enqueueJob` bind it to the DB |
| `src/lib/ffmpeg/run.ts` | `FfmpegRunner` — runs the `args.ts` argv through the real binaries (`shell: false`): `probe` / `extractAudio` / `cut` / `reframe`. `parseProbeOutput` normalises ffprobe JSON to `MediaInfo` |
| `src/lib/pipeline/` | `PROBE → EXTRACT_AUDIO → TRANSCRIBE → ANALYZE → THUMBNAIL` (each step enqueues the next) plus `RENDER` (cut → reframe to aspect → captions: static presets burn an SRT with ffmpeg, animated ones composite via Remotion → upload). `THUMBNAIL` grabs a poster frame at each clip's midpoint. Narrow repo interfaces in `deps.ts`; Prisma impls + `buildPipelineDeps()` in `repos.ts` |
| `src/lib/captions/presets.ts` | `CaptionAnimation` presets — `isAnimatedPreset` decides ffmpeg-burn vs Remotion; `remotionPreset` maps to the composition string |
| `remotion/` | Remotion project (`CaptionedClip` composition) — word-timed caption presets (word-by-word / pop / scale / bounce / fade / karaoke) over the reframed clip. `src/lib/pipeline/remotion.ts` drives it via `@remotion/{bundler,renderer}` (dynamic `import()`, so it never enters the Next bundle) |
| `scripts/worker.ts` | `npm run worker` — the long-running ingest worker |
| `src/lib/api/` | Upload flow (`createVideoUpload` → presigned PUT, `confirmUpload` → enqueue `PROBE`, `getVideoStatus`), clip actions (`requestRender`, `listVideoClips`, `updateClip`, `deleteClip`, `createManualClip` — snapped via `snapToSentences`, `upsertCaptionConfig` / `deleteCaptionConfig`), an `ApiError`/Zod → JSON `route()` wrapper, and the token-guarded local-storage file route |
| `src/app/api/` | `videos` + `/videos/:id/{ingest,clips}`, `PATCH`/`DELETE /api/clips/:id`, `PUT`/`DELETE /api/clips/:id/captions`, `POST /api/clips/:id/{render,thumbnail}`, `GET`/`PUT /api/storage/local/[...key]`, `/api/auth/{register,[...nextauth]}` — thin shells over `src/lib` |
| `src/lib/auth/` | NextAuth v5, Credentials + JWT sessions. `config.edge.ts` (db-free, for `middleware.ts`) is spread into the full config in `index.ts`. `password.ts` (bcrypt), `session.ts` (`requireUserId`, `getOrCreateProject`) |
| `src/app/` | App Router — landing, `/login`, `/register`, `/dashboard` (video list + upload), `/dashboard/[videoId]` (per-clip editor: boundaries, aspect, focal point, accept, caption preset/animation/colours, render, delete; add-a-clip form; read-only transcript), root layout, Tailwind. `middleware.ts` gates `/dashboard` |
| `tests/core.test.ts` | 33 unit tests |
| `tests/storage.test.ts` | 10 unit tests — key safety, URL signing, local round-trip |
| `tests/transcription.test.ts` | 10 unit tests — response parsing for each provider, ms normalisation |
| `tests/analysis.test.ts` | 10 unit tests — prompt/tool parsing, the refine pipeline, the heuristic scorer |
| `tests/jobs.test.ts` | 9 unit tests — backoff, claim/retry/fail state machine, concurrency, graceful stop |
| `tests/ffmpeg-run.test.ts` | 4 unit tests — ffprobe JSON → `MediaInfo` |
| `tests/pipeline.test.ts` | 7 unit tests — each ingest handler + the full chain, against fake deps |
| `tests/render.test.ts` | 8 unit tests — the RENDER handler: cut/reframe/probe/upload, static SRT burn vs Remotion composite, no-words fallback, failure → `Render` FAILED |
| `tests/thumbnail.test.ts` | 3 unit tests — the THUMBNAIL handler: single clip, whole video (one download), no-op |
| `tests/presets.test.ts` | 2 unit tests — `isAnimatedPreset` / `remotionPreset` |
| `tests/api.test.ts` | 11 unit tests — upload schema, the video service (incl. cross-project 404), local-route token auth |
| `tests/clips-api.test.ts` | 18 unit tests — `requestRender`, `requestClipThumbnail`, `updateClip`, `deleteClip`, `createManualClip`, `upsertCaptionConfig` / `deleteCaptionConfig`, `listVideoClips`; all with ownership 404s |
| `tests/auth.test.ts` | 6 unit tests — bcrypt hash/verify, the credential + register schemas |
| `tests/ffmpeg.integration.ts` | 6 checks against the real ffmpeg binary |
| `.env.example` | Provider configuration |

## What is not here yet

Transcript-text editing (the view is read-only — editing would have to keep the
word timings in sync) and face detection. See "Continuing the build" below.

The Remotion render path (`bundle()` + `renderMedia()`) type-checks and its
wiring is unit-tested, but it needs a headless Chromium (`@remotion/renderer`
fetches one on first run) and has not been executed end to end here.

## Setup

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # DATABASE_URL is required; NEXTAUTH_SECRET too if
                            # STORAGE_PROVIDER=local (it signs the file URLs)
npm run prisma:migrate      # create / update the schema in your database
npm run dev                 # http://localhost:3000
npm run worker              # in a second terminal: the ingest job worker
```

Register at `/register`, then upload from `/dashboard`. Re-run
`npm run prisma:migrate` after pulling — recent changes add `User.passwordHash`
and `Clip.thumbnailKey`.

`npm run build` runs `prisma generate` then `next build`. `npm run typecheck`
expects a prior `npm run build` (or `npm run dev`) so Next's generated types
exist.

## Running the tests

The unit suites run straight from Node 22+ with no build step:

```bash
npm test                                                      # tests/*.test.ts
node --experimental-strip-types tests/ffmpeg.integration.ts   # needs ffmpeg on PATH
```

`src/lib` stays free of TypeScript constructs the strip-only loader can't handle
(no parameter properties, enums, or namespaces) so the suites keep working
without a transform step.

Integration results on a synthetic 1280x720 source: cut accurate to 17ms,
9:16 reframe with burned captions produces 1080x1920, shell metacharacters in
filenames never reach a shell.

## Decisions worth keeping

**Milliseconds as integers, never float seconds.** Float seconds accumulate
rounding error across cut → re-cut → render, and cues drift off the audio.

**Words in their own table.** Karaoke and word-highlight captions can't be driven
from sentence-level rows.

**No stream copy for cuts.** `-c copy` snaps the in-point to the nearest keyframe
and silently shifts the cut by up to several seconds. `-ss` before `-i` with
re-encoding is fast *and* accurate; `buildCutArgs` doesn't offer a copy path.

**Subtitles burn after reframing.** Burning first means `MarginV` is measured
against the pre-pad height and the text lands in the letterbox bar.

**Short cues extend to the neighbour's start, not to a fixed minimum.** Clamping
without checking the next cue produces overlapping cues, which libass renders as
stacked text.

**argv arrays, never command strings.** `execFile`/`spawn` with `shell: false`.
There is no quoting layer to get wrong because there is no shell. Paths handed to
ffmpeg are server-generated storage keys; `assertSafePath` enforces that
invariant rather than trying to sanitise hostile input.

**One place user input reaches a parser.** The `subtitles=` filtergraph value has
escaping rules independent of the shell — colons, commas, brackets, backslashes.
`escapeFilterPath` handles it.

## Continuing the build

Order that avoids rework:

1. ~~`npm install` the stack, `prisma migrate dev`~~ &mdash; Next.js scaffold done
2. ~~Providers against the interfaces in `types.ts`: storage, transcription,
   analysis~~ done. The analysis output goes through `refineSuggestions`
   (`snapToSentences` → `dedupeOverlapping` → `capTotalRuntime`) — never trust
   raw model timestamps.
3. ~~Job worker polling `Job` on `(status, runAfter)` with backoff~~ done
4. ~~probe → extract audio → transcribe → analyze pipeline~~ done
   (`src/lib/pipeline/`)
5. ~~Upload API + the local-storage file route~~ done
6. ~~Auth (NextAuth) + the dashboard~~ done
7. ~~`RENDER` handler + clip-render UI~~ done
8. ~~Clip editor (boundaries / aspect / focal point / manual clips)~~ done
9. ~~Remotion for animated captions~~ + ~~caption-preset picker~~ done
   (`remotion/`, `PUT /api/clips/:id/captions`, `CaptionControls`)
10. ~~`THUMBNAIL` handler~~ done (`thumbnailHandler`, `Clip.thumbnailKey`,
    `POST /api/clips/:id/thumbnail`)
11. Face detection, and an end-to-end run against real Postgres + ffmpeg +
    Chromium

Remotion replaces the `subtitles=` burn for animated presets — `buildCues` output
feeds Remotion directly, since cues carry word arrays. Keep the ffmpeg path for
the static presets; it's an order of magnitude faster.

## Limitations

- Face detection for smart cropping is not implemented. `buildReframeArgs` takes
  a static focal point; dynamic speaker tracking needs a detection pass emitting
  a focal-point track, and a `sendcmd` filter or per-segment renders.
- `Clip.removedWordIds` is modelled but no renderer consumes it. Cutting interior
  spans means splitting into N segments and concatenating.
- Transcription confidence is stored but not yet enforced as a render gate.

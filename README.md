# Clipper

[![CI](https://github.com/LockjawGG/clipping/actions/workflows/ci.yml/badge.svg)](https://github.com/LockjawGG/clipping/actions/workflows/ci.yml)

An AI video clipping app, built up in stages: upload a long video, it gets
probed, transcribed, and analysed into short vertical clips with burned-in or
animated captions, editable in a dashboard before rendering.

Each clip can then be worked on: its transcript corrected in place, words
censored in the captions and the audio independently, narration generated
locally and anchored to the transcript, images and text laid over it, and the
clip itself cut into pieces on a timeline whose layers can be rearranged.

## What is here

| Path | Status |
| --- | --- |
| `.github/workflows/ci.yml` | GitHub Actions — `build → typecheck → lint → test`, plus a job running `test:integration` against apt-installed ffmpeg, on the fixture that suite builds for itself |
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
| `src/lib/jobs/` | Job worker runtime: `JobWorker` polls `Job(status, runAfter)`, claims rows with a compare-and-swap, dispatches to a per-`kind` handler map, retries with exponential backoff + jitter. A running job heartbeats its row; `reclaimStale` requeues jobs left in `PROCESSING` past the lease by a crashed worker; a `cleanup(job)` hook fires when each job settles. `createPrismaJobStore` / `enqueueJob` bind it to the DB |
| `src/lib/ffmpeg/run.ts` | `FfmpegRunner` — runs the `args.ts` argv through the real binaries (`shell: false`): `probe` / `extractAudio` / `cut` / `concat` / `layerVideo` / `reframe` / `reframeTracked` / `reframeZoom` / `censorAudio` / `mixVoiceover` / `composeOverlays` / `toneWav` / `trimSilence` / `thumbnail`. `parseProbeOutput` normalises ffprobe JSON to `MediaInfo` |
| `src/lib/faces/` | `FaceDetector` interface + `NullFaceDetector` (the default — no detection); `track.ts` smooths / resamples / interpolates a focal-point track. Plug a real detector into `buildPipelineDeps` |
| `src/lib/ffmpeg/track-crop.ts` | `focalTrackToCropExpr` — turns a focal track into piecewise-`lerp` ffmpeg `crop` x/y expressions so the crop window pans to follow the subject |
| `src/lib/pipeline/` | The job handlers. Ingest is `[FETCH →] PROBE → EXTRACT_AUDIO → TRANSCRIBE → AUDIO_FEATURES → ANALYZE → THUMBNAIL`, each step enqueueing the next. Alongside it: `RENDER` (compose the clip's timeline → censor audio → mix voiceover → reframe → captions: static presets burn an SRT with ffmpeg, animated ones composite via Remotion → upload), `TRANSLATE`, `WORKER_RUN` (suggest clips from audio + transcript), `VOICEOVER` (synthesise narration), and `LIVE_TRANSCRIBE` / `LIVE_FINALIZE` for browser recordings. `FsSourceCache` (`source-cache.ts`) keeps one `<TEMP_DIR>/videos/<id>/source` copy that every step reuses; per-job scratch lives under `<TEMP_DIR>/work/<jobId>/` and the worker deletes it when the job ends. Narrow repo interfaces in `deps.ts`; Prisma impls + `buildPipelineDeps()` in `repos.ts` |
| `src/lib/sequence/cuts.ts` | Interior cuts — words struck out of the middle of a clip. `cutSpansForWords` turns word ids into stretches of source to drop (taking half the silence either side, capped, so the seam sounds like an ordinary word gap); `applyInteriorCuts` splits a compose plan around them and repacks; `remapAcrossCuts` moves anything positioned against the old timeline. Expressing it as a plan transform is what makes captions, censor spans and voiceover anchors follow it for free |
| `src/lib/captions/presets.ts` | `CaptionAnimation` presets — `isAnimatedPreset` decides ffmpeg-burn vs Remotion; `remotionPreset` maps to the composition string |
| `remotion/` | Remotion project (`CaptionedClip` composition) — word-timed caption presets (word-by-word / pop / scale / bounce / fade / karaoke) over the reframed clip. `src/lib/pipeline/remotion.ts` drives it via `@remotion/{bundler,renderer}` (dynamic `import()`, so it never enters the Next bundle) |
| `scripts/worker.ts` | `npm run worker` — the long-running ingest worker |
| `src/lib/api/` | Upload flow (`createVideoUpload` → presigned PUT, `confirmUpload` → enqueue `PROBE`, `getVideoStatus`), clip actions (`requestRender`, `listVideoClips`, `updateClip`, `deleteClip`, `createManualClip` — snapped via `snapToSentences`, `upsertCaptionConfig` / `deleteCaptionConfig`), an `ApiError`/Zod → JSON `route()` wrapper, and the token-guarded local-storage file route |
| `src/app/api/` | `videos` + `/videos/from-url` + `/videos/:id/{ingest,clips}`, `PATCH`/`DELETE /api/clips/:id`, `PUT`/`DELETE /api/clips/:id/captions`, `POST /api/clips/:id/{render,thumbnail}`, `GET`/`PUT /api/storage/local/[...key]`, `/api/auth/{register,[...nextauth]}` — thin shells over `src/lib` |
| `src/lib/auth/` | NextAuth v5, Credentials + JWT sessions. `config.edge.ts` (db-free, for `middleware.ts`) is spread into the full config in `index.ts`. `password.ts` (bcrypt), `session.ts` (`requireUserId`, `getOrCreateProject`) |
| `src/app/` | App Router — landing, `/login`, `/register`, and a single `/dashboard` workspace: projects and saved clips on the left, the active video's clips in the centre, uploads on the right. Per clip: boundaries, aspect, focal point / capture window, caption style and animation, overlays and text elements, an editable transcript (double-click a word to fix it, or strike words out to cut them from the middle and close the clip up), censoring, voiceover, and a non-linear timeline. `middleware.ts` gates `/dashboard` |
| `tests/*.test.ts` | 639 unit tests across 41 suites, run with no build step. The largest: `render.test.ts` (59), `core.test.ts` (51), `censor.test.ts` (44), `overlays.test.ts` (30), `element-anim.test.ts` (27), `live.test.ts` (27). Everything is exercised against fake deps — the pipeline handlers, the ffmpeg argv builders, caption layout and styling, censoring, the timeline, learning, voiceover, storage, auth, and each API service with its ownership 404s |
| `tests/ffmpeg.integration.ts` | 10 checks against the real ffmpeg binary, on a fixture it synthesises itself (colour bars + a 440 Hz tone) so a drift or a level is the code's doing |
| `.env.example` | Provider configuration |

## What is not here yet

A real `FaceDetector` — the track-following crop is wired end to end but the
shipped detector (`NullFaceDetector`) returns nothing, so RENDER falls back to a
static centre crop until one is plugged in. See "Continuing the build" below.

Live recording is only exercised through its recovery path: a session whose
browser never sent Stop is reassembled from its fragments by the live sweep,
which is verified, but an actual in-browser capture needs a camera and has not
been driven here.

## Setup

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # DATABASE_URL is required; NEXTAUTH_SECRET too if
                            # STORAGE_PROVIDER=local (it signs the file URLs)
npm run prisma:migrate      # create / update the schema in your database
npm run dev                 # http://localhost:3000
npm run worker              # in a second terminal: the ingest job worker
```

Register at `/register`, then upload a file or paste a link from `/dashboard`.
The "add from link" flow needs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on
PATH (or set `YTDLP_PATH`). Re-run `npm run prisma:migrate` after pulling; the
schema has grown a lot (censoring, sequences, overlays, voiceovers, worker runs,
style profiles).

Voiceover needs [Piper](https://github.com/rhasspy/piper) on PATH (or
`PIPER_BINARY`) and at least one voice model in `PIPER_VOICE_DIR` (default
`./.voices`, gitignored). Without them the panel says so and stays disabled.

`npm run build` runs `prisma generate` then `next build`. `npm run typecheck`
expects a prior `npm run build` (or `npm run dev`) so Next's generated types
exist — CI (`.github/workflows/ci.yml`) runs the steps in that order:
`build → typecheck → lint → test`, with a separate job for
`test:integration` against a real ffmpeg.

## Running the tests

The unit suites run straight from Node 22+ with no build step:

```bash
npm test                                                      # tests/*.test.ts
node --experimental-strip-types tests/ffmpeg.integration.ts   # needs ffmpeg on PATH
```

`src/lib` stays free of TypeScript constructs the strip-only loader can't handle
(no parameter properties, enums, or namespaces) so the suites keep working
without a transform step.

Integration results on the synthetic 1280x720 source it builds: cut accurate to
17ms, 9:16 reframe with burned captions produces 1080x1920, two cuts concatenate
to exactly their combined length, a layer composites over a base without
truncating it, per-span censoring emits the right tone for each span while
leaving the clip's length alone, and shell metacharacters in filenames never
reach a shell.

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
11. ~~Face-tracking crop~~ scaffolded (`src/lib/faces/`, `reframeTracked`,
    `focalTrackToCropExpr`) — still needs a real `FaceDetector` implementation
12. ~~Ingest from a link~~ done (`FETCH` handler, `yt-dlp`,
    `POST /api/videos/from-url`, dashboard link form)
13. ~~End-to-end run against real Postgres + ffmpeg~~ done — every job kind has
    now been run against Neon Postgres, local storage, and ffmpeg on Windows:
    the ingest chain (`PROBE → EXTRACT_AUDIO → TRANSCRIBE → AUDIO_FEATURES →
    ANALYZE`), `RENDER` on both the ffmpeg and Remotion paths, `THUMBNAIL`,
    `TRANSLATE`, `WORKER_RUN`, `VOICEOVER`, and `LIVE_FINALIZE` via the sweep.
    Transcription runs locally through `whisper-local`; Remotion renders through
    the Chromium `@remotion/renderer` fetches on first run.
14. ~~Worker robustness~~ done — one cached source copy per video reused across
    steps (was re-downloading the full file every step), per-job scratch dir
    deleted when the job settles (was leaking GBs of temp copies), `reclaimStale`
    requeues jobs orphaned in `PROCESSING` by a killed worker, and a duplicate
    render request returns the in-flight `Render` instead of stacking a job.

Remotion replaces the `subtitles=` burn for animated presets — `buildCues` output
feeds Remotion directly, since cues carry word arrays. Keep the ffmpeg path for
the static presets; it's an order of magnitude faster.

## Limitations

- Face-tracking crop is wired but has no detector. The pipeline calls
  `FaceDetector.detectTrack` when a clip has no manual focal point; the shipped
  `NullFaceDetector` returns nothing, so it falls back to a static centre crop.
  A real detector (MediaPipe, a face-api model, an OpenCV pass) drops into
  `buildPipelineDeps`.
- Overlay windows are positions in the finished export. They are moved back by
  an interior cut, so a badge stays on its moment, but they do not follow a
  *reorder* of timeline pieces the way captions and censoring do. That is the
  usual convention for a graphics layer, but the two behaviours differ and
  nothing in the UI says so.
- Transcription confidence is stored but not yet enforced as a render gate.

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
| `src/app/` | Next.js App Router — landing page, root layout, Tailwind |
| `tests/core.test.ts` | 33 unit tests |
| `tests/storage.test.ts` | 10 unit tests — key safety, URL signing, local round-trip |
| `tests/transcription.test.ts` | 10 unit tests — response parsing for each provider, ms normalisation |
| `tests/ffmpeg.integration.ts` | 6 checks against the real ffmpeg binary |
| `.env.example` | Provider configuration |

## What is not here yet

The analysis provider, queue workers, API routes, the upload pipeline, auth,
the dashboard, the transcript and clip editors, Remotion animated captions, and
face detection. See "Continuing the build" below.

## Setup

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # DATABASE_URL is required; NEXTAUTH_SECRET too if
                            # STORAGE_PROVIDER=local (it signs the file URLs)
npm run prisma:migrate      # create the schema in your database
npm run dev                 # http://localhost:3000
```

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
2. Providers against the interfaces in `types.ts`: ~~storage~~ done,
   ~~transcription (Whisper / Deepgram / OpenAI)~~ done, then analysis (Anthropic)
3. Job worker polling `Job` on `(status, runAfter)` with backoff
4. Upload → probe → extract audio → transcribe pipeline
5. Analysis provider; feed output through `snapToSentences` → `dedupeOverlapping`
   → `capTotalRuntime` before persisting. Never trust raw model timestamps.
6. UI, then Remotion for animated captions

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

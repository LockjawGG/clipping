# Clipper — core foundation

Partial implementation of an AI video clipping app. This is **not** the finished
application described in the spec. It is the subset that could be built and
verified without network access: the data model, the provider boundary, and the
three algorithms that everything downstream depends on being correct.

## What is here

| Path | Status |
| --- | --- |
| `prisma/schema.prisma` | Complete schema — users, projects, videos, transcripts, segments, words, clips, subtitle configs, overlays, renders, jobs |
| `src/lib/providers/types.ts` | Provider interfaces for transcription, storage, and clip analysis |
| `src/lib/captions/layout.ts` | Word timings → non-overlapping cues, line breaking, SRT output |
| `src/lib/clips/boundaries.ts` | Sentence snapping, overlap dedupe, runtime cap |
| `src/lib/ffmpeg/args.ts` | argv construction for probe, audio extract, cut, reframe, thumbnail |
| `tests/core.test.ts` | 33 unit tests |
| `tests/ffmpeg.integration.ts` | 6 checks against the real ffmpeg binary |
| `.env.example` | Provider configuration |

## What is not here

Everything else in the spec: Next.js app, React UI, dashboard, landing page,
auth, upload flow, transcript UI, clip editor, Remotion animated captions, face
detection, queue workers, API routes, concrete provider implementations.

## Running the tests

```bash
node --experimental-strip-types --test tests/core.test.ts
node --experimental-strip-types tests/ffmpeg.integration.ts   # needs ffmpeg on PATH
```

Both pass with no dependencies installed. Node 22+.

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

1. `npm install` the stack, `prisma migrate dev`
2. Storage + transcription providers against the interfaces in `types.ts`
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

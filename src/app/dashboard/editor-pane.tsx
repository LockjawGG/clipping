import { ClipEditor, type ClipData } from "./[videoId]/clip-editor";
import { ClipComposer } from "./[videoId]/clip-composer";
import { WorkerPanel } from "./[videoId]/worker-panel";
import type { TranscriptRow, WordStyle } from "./[videoId]/editable-transcript";
import type { PreviewWord } from "./[videoId]/clip-player";
import type { OverlayView } from "./[videoId]/overlay-panel";
import type { ClipPlan } from "@/lib/api/sequence.ts";

export interface EditorVideo {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
  /** Language of the current transcript (ISO code), or null before one exists. */
  transcriptLanguage: string | null;
}

function timecode(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const STATUS_TONE: Record<string, string> = {
  READY: "border-accent/40 text-accent",
  FAILED: "border-danger/40 text-danger",
};

export interface TranscriptView {
  /** "" for the source transcription, or the language code of a translation. */
  translatedTo: string;
  language: string;
}

export function EditorPane({
  video,
  sourceUrl,
  clips,
  wordsByClip,
  plansByClip,
  transcriptByClip,
  segments,
  overlaysByClip,
  wordStylesByClip,
  projects,
  transcriptViews,
  selectedTranscript,
}: {
  video: EditorVideo;
  sourceUrl: string;
  clips: ClipData[];
  wordsByClip: Record<string, PreviewWord[]>;
  /** Each clip's timeline, as pieces the preview can play. */
  plansByClip: Record<string, ClipPlan>;
  transcriptByClip: Record<string, TranscriptRow[]>;
  /** Every segment of the video, for the New-clip form's snap preview. */
  segments: TranscriptRow[];
  overlaysByClip: Record<string, OverlayView[]>;
  wordStylesByClip: Record<string, Record<string, WordStyle>>;
  projects: Array<{ id: string; name: string }>;
  transcriptViews: TranscriptView[];
  selectedTranscript: string;
}) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{video.name}</h1>
        <span className={`pill ${STATUS_TONE[video.status] ?? ""}`}>
          {video.status.toLowerCase()}
        </span>
        {video.durationMs ? (
          <span className="font-mono text-sm tabular-nums text-muted">
            {timecode(video.durationMs)}
          </span>
        ) : null}
      </header>

      <section className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Clips</h2>
          <span className="text-sm text-muted">{clips.length} total</span>
        </div>
        {clips.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-muted">
            No clips yet — they appear once transcription and analysis finish. Add one below.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {clips.map((c, i) => (
              <div key={c.id} id={`clip-${c.id}`} className="scroll-mt-6">
                <ClipEditor
                  clip={c}
                  videoId={video.id}
                  transcriptViews={transcriptViews}
                  selectedTranscript={selectedTranscript}
                  sourceUrl={sourceUrl}
                  words={wordsByClip[c.id] ?? []}
                  plan={plansByClip[c.id] ?? null}
                  transcript={transcriptByClip[c.id] ?? []}
                  overlays={overlaysByClip[c.id] ?? []}
                  wordStyles={wordStylesByClip[c.id] ?? {}}
                  projects={projects}
                  defaultTimelineOpen={i === 0}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <WorkerPanel videoId={video.id} />

      <ClipComposer
        videoId={video.id}
        segments={segments}
        videoDurationMs={video.durationMs ?? 0}
      />
    </div>
  );
}

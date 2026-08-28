import { ClipEditor, type ClipData } from "./[videoId]/clip-editor";
import { ClipComposer } from "./[videoId]/clip-composer";
import type { TranscriptRow, WordStyle } from "./[videoId]/editable-transcript";
import type { PreviewWord } from "./[videoId]/clip-player";
import type { OverlayView } from "./[videoId]/overlay-panel";

export interface EditorVideo {
  id: string;
  name: string;
  status: string;
  durationMs: number | null;
}

function timecode(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const STATUS_TONE: Record<string, string> = {
  READY: "border-accent/40 text-accent",
  FAILED: "border-danger/40 text-danger",
};

export function EditorPane({
  video,
  sourceUrl,
  clips,
  wordsByClip,
  transcriptByClip,
  overlaysByClip,
  wordStylesByClip,
  projects,
}: {
  video: EditorVideo;
  sourceUrl: string;
  clips: ClipData[];
  wordsByClip: Record<string, PreviewWord[]>;
  transcriptByClip: Record<string, TranscriptRow[]>;
  overlaysByClip: Record<string, OverlayView[]>;
  wordStylesByClip: Record<string, Record<string, WordStyle>>;
  projects: Array<{ id: string; name: string }>;
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
            {clips.map((c) => (
              <div key={c.id} id={`clip-${c.id}`} className="scroll-mt-6">
                <ClipEditor
                  clip={c}
                  sourceUrl={sourceUrl}
                  words={wordsByClip[c.id] ?? []}
                  transcript={transcriptByClip[c.id] ?? []}
                  overlays={overlaysByClip[c.id] ?? []}
                  wordStyles={wordStylesByClip[c.id] ?? {}}
                  projects={projects}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <ClipComposer videoId={video.id} />
    </div>
  );
}

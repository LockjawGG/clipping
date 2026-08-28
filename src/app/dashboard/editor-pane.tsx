import { ClipEditor, type ClipData } from "./[videoId]/clip-editor";
import { ClipComposer, type TranscriptRow } from "./[videoId]/clip-composer";
import type { PreviewWord } from "./[videoId]/clip-player";

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
  transcriptRows,
}: {
  video: EditorVideo;
  sourceUrl: string;
  clips: ClipData[];
  wordsByClip: Record<string, PreviewWord[]>;
  transcriptRows: TranscriptRow[];
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
                <ClipEditor clip={c} sourceUrl={sourceUrl} words={wordsByClip[c.id] ?? []} />
              </div>
            ))}
          </div>
        )}
      </section>

      <ClipComposer videoId={video.id} rows={transcriptRows} />
    </div>
  );
}

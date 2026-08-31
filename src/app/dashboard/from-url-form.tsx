"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Preview = {
  ok: true;
  /** Present when the link is a playlist: what one click would import. */
  playlist?: { title: string | null; total: number; willAdd: number; firstTitles: string[] };
  title: string | null;
  durationSec: number | null;
  thumbnail: string | null;
  source: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  approxBytes: number | null;
  isLive: boolean;
};
type Analyzed =
  | Preview
  | { ok: false; kind: string; message: string; technical: string };

const dur = (s: number | null) => {
  if (!s || s < 0) return null;
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const size = (b: number | null) => (b && b > 0 ? `~${Math.round(b / 1_000_000)} MB` : null);

export function FromUrlForm({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<"input" | "analyzing" | "preview">("input");
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<Analyzed | null>(null);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ytdlp, setYtdlp] = useState<{ version: string | null; updateCommand: string } | null>(null);

  useEffect(() => {
    void fetch("/api/system/ytdlp")
      .then((r) => (r.ok ? r.json() : null))
      .then(setYtdlp)
      .catch(() => {});
  }, []);

  async function analyze(e: React.FormEvent) {
    e.preventDefault();
    setPhase("analyzing");
    setError(null);
    setNotice(null);
    setResult(null);
    setThumbBroken(false);
    try {
      const res = await fetch("/api/videos/analyze-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = (await res.json()) as Analyzed;
      if (!res.ok) throw new Error((data as { message?: string }).message ?? "could not analyze");
      setResult(data);
      setPhase("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not analyze that link");
      setPhase("input");
    }
  }

  async function add() {
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/videos/from-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), projectId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        videoId?: string;
        projectId?: string;
        reused?: boolean;
        playlist?: boolean;
        added?: number;
        skipped?: number;
      };
      if (!res.ok) throw new Error(body.error ?? "could not start");
      setUrl("");
      setResult(null);
      setPhase("input");
      if (body.playlist) {
        // Every entry is its own video in the rail, each with its own progress.
        setNotice(
          `Added ${body.added ?? 0} video${(body.added ?? 0) === 1 ? "" : "s"} from the playlist` +
            (body.skipped ? ` (${body.skipped} past the limit skipped)` : "") +
            " — transcribing.",
        );
        router.refresh();
      } else if (body.reused && body.videoId) {
        // Already transcribed this link — jump straight to it.
        router.push(
          `/dashboard?project=${body.projectId ?? projectId ?? ""}&video=${body.videoId}`,
        );
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not start the download");
    } finally {
      setAdding(false);
    }
  }

  const reset = () => {
    setResult(null);
    setError(null);
    setPhase("input");
  };

  return (
    <div className="flex flex-col gap-2">
      {notice && phase === "input" && (
        <p className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs text-muted">
          {notice}
        </p>
      )}
      {phase !== "preview" && (
        <form onSubmit={analyze} className="flex flex-col gap-2">
          <input
            type="url"
            required
            placeholder="Paste a video link (YouTube, Rumble, Vimeo, …)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="field w-full"
          />
          <button
            type="submit"
            disabled={phase === "analyzing" || url.trim() === ""}
            className="btn w-full"
          >
            {phase === "analyzing" ? "Analyzing…" : "Analyze"}
          </button>
        </form>
      )}

      {phase === "preview" && result?.ok && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-3">
          <div className="flex gap-3">
            {result.thumbnail && !thumbBroken ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote source thumbnail
              <img
                src={result.thumbnail}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setThumbBroken(true)}
                className="h-16 w-28 shrink-0 rounded object-cover"
              />
            ) : (
              <div className="grid h-16 w-28 shrink-0 place-items-center rounded bg-surface text-muted">
                {result.playlist ? "🎞" : "🔗"}
              </div>
            )}
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium" title={result.title ?? url}>
                {result.playlist
                  ? (result.playlist.title ?? "Playlist found")
                  : (result.title ?? "Video found")}
              </p>
              {result.playlist ? (
                <>
                  <p className="mt-0.5 text-xs text-muted">
                    Playlist · {result.playlist.total} videos
                    {result.playlist.willAdd < result.playlist.total &&
                      ` · first ${result.playlist.willAdd} will be added`}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted" title={result.playlist.firstTitles.join(", ")}>
                    {result.playlist.firstTitles.join(" · ")}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                    {result.source && <span>{result.source}</span>}
                    {dur(result.durationSec) && <span>· {dur(result.durationSec)}</span>}
                    {size(result.approxBytes) && <span>· {size(result.approxBytes)}</span>}
                    {result.isLive && <span className="text-danger">· live</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {result.hasAudio ? "Audio ✓" : "No audio ✕"} ·{" "}
                    {result.hasVideo ? "Video ✓" : "Audio only"}
                  </p>
                </>
              )}
            </div>
          </div>

          {!result.hasAudio && (
            <p className="text-xs text-danger">
              No audio track — there’d be nothing to transcribe.
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={add}
              disabled={adding || !result.hasAudio}
              className="btn btn-primary flex-1"
            >
              {adding ? "Starting…" : result.playlist ? `Add all ${result.playlist.willAdd} & transcribe` : "Add & transcribe"}
            </button>
            <button onClick={reset} className="btn btn-ghost">
              Change link
            </button>
          </div>
        </div>
      )}

      {phase === "preview" && result && !result.ok && (
        <div className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-surface-raised p-3 text-sm">
          <p className="text-danger">{result.message}</p>
          {result.technical && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">Show technical details</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-[10px]">
                {result.technical}
              </pre>
            </details>
          )}
          <button onClick={reset} className="btn btn-ghost self-start">
            Try another link
          </button>
        </div>
      )}

      {phase !== "preview" && error && <p className="text-sm text-danger">{error}</p>}

      {ytdlp && (
        <p className="text-[10px] text-muted">
          Downloader: yt-dlp {ytdlp.version ?? "not installed"}
          {ytdlp.version && (
            <>
              {" · update with "}
              <code className="rounded bg-surface-raised px-1">{ytdlp.updateCommand}</code>
            </>
          )}
        </p>
      )}
    </div>
  );
}

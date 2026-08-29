"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const CHUNK_MS = 8_000;
const POLL_MS = 3_000;

interface LiveSeg {
  index: number;
  startMs: number;
  text: string;
  speaker: string | null;
}

type Phase = "idle" | "arming" | "recording" | "finalizing";

const fmtClock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Record mic (and optionally screen) audio in the browser, upload it in ~8s
 * self-contained WebM chunks, and watch the transcript build. Stop finalises it
 * into a normal clippable video (chunks concatenated + re-transcribed).
 */
export function GoLive({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [includeScreen, setIncludeScreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [segments, setSegments] = useState<LiveSeg[]>([]);

  const videoId = useRef<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);
  const chunkIndex = useRef(0);
  const startedAt = useRef(0);
  const chunkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recording = useRef(false);
  const lastSeg = useRef(-1);

  const teardown = useCallback(() => {
    recording.current = false;
    [chunkTimer, pollTimer, clockTimer].forEach((t) => {
      if (t.current) clearInterval(t.current);
      t.current = null;
    });
    try {
      recorder.current?.stop();
    } catch {
      /* already stopped */
    }
    recorder.current = null;
    streams.current.forEach((s) => s.getTracks().forEach((tk) => tk.stop()));
    streams.current = [];
    void audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const uploadChunk = useCallback(async (blob: Blob) => {
    const id = videoId.current;
    if (!id || blob.size === 0) return;
    const index = chunkIndex.current++;
    const startMs = index * CHUNK_MS;
    try {
      const res = await fetch(`/api/live/${id}/chunk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index, startMs, contentType: blob.type || "audio/webm" }),
      });
      if (!res.ok) throw new Error(`chunk ${index}: HTTP ${res.status}`);
      const { upload } = (await res.json()) as { upload: { url: string; method: string; headers: Record<string, string> } };
      const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: blob });
      if (!put.ok) throw new Error(`chunk ${index} upload: HTTP ${put.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "a chunk failed to upload");
    }
  }, []);

  const pollTranscript = useCallback(async () => {
    const id = videoId.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/live/${id}/transcript?after=${lastSeg.current}`);
      if (!res.ok) return;
      const { segments: segs, lastIndex } = (await res.json()) as {
        segments: LiveSeg[];
        lastIndex: number;
      };
      if (segs.length) {
        setSegments((prev) => [...prev, ...segs]);
        lastSeg.current = lastIndex;
      }
    } catch {
      /* transient */
    }
  }, []);

  async function start() {
    setError(null);
    setNote(null);
    setSegments([]);
    setPhase("arming");
    chunkIndex.current = 0;
    lastSeg.current = -1;
    try {
      // Screen picker FIRST, while the click's user-activation is still fresh —
      // an `await getUserMedia` before it consumes the gesture and Chrome then
      // rejects getDisplayMedia with NotAllowedError.
      // Screen video track we'll actually record (when capturing the screen),
      // plus any screen audio to mix in.
      let screenVideo: MediaStreamTrack | null = null;
      let screenAudio: MediaStream | null = null;
      if (includeScreen && !navigator.mediaDevices?.getDisplayMedia) {
        setNote("Screen capture isn’t available in this browser — recording the mic only.");
      } else if (includeScreen) {
        let disp: MediaStream;
        try {
          disp = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        } catch (e) {
          if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) {
            setNote("Screen share cancelled — recording the mic only.");
            disp = new MediaStream();
          } else {
            throw e;
          }
        }
        streams.current.push(disp);
        screenVideo = disp.getVideoTracks()[0] ?? null;
        // If the user stops sharing from the browser's own bar, end the session.
        screenVideo?.addEventListener("ended", () => {
          if (recording.current) void stop();
        });
        if (disp.getAudioTracks().length === 0) {
          setNote(
            "That source has no audio — mic audio only (screen is still recorded). Tip: a Chrome tab with “Share tab audio”, or “Entire screen”, carries sound.",
          );
        } else {
          screenAudio = disp;
        }
      }

      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streams.current.push(mic);

      // Only spin up an AudioContext when we actually need to *mix* two audio
      // sources (mic + screen). A suspended AudioContext produces no samples,
      // which stalls MediaRecorder's muxer and yields a black/frozen video — so
      // the mic-only path skips it entirely and records the mic track directly.
      let audioTracks: MediaStreamTrack[];
      if (screenAudio) {
        const AC: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ac = new AC();
        audioCtx.current = ac;
        if (ac.state === "suspended") await ac.resume().catch(() => {});
        const dest = ac.createMediaStreamDestination();
        ac.createMediaStreamSource(mic).connect(dest);
        ac.createMediaStreamSource(screenAudio).connect(dest);
        audioTracks = dest.stream.getAudioTracks();
      } else {
        audioTracks = mic.getAudioTracks();
      }

      const create = await fetch("/api/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      if (!create.ok) throw new Error((await create.json().catch(() => ({}))).error ?? "couldn't start the session");
      videoId.current = ((await create.json()) as { videoId: string }).videoId;

      // With a screen: record screen video + audio. Mic-only: audio only.
      const recStream = new MediaStream([...(screenVideo ? [screenVideo] : []), ...audioTracks]);
      const pick = (cands: string[]) => cands.find((c) => MediaRecorder.isTypeSupported(c));
      const mime = screenVideo
        ? pick([
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm",
          ]) ?? "video/webm"
        : pick(["audio/webm;codecs=opus", "audio/webm"]) ?? "audio/webm";
      const rec = new MediaRecorder(recStream, { mimeType: mime });
      recorder.current = rec;
      recording.current = true;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) void uploadChunk(e.data);
      };
      rec.onstop = () => {
        if (recording.current) rec.start(); // roll into the next chunk
      };
      rec.start();

      startedAt.current = Date.now();
      setElapsedMs(0);
      setPhase("recording");
      chunkTimer.current = setInterval(() => {
        try {
          recorder.current?.stop(); // flush a self-contained blob, then onstop restarts
        } catch {
          /* ignore */
        }
      }, CHUNK_MS);
      pollTimer.current = setInterval(() => void pollTranscript(), POLL_MS);
      clockTimer.current = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 500);
    } catch (e) {
      teardown();
      setPhase("idle");
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission denied — allow it in the browser and try again."
          : e instanceof DOMException && e.name === "NotFoundError"
            ? "No microphone found."
            : e instanceof DOMException && e.name === "NotReadableError"
              ? "The microphone is in use by another app."
              : e instanceof Error
                ? e.message
                : "couldn't start recording",
      );
    }
  }

  async function stop() {
    const id = videoId.current;
    setPhase("finalizing");
    recording.current = false;
    teardown();
    // give the last blob a beat to upload
    await new Promise((r) => setTimeout(r, 800));
    if (id) {
      try {
        await fetch(`/api/live/${id}/stop`, { method: "POST" });
      } catch {
        setError("stop request failed — the recording may not finalise");
      }
      router.push(`/dashboard?project=${projectId ?? ""}&video=${id}`);
      router.refresh();
    }
    setPhase("idle");
    videoId.current = null;
  }

  return (
    <div className="flex flex-col gap-2">
      {phase === "idle" && (
        <>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={includeScreen}
              onChange={(e) => setIncludeScreen(e.target.checked)}
            />
            Also capture screen / tab audio
          </label>
          <button type="button" onClick={start} className="btn btn-primary">
            ● Go live
          </button>
          <p className="text-[11px] text-muted">
            Records your mic{includeScreen ? " + shared screen audio" : ""} in the browser,
            transcribing as you speak. Stop turns it into a normal clip-able video.
          </p>
        </>
      )}

      {(phase === "arming" || phase === "finalizing") && (
        <p className="text-xs text-muted">
          {phase === "arming" ? "Requesting devices…" : "Finalising — building the recording…"}
        </p>
      )}

      {phase === "recording" && (
        <>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
            <span className="font-mono text-sm tabular-nums">{fmtClock(elapsedMs)}</span>
            <button type="button" onClick={() => void stop()} className="btn btn-danger btn-sm ml-auto">
              ■ Stop
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-raised p-2 text-xs leading-relaxed">
            {segments.length === 0 ? (
              <span className="text-muted">Listening… transcript appears here as you talk.</span>
            ) : (
              segments.map((s) => (
                <span key={s.index}>
                  {s.speaker ? <span className="text-muted">{s.speaker}: </span> : null}
                  {s.text}{" "}
                </span>
              ))
            )}
          </div>
        </>
      )}

      {note && <p className="text-[11px] text-amber-500">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

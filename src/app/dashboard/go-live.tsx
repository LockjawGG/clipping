"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** How often the recorder flushes a fragment to storage (crash-durability). */
const FLUSH_MS = 20_000;

type Phase = "idle" | "arming" | "recording" | "finalizing";

const fmtClock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Record mic (and optionally screen) audio in the browser as ONE continuous
 * MediaRecorder stream, flushing a fragment to storage every {@link FLUSH_MS}
 * purely so a crash can't lose everything. Nothing is transcribed while
 * recording — Stop reassembles the fragments and transcribes the whole thing
 * once at full quality, which is far more accurate (and cheaper) than decoding
 * dozens of tiny isolated chunks.
 */
export function GoLive({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const videoId = useRef<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);
  const chunkIndex = useRef(0);
  const startedAt = useRef(0);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onVisible = useRef<(() => void) | null>(null);
  const recording = useRef(false);

  const teardown = useCallback(() => {
    recording.current = false;
    if (clockTimer.current) clearInterval(clockTimer.current);
    clockTimer.current = null;
    if (onVisible.current) {
      document.removeEventListener("visibilitychange", onVisible.current);
      onVisible.current = null;
    }
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
    try {
      const res = await fetch(`/api/live/${id}/chunk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index, startMs: index * FLUSH_MS, contentType: blob.type || "audio/webm" }),
      });
      if (!res.ok) throw new Error(`fragment ${index}: HTTP ${res.status}`);
      const { upload } = (await res.json()) as {
        upload: { url: string; method: string; headers: Record<string, string> };
      };
      const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: blob });
      if (!put.ok) throw new Error(`fragment ${index} upload: HTTP ${put.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "a fragment failed to upload");
    }
  }, []);

  async function start() {
    setError(null);
    setNote(null);
    setPhase("arming");
    chunkIndex.current = 0;
    try {
      // Screen picker FIRST, while the click's user-activation is still fresh —
      // an `await getUserMedia` before it consumes the gesture and Chrome then
      // rejects getDisplayMedia with NotAllowedError.
      let screenVideo: MediaStreamTrack | null = null;
      let screenAudio: MediaStream | null = null;
      if (navigator.mediaDevices?.getDisplayMedia) {
        let disp: MediaStream;
        try {
          // `systemAudio: "include"` makes Chrome offer the "Share system audio"
          // (whole screen) / "Share tab audio" (tab) checkbox in the picker.
          // Keep the audio constraint permissive — an over-specified one makes
          // some Chrome builds drop the capture's audio track entirely.
          const displayOpts: DisplayMediaStreamOptions & {
            systemAudio?: "include" | "exclude";
            surfaceSwitching?: "include" | "exclude";
          } = {
            video: { frameRate: 30 },
            audio: true,
            systemAudio: "include",
            surfaceSwitching: "include",
          };
          disp = await navigator.mediaDevices.getDisplayMedia(displayOpts);
        } catch (e) {
          if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) {
            setNote("Screen sharing skipped — recording your mic only.");
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
            "No system audio on that source — recording your mic only (screen video is still captured). " +
              "To include computer sound, Stop and start again, then pick “Entire screen” and tick " +
              "“Share system audio”, or a browser tab and tick “Share tab audio”. A single app window can’t share audio.",
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
        ? pick(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) ?? "video/webm"
        : pick(["audio/webm;codecs=opus", "audio/webm"]) ?? "audio/webm";
      const rec = new MediaRecorder(recStream, { mimeType: mime });
      recorder.current = rec;
      recording.current = true;
      // One continuous recording; timeslice just flushes a fragment periodically.
      // The fragments are a single stream in pieces — reassembled server-side —
      // so there are no per-chunk encode gaps to hurt transcription accuracy.
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) void uploadChunk(e.data);
      };
      rec.start(FLUSH_MS);

      startedAt.current = Date.now();
      setElapsedMs(0);
      setPhase("recording");

      // Returning to the tab can leave a mixing AudioContext suspended — resume it.
      const vis = () => {
        if (document.visibilityState === "visible") void audioCtx.current?.resume().catch(() => {});
      };
      document.addEventListener("visibilitychange", vis);
      onVisible.current = vis;

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
    // give the final fragment a beat to upload
    await new Promise((r) => setTimeout(r, 1200));
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
          <button type="button" onClick={start} className="btn btn-primary">
            ● Go live
          </button>
          <p className="text-[11px] text-muted">
            You’ll be asked to pick a screen or tab to share (tick “Share system audio” /
            “Share tab audio” for its sound) — or skip that to record just your mic.
            The transcript is generated in full when you press Stop, which then turns it
            into a normal clip-able video.
          </p>
        </>
      )}

      {(phase === "arming" || phase === "finalizing") && (
        <p className="text-xs text-muted">
          {phase === "arming" ? "Requesting devices…" : "Finalising — building the recording & transcript…"}
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
          <p className="rounded-lg border border-border bg-surface-raised p-2 text-xs leading-relaxed text-muted">
            Recording… the full transcript is generated when you press Stop.
          </p>
        </>
      )}

      {note && <p className="text-[11px] text-amber-500">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { LiveOutbox, type OutboxStats } from "./live-outbox.ts";

/** How often the recorder flushes a fragment to the outbox. */
const FLUSH_MS = 20_000;
/** How often we tell the server this tab is still recording. */
const HEARTBEAT_MS = 15_000;

type Phase = "idle" | "arming" | "recording" | "paused" | "finalizing";
type Source = "monitor" | "window" | "browser";

interface Recoverable {
  videoId: string;
  name: string;
  startedAt: string;
  fragments: number;
  stale: boolean;
}

const SOURCES: { id: Source; label: string; glyph: string; hint: string }[] = [
  { id: "monitor", label: "Entire Screen", glyph: "▣", hint: "Everything on one display. The only source that can share system audio." },
  { id: "window", label: "Window", glyph: "▢", hint: "A single application window. Windows cannot share audio." },
  { id: "browser", label: "Browser Tab", glyph: "▤", hint: "One tab, with the option to share that tab's audio." },
];

const fmtClock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/**
 * Screen + audio capture, recorded in the browser as one continuous
 * MediaRecorder stream and flushed to a durable outbox every {@link FLUSH_MS}.
 *
 * Nothing is transcribed while recording: Stop reassembles the fragments and
 * transcribes the whole thing in one pass, which is both faster and markedly
 * more accurate than decoding short isolated slices. Everything stays on this
 * machine — fragments go to your own server, transcription runs locally.
 */
export function GoLive({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [source, setSource] = useState<Source>("monitor");
  const [wantMic, setWantMic] = useState(true);
  const [wantSystem, setWantSystem] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [stats, setStats] = useState<OutboxStats>({ uploaded: 0, pending: 0, failures: 0 });
  const [recoverable, setRecoverable] = useState<Recoverable[]>([]);
  const [recovering, setRecovering] = useState<string | null>(null);

  const videoId = useRef<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const streams = useRef<MediaStream[]>([]);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const mimeRef = useRef("video/webm");
  const chunkIndex = useRef(0);
  const startedAt = useRef(0);
  const accumulatedMs = useRef(0);
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const beatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafId = useRef(0);
  const onVisible = useRef<(() => void) | null>(null);
  const recording = useRef(false);

  const outbox = useRef<LiveOutbox | null>(null);
  if (outbox.current === null && typeof window !== "undefined") {
    outbox.current = new LiveOutbox((s) => setStats(s));
  }

  const teardown = useCallback(() => {
    recording.current = false;
    [clockTimer, beatTimer].forEach((t) => {
      if (t.current) clearInterval(t.current);
      t.current = null;
    });
    if (rafId.current) cancelAnimationFrame(rafId.current);
    rafId.current = 0;
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
    analyser.current = null;
    streams.current.forEach((s) => s.getTracks().forEach((tk) => tk.stop()));
    streams.current = [];
    void audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  /* ---- recovery: sessions whose tab never came back, and unsent fragments ---- */
  const loadRecoverable = useCallback(async () => {
    try {
      const res = await fetch("/api/live/recoverable");
      if (!res.ok) return;
      const { sessions } = (await res.json()) as { sessions: Recoverable[] };
      setRecoverable(sessions.filter((s) => s.videoId !== videoId.current));
    } catch {
      /* offline — try again next mount */
    }
  }, []);

  useEffect(() => {
    // Anything left in the outbox from a previous page load belongs to a
    // recording that never finished; push it before offering recovery so the
    // session is finalised with every fragment that was actually captured.
    void (async () => {
      const box = outbox.current;
      if (box && (await box.pending()) > 0) await box.drain();
      await loadRecoverable();
    })();
  }, [loadRecoverable]);

  /* ---- leave guard: closing the tab mid-recording is silent data loss ---- */
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  async function recover(id: string) {
    setRecovering(id);
    try {
      const res = await fetch(`/api/live/${id}/stop`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRecoverable((prev) => prev.filter((s) => s.videoId !== id));
      router.push(`/dashboard?project=${projectId ?? ""}&video=${id}`);
      router.refresh();
    } catch {
      setError("Couldn't recover that recording — is the server running?");
    } finally {
      setRecovering(null);
    }
  }

  async function start() {
    if (!wantMic && !wantSystem && source !== "monitor") {
      setError("Turn on a microphone or system audio — a silent recording can't be transcribed.");
      return;
    }
    setError(null);
    setNote(null);
    setPhase("arming");
    chunkIndex.current = 0;
    accumulatedMs.current = 0;
    try {
      // Screen picker FIRST, while the click's user-activation is still fresh —
      // an `await getUserMedia` before it consumes the gesture and Chrome then
      // rejects getDisplayMedia with NotAllowedError.
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("This browser can't capture the screen. Try Chrome or Edge.");
      }
      const displayOpts: DisplayMediaStreamOptions & {
        systemAudio?: "include" | "exclude";
        surfaceSwitching?: "include" | "exclude";
        selfBrowserSurface?: "include" | "exclude";
      } = {
        video: { frameRate: 30, displaySurface: source },
        // Asking for audio is what puts the "share audio" checkbox in the picker.
        audio: wantSystem,
        systemAudio: wantSystem ? "include" : "exclude",
        surfaceSwitching: "include",
        // Never offer this tab — recording the editor into itself mirrors.
        selfBrowserSurface: "exclude",
      };
      const disp = await navigator.mediaDevices.getDisplayMedia(displayOpts);
      streams.current.push(disp);

      const screenVideo = disp.getVideoTracks()[0] ?? null;
      // Stopping the share from the browser's own bar ends the session.
      screenVideo?.addEventListener("ended", () => {
        if (recording.current) void stop();
      });
      const screenAudio = disp.getAudioTracks().length > 0 ? disp : null;
      if (wantSystem && !screenAudio) {
        setNote(
          source === "monitor"
            ? "That screen was shared without system audio — tick “Share system audio” in the picker to include computer sound."
            : "This source can't share audio. Pick Entire Screen, or a browser tab with “Share tab audio”.",
        );
      }

      let mic: MediaStream | null = null;
      if (wantMic) {
        try {
          mic = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          streams.current.push(mic);
        } catch (e) {
          if (!screenAudio) throw e;
          setNote("Microphone unavailable — recording system audio only.");
        }
      }

      if (!mic && !screenAudio) {
        setNote("No audio on this recording — there'll be no transcript, just video.");
      }

      // Only route through an AudioContext when two sources actually need
      // mixing: a suspended context emits no samples, which stalls the muxer
      // and yields a frozen picture. With one source, record its track raw and
      // use the context purely as an off-path tap for the level meter.
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      let audioTracks: MediaStreamTrack[] = [];
      if (AC && mic && screenAudio) {
        const ac = new AC();
        audioCtx.current = ac;
        if (ac.state === "suspended") await ac.resume().catch(() => {});
        const dest = ac.createMediaStreamDestination();
        ac.createMediaStreamSource(mic).connect(dest);
        ac.createMediaStreamSource(screenAudio).connect(dest);
        audioTracks = dest.stream.getAudioTracks();
        const an = ac.createAnalyser();
        an.fftSize = 512;
        ac.createMediaStreamSource(dest.stream).connect(an);
        analyser.current = an;
      } else {
        const only = mic ?? screenAudio;
        audioTracks = only ? only.getAudioTracks() : [];
        if (AC && only) {
          const ac = new AC();
          audioCtx.current = ac;
          if (ac.state === "suspended") await ac.resume().catch(() => {});
          const an = ac.createAnalyser();
          an.fftSize = 512;
          // Tap only — never connected to a destination, so the recorded
          // track is untouched by this.
          ac.createMediaStreamSource(only).connect(an);
          analyser.current = an;
        }
      }

      const create = await fetch("/api/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(projectId ? { projectId } : {}),
      });
      if (!create.ok) {
        throw new Error((await create.json().catch(() => ({}))).error ?? "couldn't start the session");
      }
      videoId.current = ((await create.json()) as { videoId: string }).videoId;

      const recStream = new MediaStream([...(screenVideo ? [screenVideo] : []), ...audioTracks]);
      const pick = (cands: string[]) => cands.find((c) => MediaRecorder.isTypeSupported(c));
      const mime = screenVideo
        ? pick(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) ?? "video/webm"
        : pick(["audio/webm;codecs=opus", "audio/webm"]) ?? "audio/webm";
      mimeRef.current = mime;

      const rec = new MediaRecorder(recStream, { mimeType: mime });
      recorder.current = rec;
      recording.current = true;
      // One continuous recording; the timeslice only decides how often a
      // fragment is handed to the outbox, so there are no encode seams.
      rec.ondataavailable = (e) => {
        if (e.data.size === 0 || !videoId.current) return;
        const index = chunkIndex.current++;
        void outbox.current?.add({
          videoId: videoId.current,
          index,
          startMs: index * FLUSH_MS,
          mime: e.data.type || mimeRef.current,
          bytes: e.data.size,
          blob: e.data,
        });
      };
      rec.start(FLUSH_MS);

      startedAt.current = Date.now();
      setElapsedMs(0);
      setPhase("recording");

      // Returning to the tab can leave a mixing AudioContext suspended, and is
      // also a good moment to push anything the outbox couldn't send.
      const vis = () => {
        if (document.visibilityState !== "visible") return;
        void audioCtx.current?.resume().catch(() => {});
        void outbox.current?.drain();
      };
      document.addEventListener("visibilitychange", vis);
      onVisible.current = vis;

      clockTimer.current = setInterval(() => {
        if (recorder.current?.state === "recording") {
          setElapsedMs(accumulatedMs.current + (Date.now() - startedAt.current));
        }
      }, 500);

      beatTimer.current = setInterval(() => {
        const id = videoId.current;
        if (id) void fetch(`/api/live/${id}/heartbeat`, { method: "POST" }).catch(() => {});
      }, HEARTBEAT_MS);

      // Level meter, off the analyser tap.
      const buf = new Uint8Array(analyser.current?.frequencyBinCount ?? 0);
      const tick = () => {
        const an = analyser.current;
        if (an) {
          an.getByteTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          setLevel(Math.min(1, peak / 90));
        }
        rafId.current = requestAnimationFrame(tick);
      };
      if (analyser.current) rafId.current = requestAnimationFrame(tick);
    } catch (e) {
      teardown();
      setPhase("idle");
      setError(
        e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")
          ? "Screen sharing was cancelled — nothing was recorded."
          : e instanceof DOMException && e.name === "NotFoundError"
            ? "No microphone found. Turn the microphone toggle off to record without one."
            : e instanceof DOMException && e.name === "NotReadableError"
              ? "The microphone is in use by another app."
              : e instanceof Error
                ? e.message
                : "Couldn't start recording.",
      );
    }
  }

  function togglePause() {
    const rec = recorder.current;
    if (!rec) return;
    if (rec.state === "recording") {
      rec.pause();
      accumulatedMs.current += Date.now() - startedAt.current;
      setPhase("paused");
    } else if (rec.state === "paused") {
      rec.resume();
      startedAt.current = Date.now();
      setPhase("recording");
    }
  }

  async function stop() {
    const id = videoId.current;
    setPhase("finalizing");
    recording.current = false;
    // Flush the tail of the recording before tearing the recorder down.
    try {
      if (recorder.current && recorder.current.state !== "inactive") {
        recorder.current.requestData();
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 250));
    teardown();

    // Every fragment must be durable before the server folds them together.
    const flushed = (await outbox.current?.flush(20_000)) ?? true;
    if (!flushed) {
      setError("Some of the recording is still uploading — it'll finish in the background.");
    }

    if (id) {
      try {
        await fetch(`/api/live/${id}/stop`, { method: "POST" });
      } catch {
        setError("Stop didn't reach the server — the recording will be recovered automatically.");
      }
      router.push(`/dashboard?project=${projectId ?? ""}&video=${id}`);
      router.refresh();
    }
    setPhase("idle");
    videoId.current = null;
  }

  const live = phase === "recording" || phase === "paused";
  const queueWarn = stats.failures > 0;

  return (
    <div className="flex flex-col gap-3">
      {!live && recoverable.length > 0 && (
        <div className="card flex flex-col gap-2 p-3">
          <span className="text-xs font-semibold">Unfinished recording</span>
          {recoverable.map((s) => (
            <div key={s.videoId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[11px] text-muted">
                {new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ·{" "}
                {s.fragments} saved {s.fragments === 1 ? "piece" : "pieces"}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={recovering === s.videoId}
                onClick={() => void recover(s.videoId)}
              >
                {recovering === s.videoId ? "Recovering…" : "Recover"}
              </button>
            </div>
          ))}
        </div>
      )}

      {phase === "idle" && (
        <>
          <div>
            <p className="rail-heading mb-1.5">Source</p>
            <div className="flex flex-col gap-1.5">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={source === s.id}
                  onClick={() => setSource(s.id)}
                  title={s.hint}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                    source === s.id
                      ? "border-accent bg-accent/10 text-text"
                      : "border-border text-muted hover:bg-elevated"
                  }`}
                >
                  <span className="text-base leading-none" aria-hidden="true">
                    {s.glyph}
                  </span>
                  <span className="font-medium">{s.label}</span>
                  {s.id === "monitor" && (
                    <span className="ml-auto text-[10px] text-muted">recommended</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="rail-heading mb-1.5">Audio</p>
            <label className="mb-1.5 flex cursor-pointer items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
              <span className="font-medium">Microphone</span>
              <input
                type="checkbox"
                className="switch"
                checked={wantMic}
                onChange={(e) => setWantMic(e.target.checked)}
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border px-3 py-2 text-xs">
              <span className="font-medium">System audio</span>
              <input
                type="checkbox"
                className="switch"
                checked={wantSystem}
                onChange={(e) => setWantSystem(e.target.checked)}
              />
            </label>
          </div>

          <button type="button" onClick={start} className="btn btn-primary">
            ● Start Live Capture
          </button>
          <p className="text-[11px] text-muted">
            Records on this machine and transcribes when you press Stop — nothing is sent anywhere
            else. Long sessions are saved continuously, so a crash won&rsquo;t lose them.
          </p>
        </>
      )}

      {(phase === "arming" || phase === "finalizing") && (
        <p className="text-xs text-muted">
          {phase === "arming"
            ? "Waiting for you to choose what to share…"
            : "Finishing up — saving the recording and building the transcript…"}
        </p>
      )}

      {live && (
        <>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                phase === "recording" ? "animate-pulse bg-danger" : "bg-muted"
              }`}
            />
            <span className="font-mono text-sm tabular-nums">{fmtClock(elapsedMs)}</span>
            {phase === "paused" && <span className="chip">Paused</span>}
            <button type="button" onClick={togglePause} className="btn btn-sm ml-auto">
              {phase === "paused" ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={() => void stop()} className="btn btn-danger btn-sm">
              ■ Stop
            </button>
          </div>

          <div className="h-1.5 overflow-hidden rounded-full bg-surface-raised" aria-hidden="true">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-75"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>

          <p className={`text-[11px] ${queueWarn ? "text-amber-500" : "text-muted"}`}>
            {stats.uploaded} saved
            {stats.pending > 0 && ` · ${stats.pending} uploading`}
            {queueWarn && " · retrying, nothing lost"}
          </p>

          <p className="rounded-lg border border-border bg-surface-raised p-2 text-xs leading-relaxed text-muted">
            Recording continues while you switch tabs or apps. The transcript is generated when you
            press Stop.
          </p>
        </>
      )}

      {note && <p className="text-[11px] text-amber-500">{note}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildReplaySchedule, replayDurationMs, type ReplayStep } from "@/lib/telemetry/replay.ts";
import type { TelemetryEventRow } from "@/lib/telemetry/types.ts";

/**
 * The page's one source of events, live or replayed.
 *
 * Both modes push through the same buffer and produce the same `lastBatch`, so
 * there is exactly one rendering path: replay is the live path fed from a timer
 * instead of a socket. Anything that only worked in one of the two would be a
 * bug waiting for the moment someone toggles the switch.
 *
 * Nothing here manufactures an event. An empty buffer means the machine has
 * been idle, and the page says so rather than filling the silence.
 */

/** Client-side ceiling. Oldest events fall off the front. */
export const MAX_EVENTS = 1000;
/**
 * State is flushed on this cadence rather than per event: a burst of fifty
 * rows must cost one React render, not fifty, and the counters are readable at
 * five updates a second.
 */
const FLUSH_MS = 200;

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline" | "replay";
export type FeedMode = "live" | "replay";
export const REPLAY_SPEEDS = [1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface BrainFeed {
  /** Oldest first, at most `MAX_EVENTS`. */
  events: TelemetryEventRow[];
  /** The batch appended by the last flush — what the graph turns into pulses. */
  lastBatch: TelemetryEventRow[];
  connection: ConnectionState;
  mode: FeedMode;
  setMode: (mode: FeedMode) => void;
  /** Epoch ms this page started watching; the top bar's session clock. */
  startedAt: number;
  replay: {
    playing: boolean;
    speed: ReplaySpeed;
    setSpeed: (speed: ReplaySpeed) => void;
    toggle: () => void;
    restart: () => void;
    /** 0..1 through the loaded window; 0 when nothing is loaded. */
    progress: number;
    /** How many events the loaded window holds. */
    loaded: number;
    error: string | null;
  };
}

export function useBrainFeed(): BrainFeed {
  const [events, setEvents] = useState<TelemetryEventRow[]>([]);
  const [lastBatch, setLastBatch] = useState<TelemetryEventRow[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [mode, setModeState] = useState<FeedMode>("live");
  const [startedAt] = useState(() => Date.now());

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Incoming events land here and are drained by one timer, so neither a burst
  // from the stream nor a fast replay can outrun React.
  const pending = useRef<TelemetryEventRow[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const seenOrder = useRef<string[]>([]);

  const push = useCallback((incoming: TelemetryEventRow[]) => {
    for (const event of incoming) {
      // The stream's opening backfill and a poll can overlap by a row; the id
      // is the only thing that reliably says "already have it".
      if (seen.current.has(event.id)) continue;
      seen.current.add(event.id);
      seenOrder.current.push(event.id);
      pending.current.push(event);
    }
    // This page is meant to be left open for hours, so the dedupe set is
    // bounded too. Several buffers' worth of headroom is far more than the
    // server's tail cursor could ever resend.
    const cap = MAX_EVENTS * 4;
    if (seenOrder.current.length > cap) {
      const dropped = seenOrder.current.splice(0, seenOrder.current.length - MAX_EVENTS);
      for (const id of dropped) seen.current.delete(id);
    }
  }, []);

  const reset = useCallback(() => {
    pending.current = [];
    seen.current = new Set();
    seenOrder.current = [];
    setEvents([]);
    setLastBatch([]);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setEvents((current) => {
        const next = [...current, ...batch];
        // FIFO: the window is the last MAX_EVENTS, and ids of dropped rows are
        // left in `seen` deliberately — re-admitting an old event would make it
        // pulse a second time.
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
      setLastBatch(batch);
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  /* --- live -------------------------------------------------------------- */

  useEffect(() => {
    if (mode !== "live") return;
    setConnection("connecting");
    const source = new EventSource("/api/telemetry/stream");

    const onBatch = (message: MessageEvent<string>) => {
      setConnection("live");
      try {
        const payload = JSON.parse(message.data) as { events?: TelemetryEventRow[] };
        if (Array.isArray(payload.events)) push(payload.events);
      } catch {
        // A frame we cannot parse is a frame we do not show. Silence beats a
        // half-decoded row rendered as if it were measured.
      }
    };

    // Sent when the server's tail stops delivering and again when it resumes.
    // The socket can be perfectly healthy while the tail is not, and a stalled
    // graph must not read as a quiet machine.
    const onTail = (message: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(message.data) as { ok?: boolean };
        setConnection(payload.ok === false ? "reconnecting" : "live");
      } catch {
        setConnection("reconnecting");
      }
    };

    source.addEventListener("batch", onBatch as EventListener);
    source.addEventListener("tail", onTail as EventListener);
    source.onopen = () => setConnection("live");
    source.onerror = () => {
      // EventSource reconnects on its own unless it has given up for good.
      setConnection(source.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    };

    return () => {
      source.removeEventListener("batch", onBatch as EventListener);
      source.removeEventListener("tail", onTail as EventListener);
      source.close();
    };
  }, [mode, push]);

  /* --- replay ------------------------------------------------------------ */

  const schedule = useRef<ReplayStep[]>([]);
  const cursor = useRef(0);
  const clockStart = useRef(0);
  const elapsedAtPause = useRef(0);

  const loadHistory = useCallback(async () => {
    setReplayError(null);
    try {
      const res = await fetch("/api/telemetry/history", { cache: "no-store" });
      if (!res.ok) throw new Error(`history ${res.status}`);
      const body = (await res.json()) as { events?: TelemetryEventRow[] };
      schedule.current = buildReplaySchedule(body.events ?? []);
      setLoaded(schedule.current.length);
    } catch (err) {
      schedule.current = [];
      setLoaded(0);
      setReplayError(err instanceof Error ? err.message : "could not load history");
    }
    cursor.current = 0;
    clockStart.current = Date.now();
    elapsedAtPause.current = 0;
    setProgress(0);
  }, []);

  useEffect(() => {
    if (mode !== "replay") return;
    reset();
    void loadHistory();
  }, [mode, reset, loadHistory]);

  useEffect(() => {
    if (mode !== "replay" || !playing) return;
    // The schedule is built at 1x and scaled here, so changing speed mid-run
    // costs nothing and the position is preserved. Resuming rewinds the wall
    // clock by the elapsed virtual time rather than restarting it, which is
    // what keeps a pause from swallowing the gap it interrupted.
    clockStart.current = Date.now() - elapsedAtPause.current / speed;
    const timer = setInterval(() => {
      const steps = schedule.current;
      if (steps.length === 0) return;
      const elapsed = (Date.now() - clockStart.current) * speed;
      elapsedAtPause.current = elapsed;
      const due: TelemetryEventRow[] = [];
      while (cursor.current < steps.length && steps[cursor.current].atMs <= elapsed) {
        due.push(steps[cursor.current].event);
        cursor.current += 1;
      }
      if (due.length > 0) push(due);
      const total = replayDurationMs(steps) || 1;
      setProgress(Math.min(1, elapsed / total));
      if (cursor.current >= steps.length) setPlaying(false);
    }, 100);
    return () => clearInterval(timer);
  }, [mode, playing, speed, push]);

  const setMode = useCallback(
    (next: FeedMode) => {
      setModeState((current) => {
        if (current === next) return current;
        reset();
        setPlaying(true);
        setProgress(0);
        return next;
      });
    },
    [reset],
  );

  const restart = useCallback(() => {
    reset();
    cursor.current = 0;
    clockStart.current = Date.now();
    elapsedAtPause.current = 0;
    setProgress(0);
    setPlaying(true);
  }, [reset]);

  const toggle = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Play at the end of the window starts it over; the alternative is a
    // button that visibly does nothing.
    if (cursor.current >= schedule.current.length) restart();
    else setPlaying(true);
  }, [playing, restart]);

  const replay = useMemo(
    () => ({ playing, speed, setSpeed, toggle, restart, progress, loaded, error: replayError }),
    [playing, speed, toggle, restart, progress, loaded, replayError],
  );

  return {
    events,
    lastBatch,
    // Replay has no socket. Reporting "live" would be a lie about where the
    // rows came from, and "offline" would be a lie about the app's health.
    connection: mode === "replay" ? "replay" : connection,
    mode,
    setMode,
    startedAt,
    replay,
  };
}

/**
 * Ollama models installed on this machine, from the app's own status probe.
 *
 * Real information — the model exists — but not activity, so the graph draws
 * these as dim probe-only nodes. Failure is silent and leaves the list empty:
 * "we could not ask" must not become "these models are here".
 */
export function useInstalledModels(): string[] {
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch("/api/assistant/status", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { models?: string[]; available?: boolean };
        if (!cancelled && body.available && Array.isArray(body.models)) setModels(body.models);
      } catch {
        // Ollama absent is the normal case on most machines, not an error.
      }
    };
    void probe();
    const timer = setInterval(probe, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return models;
}

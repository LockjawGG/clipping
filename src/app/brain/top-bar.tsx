"use client";

import { useEffect, useRef, useState } from "react";

import type { BrainFeed, ConnectionState, FeedMode, ReplaySpeed } from "./use-brain-feed";
import { REPLAY_SPEEDS } from "./use-brain-feed";

/**
 * The page's status line: where the rows are coming from, how long this page
 * has been watching, and the running estimate of top-tier tokens the
 * delegations avoided.
 *
 * The counter animates towards its target but is never ahead of it in any
 * meaningful sense — it eases over a few hundred milliseconds so a jump of ten
 * thousand is legible, and the label says "estimated" because it is.
 */

const CONNECTION_COPY: Record<ConnectionState, { label: string; tone: string; dot: string }> = {
  connecting: { label: "CONNECTING", tone: "text-muted", dot: "bg-muted" },
  live: { label: "LIVE", tone: "text-accent", dot: "bg-accent" },
  reconnecting: { label: "RECONNECTING", tone: "text-muted", dot: "bg-muted" },
  offline: { label: "OFFLINE", tone: "text-danger", dot: "bg-danger" },
  // Replaying recorded history is neither live nor broken, and saying either
  // would misdescribe where these rows came from.
  replay: { label: "REPLAY", tone: "text-muted", dot: "bg-muted" },
};

/** Ease a displayed number towards a target. Snaps when motion is unwelcome. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    // 200ms ticks rather than a frame loop: this is a number being read, not an
    // animation being watched, and five updates a second is already generous.
    const timer = setInterval(() => {
      const gap = target - shownRef.current;
      if (Math.abs(gap) < 1) {
        if (shownRef.current !== target) {
          shownRef.current = target;
          setShown(target);
        }
        return;
      }
      shownRef.current += gap * 0.34;
      setShown(Math.round(shownRef.current));
    }, 200);
    return () => clearInterval(timer);
  }, [target]);

  return shown;
}

function elapsed(sinceMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export interface TopBarProps {
  connection: ConnectionState;
  mode: FeedMode;
  onModeChange: (mode: FeedMode) => void;
  replay: BrainFeed["replay"];
  /** When this page started watching. */
  startedAt: number;
  /** Ledger sum across the whole window. */
  totalAvoided: number;
  /** The part of that which accrued since this page opened. */
  sessionAvoided: number;
  /** Monitor mode drops the controls and keeps only what a glance needs. */
  monitor?: boolean;
}

export function TopBar(props: TopBarProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const avoided = useCountUp(props.totalAvoided);
  const connection = CONNECTION_COPY[props.connection];

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border bg-surface px-5 py-3">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${connection.dot}`} aria-hidden />
        <span className={`font-mono text-xs font-semibold tracking-widest ${connection.tone}`}>
          {connection.label}
        </span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-[0.65rem] uppercase tracking-widest text-muted">Session</span>
        <span className="font-mono text-sm text-text tabular-nums">
          {elapsed(props.startedAt, now)}
        </span>
      </div>

      <div className="ml-auto flex items-baseline gap-3">
        <div className="text-right">
          <div
            className="text-[0.65rem] uppercase tracking-widest text-muted"
            title="Estimated top-tier tokens avoided by delegation: worker input + worker output − orchestrator overhead, floored at zero."
          >
            Estimated tokens avoided
          </div>
          <div className="font-mono text-3xl font-semibold leading-tight text-text tabular-nums">
            {avoided.toLocaleString()}
          </div>
        </div>
        <div className="font-mono text-xs text-muted tabular-nums">
          +{props.sessionAvoided.toLocaleString()} this session
        </div>
      </div>

      {!props.monitor && (
        <div className="flex w-full items-center gap-3 sm:w-auto">
          <div className="seg" role="group" aria-label="Event source">
            <button
              type="button"
              aria-pressed={props.mode === "live"}
              onClick={() => props.onModeChange("live")}
            >
              LIVE
            </button>
            <button
              type="button"
              aria-pressed={props.mode === "replay"}
              onClick={() => props.onModeChange("replay")}
            >
              REPLAY
            </button>
          </div>

          {props.mode === "replay" && (
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-sm" onClick={props.replay.toggle}>
                {props.replay.playing ? "Pause" : "Play"}
              </button>
              <button type="button" className="btn btn-sm" onClick={props.replay.restart}>
                Restart
              </button>
              <div className="seg" role="group" aria-label="Replay speed">
                {REPLAY_SPEEDS.map((speed: ReplaySpeed) => (
                  <button
                    key={speed}
                    type="button"
                    aria-pressed={props.replay.speed === speed}
                    onClick={() => props.replay.setSpeed(speed)}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
              <span className="font-mono text-xs text-muted tabular-nums">
                {props.replay.error
                  ? props.replay.error
                  : `${props.replay.loaded} events · ${Math.round(props.replay.progress * 100)}%`}
              </span>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

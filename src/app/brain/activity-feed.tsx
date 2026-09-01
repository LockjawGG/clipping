"use client";

import { useMemo } from "react";
import type { TelemetryEventRow } from "@/lib/telemetry/types.ts";
import { actorLabel } from "@/lib/telemetry/derive.ts";

/**
 * The right-rail activity log for the Agent Brain page.
 *
 * Pure rendering over whatever rows the caller already fetched: no polling, no
 * EventSource, no fabricated rows. A row's numeric column only ever shows a
 * number that was actually measured — see `trailingOf` below.
 */
export interface ActivityFeedProps {
  /** Newest last. The component renders at most the last 50, newest first. */
  events: TelemetryEventRow[];
  className?: string;
}

const HHMMSS: Intl.DateTimeFormatOptions = {
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

function clockOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toLocaleTimeString(undefined, HHMMSS);
}

/** llm.request.completed is a *.completed event but reads as ongoing traffic,
 *  not a settled outcome, so it keeps the full accent rather than the dimmed
 *  "done" tone. */
function dotClassFor(eventType: string): string {
  switch (eventType) {
    case "task.started":
    case "delegation.started":
    case "llm.request.completed":
      return "bg-accent";
    case "task.completed":
    case "delegation.completed":
      return "bg-accent/40";
    case "task.failed":
      return "bg-danger";
    case "actor.online":
    case "actor.offline":
      return "bg-muted";
    default:
      return "bg-muted";
  }
}

/** Null renders as an absent slash-half rather than a fabricated 0; the whole
 *  column disappears only when nothing at all was measured. */
function trailingOf(event: TelemetryEventRow): string | null {
  const tok =
    event.inputTokens !== null || event.outputTokens !== null
      ? `${event.inputTokens ?? "–"}/${event.outputTokens ?? "–"} tok`
      : null;
  const lat = event.latencyMs !== null ? `${event.latencyMs}ms` : null;
  return [tok, lat].filter(Boolean).join(" · ") || null;
}

function Row({ event }: { event: TelemetryEventRow }) {
  const trailing = trailingOf(event);
  return (
    <li className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className="w-[6.5ch] shrink-0 font-mono tabular-nums text-muted">{clockOf(event.ts)}</span>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClassFor(event.eventType)}`} aria-hidden="true" />
      <span className="shrink-0 font-medium text-text" title={event.actor}>
        {actorLabel(event.actor)}
      </span>
      {event.targetActor && (
        <>
          <span className="shrink-0 text-muted">→</span>
          <span className="shrink-0 text-text" title={event.targetActor}>
            {actorLabel(event.targetActor)}
          </span>
        </>
      )}
      <span className="min-w-0 flex-1 truncate text-muted" title={event.summary}>
        {event.summary}
      </span>
      {trailing && <span className="shrink-0 font-mono text-[11px] text-muted">{trailing}</span>}
    </li>
  );
}

export function ActivityFeed({ events, className }: ActivityFeedProps) {
  // Slice before mapping: capping DOM rows, not just what we choose to show,
  // is what keeps a long-running session's feed from growing the page forever.
  const rows = useMemo(() => events.slice(-50).reverse(), [events]);

  return (
    // No card chrome of its own: this sits inside a rail that already draws a
    // border, and a box inside a box reads as a mistake.
    <div className={`flex min-h-0 flex-col overflow-hidden ${className ?? ""}`}>
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="text-sm text-muted">No activity recorded yet.</p>
          <p className="text-xs text-muted">Events appear here as the app and its agents do measurable work.</p>
        </div>
      ) : (
        <ul className="flex-1 divide-y divide-border overflow-y-auto">
          {rows.map((event) => (
            <Row key={event.id} event={event} />
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";

import { deriveActors, deriveStats } from "@/lib/telemetry/derive.ts";
import type { TelemetryEventRow } from "@/lib/telemetry/types.ts";

/**
 * A compact Agent Brain card, for embedding somewhere the full page would be
 * too much.
 *
 * Standalone-safe: it owns its own polling, needs no props, and renders a
 * plain "not instrumented" state when the endpoint is missing or the window is
 * empty. It polls history rather than holding a stream open — a widget on a
 * dashboard should not cost a socket, and a number that is fifteen seconds old
 * is fine for a glance.
 *
 * Exported but deliberately not wired into any page here; whoever embeds it
 * decides where it belongs.
 */

/** Short window: this is a "what is happening now" card, not a ledger. */
const WINDOW_MS = 30 * 60_000;
const POLL_MS = 15_000;

export interface BrainWidgetProps {
  className?: string;
  /** Where the card links to. Null renders it as a plain, non-clickable card. */
  href?: string | null;
}

export function BrainWidget({ className = "", href = "/brain" }: BrainWidgetProps) {
  const [events, setEvents] = useState<TelemetryEventRow[] | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const since = new Date(Date.now() - WINDOW_MS).toISOString();
        const res = await fetch(`/api/telemetry/history?since=${encodeURIComponent(since)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { events?: TelemetryEventRow[] };
        if (cancelled) return;
        setEvents(body.events ?? []);
        setReachable(true);
      } catch {
        if (!cancelled) setReachable(false);
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const view = useMemo(() => {
    if (!events) return null;
    const nodes = deriveActors(events);
    const stats = deriveStats(events, nodes);
    // Per-minute over the window, not since some notional start: a rate needs a
    // denominator the reader can see.
    const perMinute = Math.round(stats.estimatedTokensAvoided / (WINDOW_MS / 60_000));
    return { nodes, stats, perMinute };
  }, [events]);

  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted">
          Agent Brain
        </span>
        <span className="font-mono text-[0.65rem] text-muted">last 30 min</span>
      </div>

      {!reachable || !view ? (
        <p className="mt-3 text-xs text-muted">not instrumented</p>
      ) : (
        <>
          <div className="mt-3 flex h-5 flex-wrap items-center gap-1.5">
            {view.nodes.length === 0 ? (
              <span className="text-xs text-muted">No activity recorded.</span>
            ) : (
              view.nodes.slice(0, 24).map((node) => (
                <span
                  key={node.id}
                  title={`${node.id} · ${node.state}`}
                  className={`h-2 w-2 rounded-full ${
                    node.state === "error"
                      ? "bg-danger"
                      : node.state === "working"
                        ? "bg-accent"
                        : node.state === "completed"
                          ? "bg-accent/60"
                          : node.probeOnly
                            ? "bg-muted/30"
                            : "bg-muted/60"
                  }`}
                />
              ))
            )}
          </div>

          <div className="mt-3 flex items-baseline gap-2">
            <span
              className="font-mono text-2xl font-semibold text-text tabular-nums"
              title="Estimated top-tier tokens avoided by delegation: worker input + worker output − orchestrator overhead, floored at zero."
            >
              {view.stats.estimatedTokensAvoided.toLocaleString()}
            </span>
            <span className="text-[0.65rem] uppercase tracking-widest text-muted">
              est. tokens avoided
            </span>
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted tabular-nums">
            {view.perMinute.toLocaleString()}/min · {view.stats.actorsActive} active
          </div>
        </>
      )}
    </>
  );

  const classes = `card block p-4 ${className}`;
  return href ? (
    <a href={href} className={`${classes} transition-colors hover:bg-elevated`}>
      {body}
    </a>
  ) : (
    <div className={classes}>{body}</div>
  );
}

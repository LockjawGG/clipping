"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  deriveActors,
  deriveEdges,
  deriveStats,
  pickOrchestrator,
  pulseIntensity,
} from "@/lib/telemetry/derive.ts";

import { ActivityFeed } from "./activity-feed";
import { GraphCanvas, type GraphPulse } from "./graph-canvas";
import { StatsStrip } from "./stats-strip";
import { TopBar } from "./top-bar";
import { useBrainFeed, useInstalledModels } from "./use-brain-feed";

/**
 * The Agent Brain page.
 *
 * Its whole job is to be an honest window: it folds the event buffer into
 * nodes, edges and totals, and renders exactly what that fold produced. There
 * is no seeding, no smoothing over gaps, and no "example" state — an idle
 * machine draws an idle graph.
 *
 * Live and replay feed the same reducer (see use-brain-feed), so what you see
 * replaying is what you would have seen at the time.
 */

/** Pulses older than this are gone from the queue; the canvas caps its own. */
const PULSE_TTL_MS = 2_000;
/** Redraw cadence for state decay (a "completed" flash settling to idle). */
const DECAY_TICK_MS = 1_000;

export function BrainClient({ monitor = false }: { monitor?: boolean }) {
  const feed = useBrainFeed();
  const installedModels = useInstalledModels();

  // A clock tick so node states decay on their own, not only when an event
  // arrives — otherwise a machine that goes quiet freezes mid-flash.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), DECAY_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const [pulses, setPulses] = useState<GraphPulse[]>([]);
  const seenPulse = useRef<Set<string>>(new Set());

  // One pulse per delegation event that actually carried a target. Queued from
  // the flushed batch rather than from the whole buffer, so re-deriving state
  // never replays motion that already happened.
  useEffect(() => {
    const fresh: GraphPulse[] = [];
    for (const event of feed.lastBatch) {
      if (!event.targetActor || event.targetActor === event.actor) continue;
      if (seenPulse.current.has(event.id)) continue;
      seenPulse.current.add(event.id);
      const measured =
        event.inputTokens !== null || event.outputTokens !== null
          ? (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
          : null;
      fresh.push({
        id: event.id,
        from: event.actor,
        to: event.targetActor,
        particles: pulseIntensity(measured),
        direction: event.eventType === "delegation.completed" ? "return" : "outbound",
        startedAt: Date.now(),
      });
    }
    // Bounded, because this page is meant to stay open for hours. Clearing
    // wholesale is safe: the hook has already deduplicated, and this guard only
    // exists to stop one batch from pulsing twice.
    if (seenPulse.current.size > 4000) seenPulse.current = new Set();
    if (fresh.length === 0) return;
    setPulses((current) => {
      const cutoff = Date.now() - PULSE_TTL_MS;
      return [...current.filter((p) => p.startedAt >= cutoff), ...fresh].slice(-60);
    });
  }, [feed.lastBatch]);

  const nodes = useMemo(
    () => deriveActors(feed.events, { installedModels, now: tick }),
    [feed.events, installedModels, tick],
  );
  const edges = useMemo(() => deriveEdges(feed.events), [feed.events]);
  const orchestrator = useMemo(() => pickOrchestrator(edges), [edges]);
  const stats = useMemo(() => deriveStats(feed.events, nodes, tick), [feed.events, nodes, tick]);

  // What accrued since this page opened, as distinct from the whole window.
  const sessionAvoided = useMemo(
    () =>
      feed.events.reduce(
        (total, event) =>
          Date.parse(event.ts) >= feed.startedAt ? total + (event.estimatedTokensAvoided ?? 0) : total,
        0,
      ),
    [feed.events, feed.startedAt],
  );

  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <TopBar
        connection={feed.connection}
        mode={feed.mode}
        onModeChange={feed.setMode}
        replay={feed.replay}
        startedAt={feed.startedAt}
        totalAvoided={stats.estimatedTokensAvoided}
        sessionAvoided={sessionAvoided}
        monitor={monitor}
      />

      <main className="flex min-h-0 flex-1">
        <section className="relative min-w-0 flex-1">
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            orchestrator={orchestrator}
            pulses={pulses}
            className="h-full w-full"
          />
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-muted">No actors seen yet.</p>
              <p className="max-w-sm text-xs text-muted">
                Nodes appear when something measurable happens — a job runs, the local model
                answers, or an agent's activity is relayed in.
              </p>
            </div>
          )}
        </section>

        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
          <div className="border-b border-border px-4 py-2 text-[0.65rem] font-semibold uppercase tracking-widest text-muted">
            Activity
          </div>
          <ActivityFeed events={feed.events} className="min-h-0 flex-1" />
          {!monitor && (
            <p className="border-t border-border px-4 py-2 text-[0.65rem] leading-relaxed text-muted">
              Dim outlines are models installed on this machine that have not run. Session agents
              appear only when their activity is relayed in.
            </p>
          )}
        </aside>
      </main>

      <StatsStrip stats={stats} className="border-t border-border bg-surface" />

      {!monitor && (
        <div className="border-t border-border bg-surface px-5 py-1.5 text-[0.65rem] text-muted">
          <a href="/dashboard" className="hover:text-text">
            ← Workspace
          </a>
          <span className="mx-2 opacity-40">·</span>
          <a href="/brain?monitor=1" className="hover:text-text">
            Monitor mode
          </a>
        </div>
      )}
    </div>
  );
}

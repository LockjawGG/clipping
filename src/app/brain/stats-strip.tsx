"use client";

import type { BrainStats } from "@/lib/telemetry/derive.ts";

/**
 * The bottom stat strip for the Agent Brain page.
 *
 * `stats` is already the honesty-checked shape from `deriveStats` — this
 * component's only job is to keep that honesty visible: a `null` field is a
 * measurement that never happened, and must read as "not instrumented", never
 * as a confident 0 or a bare dash.
 */
export interface StatsStripProps {
  stats: BrainStats;
  className?: string;
}

/** Above 1000ms reads better as seconds; at/under, raw milliseconds are more
 *  legible than "0.8s". */
function formatLatency(ms: number | null): string | null {
  if (ms === null) return null;
  return ms > 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

interface CellProps {
  label: string;
  /** null = never measured. Rendered as literal text, not as 0. */
  value: number | string | null;
  danger?: boolean;
  suffix?: React.ReactNode;
  title?: string;
}

function Cell({ label, value, danger, suffix, title }: CellProps) {
  return (
    <div className="flex min-w-[8rem] flex-1 flex-col justify-center gap-1 px-4 py-3" title={title}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="flex items-baseline gap-1">
        {value === null ? (
          <span className="text-xs text-muted">not instrumented</span>
        ) : (
          <span className={`font-mono text-xl ${danger ? "text-danger" : "text-text"}`}>
            {typeof value === "number" ? value.toLocaleString() : value}
          </span>
        )}
        {value !== null && suffix}
      </span>
    </div>
  );
}

export function StatsStrip({ stats, className }: StatsStripProps) {
  return (
    <div
      className={`flex flex-wrap divide-y divide-border sm:divide-y-0 sm:divide-x ${className ?? ""}`}
    >
      <Cell
        label="Actors active"
        value={stats.actorsActive}
        suffix={<span className="text-xs text-muted">/ {stats.actorsKnown.toLocaleString()} known</span>}
      />
      <Cell label="Tasks running" value={stats.tasksRunning} />
      <Cell label="Completed today" value={stats.tasksCompletedToday} />
      <Cell label="Failed today" value={stats.tasksFailedToday} danger={stats.tasksFailedToday > 0} />
      <Cell label="Tokens used" value={stats.tokensUsed} />
      <Cell
        label="Est. tokens avoided"
        value={stats.estimatedTokensAvoided}
        title="Estimated top-tier tokens avoided by delegation: worker input + worker output − orchestrator overhead, floored at zero."
      />
      <Cell label="Avg latency" value={formatLatency(stats.avgLatencyMs)} />
    </div>
  );
}

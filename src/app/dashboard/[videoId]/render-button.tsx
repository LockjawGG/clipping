"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RenderButton({ clipId, hasRender }: { clipId: string; hasRender: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/render`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "render failed to start");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={busy}
        className="rounded border border-neutral-300 px-2 py-1 text-xs font-medium disabled:opacity-50 dark:border-neutral-700"
      >
        {busy ? "…" : hasRender ? "Re-render" : "Render"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

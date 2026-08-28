"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function FromUrlForm({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/videos/from-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), projectId }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "could not start");
      setUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <input
        type="url"
        required
        placeholder="Paste a video link (YouTube, …)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="field w-full"
      />
      <button type="submit" disabled={busy || url.trim() === ""} className="btn w-full">
        {busy ? "Starting…" : "Add from link"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}

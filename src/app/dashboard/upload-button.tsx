"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = "idle" | "creating" | "uploading" | "starting" | "done" | "error";

export function UploadButton() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function onFile(file: File) {
    setMessage(null);
    try {
      setPhase("creating");
      const createRes = await fetch("/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || "video/mp4",
          sizeBytes: file.size,
        }),
      });
      if (!createRes.ok) throw new Error((await createRes.json()).error ?? "could not start upload");
      const { videoId, upload } = await createRes.json();

      setPhase("uploading");
      const putRes = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
      if (!putRes.ok) throw new Error(`upload failed (${putRes.status})`);

      setPhase("starting");
      const ingestRes = await fetch(`/api/videos/${videoId}/ingest`, { method: "POST" });
      if (!ingestRes.ok) throw new Error((await ingestRes.json()).error ?? "could not start processing");

      setPhase("done");
      router.refresh();
      setTimeout(() => setPhase("idle"), 1500);
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "something went wrong");
    }
  }

  const busy = phase === "creating" || phase === "uploading" || phase === "starting";

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {phase === "idle" && "Upload a video"}
        {phase === "creating" && "Preparing…"}
        {phase === "uploading" && "Uploading…"}
        {phase === "starting" && "Starting…"}
        {phase === "done" && "Queued ✓"}
        {phase === "error" && "Try again"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onFile(file);
        }}
      />
      {message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = "idle" | "creating" | "uploading" | "starting" | "done" | "error";

export function UploadButton({ projectId }: { projectId?: string }) {
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
          projectId,
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
        className="btn btn-primary w-full"
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
      {message && <p className="text-sm text-danger">{message}</p>}
    </div>
  );
}

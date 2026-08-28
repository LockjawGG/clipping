"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { SignOutButton } from "./sign-out-button";

export interface ProjectSummary {
  id: string;
  name: string;
  videoCount: number;
}
export interface FavoriteClip {
  id: string;
  title: string;
  videoId: string;
  videoName: string;
  thumbnailUrl: string | null;
}

export function ProjectRail({
  projects,
  activeProjectId,
  favorites,
}: {
  projects: ProjectSummary[];
  activeProjectId: string;
  favorites: FavoriteClip[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const close = () => setMenuFor(null);
    if (menuFor) document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuFor]);

  const go = (params: Record<string, string>) =>
    router.push(`/dashboard?${new URLSearchParams(params).toString()}`);

  async function api(method: string, url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `${method} failed`);
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createProject() {
    const name = draftName.trim();
    if (!name) return setCreating(false);
    const created = await api("POST", "/api/projects", { name });
    setCreating(false);
    setDraftName("");
    if (created?.id) go({ project: created.id });
    else router.refresh();
  }

  async function rename(id: string, name: string) {
    setRenaming(null);
    if (!name.trim()) return;
    await api("PATCH", `/api/projects/${id}`, { name: name.trim() });
    router.refresh();
  }

  async function remove(id: string) {
    setMenuFor(null);
    const ok = await api("DELETE", `/api/projects/${id}`);
    if (!ok) return;
    if (id === activeProjectId) {
      const next = projects.find((p) => p.id !== id);
      if (next) return go({ project: next.id });
    }
    router.refresh();
  }

  return (
    <nav className="rail px-2 pb-6">
      <div className="flex items-center justify-between px-2.5 pb-2 pt-4">
        <span className="text-sm font-semibold">Clipper</span>
        <SignOutButton />
      </div>

      <div className="flex items-center justify-between">
        <span className="rail-heading">Projects</span>
        <button
          className="btn btn-ghost btn-sm mr-1"
          onClick={() => setCreating(true)}
          aria-label="New project"
        >
          +
        </button>
      </div>

      {creating && (
        <input
          autoFocus
          className="field mx-1 mb-1 w-[calc(100%-0.5rem)]"
          placeholder="Project name"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={createProject}
          onKeyDown={(e) => {
            if (e.key === "Enter") createProject();
            if (e.key === "Escape") {
              setCreating(false);
              setDraftName("");
            }
          }}
        />
      )}

      {projects.map((p) => (
        <div key={p.id} className="relative">
          {renaming === p.id ? (
            <input
              autoFocus
              defaultValue={p.name}
              className="field mx-1 my-0.5 w-[calc(100%-0.5rem)]"
              onBlur={(e) => rename(p.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(p.id, (e.target as HTMLInputElement).value);
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              className="rail-item"
              aria-current={p.id === activeProjectId}
              onClick={() => go({ project: p.id })}
              onDoubleClick={() => setRenaming(p.id)}
              title="Double-click to rename"
            >
              <span className="flex-1 truncate">{p.name}</span>
              <span className="chip">{p.videoCount}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label="Project menu"
                className="rounded px-1 text-muted hover:bg-surface hover:text-text"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === p.id ? null : p.id);
                }}
              >
                ⋯
              </span>
            </button>
          )}
          {menuFor === p.id && (
            <div className="menu right-2 top-9">
              <button onClick={() => setRenaming(p.id)}>Rename</button>
              <button className="text-danger" onClick={() => remove(p.id)}>
                Delete project
              </button>
            </div>
          )}
        </div>
      ))}

      <span className="rail-heading">Saved clips</span>
      {favorites.length === 0 ? (
        <p className="px-2.5 text-xs text-muted">Star a clip to keep it here.</p>
      ) : (
        favorites.map((c) => (
          <button
            key={c.id}
            className="rail-item"
            onClick={() => go({ project: activeProjectId, video: c.videoId })}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL */}
            <img
              src={c.thumbnailUrl ?? undefined}
              alt=""
              className="h-8 w-12 shrink-0 rounded bg-surface-raised object-cover"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.title}</span>
              <span className="block truncate text-xs text-muted">{c.videoName}</span>
            </span>
          </button>
        ))
      )}

      {(error || busy) && (
        <p className="px-2.5 pt-2 text-xs text-danger">{error ?? "working…"}</p>
      )}
    </nav>
  );
}

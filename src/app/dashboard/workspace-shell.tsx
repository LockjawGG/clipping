"use client";

import { useState, type ReactNode } from "react";

import { APP_CHANNEL_BADGE, APP_IDENTITY } from "@/lib/app-identity.ts";

/**
 * Three-pane workspace: project rail | editor | content rail.
 * Desktop shows all three; below ~1100px the rails become slide-over drawers.
 */
export function WorkspaceShell({
  left,
  right,
  children,
}: {
  left: ReactNode;
  right: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<"left" | "right" | null>(null);

  return (
    <div className="mx-auto flex h-[100dvh] max-w-[1600px] flex-col">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2 xl:hidden">
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen("left")}>
          ☰ Projects
        </button>
        <span className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold">{APP_IDENTITY.name}</span>
          {APP_IDENTITY.isBeta && <span className="chip">{APP_CHANNEL_BADGE}</span>}
        </span>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen("right")}>
          Content ☰
        </button>
      </div>

      {/* grid-rows minmax(0,1fr): without it the single implicit row sizes to
          its tallest pane, so a tall rail (Settings) stretches the whole page
          instead of scrolling inside itself. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_340px]">
        {/* Left rail — desktop */}
        <aside className="hidden min-h-0 border-r border-border xl:block">{left}</aside>

        {/* Center */}
        <main className="min-w-0 overflow-y-auto px-5 py-6 md:px-8">{children}</main>

        {/* Right rail — desktop */}
        <aside className="hidden min-h-0 border-l border-border xl:block">{right}</aside>
      </div>

      {/* Drawers */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 xl:hidden"
          onClick={() => setOpen(null)}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-[320px] flex-col border-r border-border bg-bg transition-transform xl:hidden ${
          open === "left" ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Projects</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">{left}</div>
      </aside>
      <aside
        className={`fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-[340px] flex-col border-l border-border bg-bg transition-transform xl:hidden ${
          open === "right" ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">Content</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">{right}</div>
      </aside>
    </div>
  );
}

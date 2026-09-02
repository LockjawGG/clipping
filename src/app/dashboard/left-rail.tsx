"use client";

import { useState } from "react";

import { APP_CHANNEL_BADGE, APP_IDENTITY } from "@/lib/app-identity.ts";

import { SignOutButton } from "./sign-out-button";
import { ProjectRail, type ProjectSummary, type FavoriteClip } from "./project-rail";
import { MediaLibrary, type AssetView } from "./media-library";
import { TrainingRail } from "./training-rail";
import { SettingsRail } from "./settings-rail";

/** Left column: a Projects / Media / Training / Settings tab switch above the panels. */
export function LeftRail({
  projects,
  activeProjectId,
  favorites,
  assets,
  showSignOut = true,
}: {
  projects: ProjectSummary[];
  activeProjectId: string;
  favorites: FavoriteClip[];
  assets: AssetView[];
  /** Desktop runs as a single local user, where signing out means nothing. */
  showSignOut?: boolean;
}) {
  const [tab, setTab] = useState<"projects" | "media" | "training" | "settings">("projects");

  return (
    <div className="rail flex h-full min-h-0 flex-col px-0">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        {/* The wordmark carries the channel: this build runs beside a
            production Clipper, and "which one am I in" has to be answerable
            without opening a menu. */}
        <span className="flex items-baseline gap-1.5">
          <span className="text-sm font-semibold">{APP_IDENTITY.name}</span>
          {APP_IDENTITY.isBeta && <span className="chip">{APP_CHANNEL_BADGE}</span>}
        </span>
        {showSignOut && <SignOutButton />}
      </div>

      {/* Four tabs in a 280px rail: the tighter padding keeps them on one row. */}
      <div role="tablist" className="tabs mx-3 mb-1 self-start">
        <button role="tab" aria-selected={tab === "projects"} className="tab px-2" onClick={() => setTab("projects")}>
          Projects
        </button>
        <button role="tab" aria-selected={tab === "media"} className="tab px-2" onClick={() => setTab("media")}>
          Media
        </button>
        <button
          role="tab"
          aria-selected={tab === "training"}
          className="tab px-2"
          onClick={() => setTab("training")}
          title="What the editor has learned from your finished edits"
        >
          Training
        </button>
        <button
          role="tab"
          aria-selected={tab === "settings"}
          className="tab px-2"
          onClick={() => setTab("settings")}
          title="Defaults for new clips, narration, transcription, storage & backup"
        >
          Settings
        </button>
      </div>

      {tab === "projects" && (
        <ProjectRail projects={projects} activeProjectId={activeProjectId} favorites={favorites} />
      )}
      {tab === "media" && <MediaLibrary assets={assets} />}
      {tab === "training" && <TrainingRail />}
      {tab === "settings" && <SettingsRail />}
    </div>
  );
}

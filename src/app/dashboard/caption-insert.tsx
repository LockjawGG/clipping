"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Tracks which clip the editor is "on" so the Add-content rail can insert a
 * caption into it. The editor renders every clip in a stack — there is no route
 * for a single active clip — so a `ClipEditor` claims focus on interaction and
 * the rail's Insert-caption button targets whatever is focused.
 */
interface CaptionInsertCtx {
  focusedClipId: string | null;
  setFocusedClipId: (id: string | null) => void;
}

const Ctx = createContext<CaptionInsertCtx>({
  focusedClipId: null,
  setFocusedClipId: () => {},
});

export function CaptionInsertProvider({ children }: { children: ReactNode }) {
  const [focusedClipId, setFocusedClipId] = useState<string | null>(null);
  return <Ctx.Provider value={{ focusedClipId, setFocusedClipId }}>{children}</Ctx.Provider>;
}

export const useCaptionInsert = () => useContext(Ctx);

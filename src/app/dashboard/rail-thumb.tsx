"use client";

import { useState } from "react";

/**
 * A thumbnail tile for the rails. Falls back to a plain surface tile when the
 * URL is missing or fails to load (expired token, 404, still-ingesting video) —
 * never a broken-image glyph.
 */
export function RailThumb({
  url,
  className = "h-9 w-14",
}: {
  url: string | null | undefined;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const base = `shrink-0 rounded bg-surface-raised object-cover ${className}`;

  if (!url || broken) return <span className={base} aria-hidden />;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
    <img
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={base}
    />
  );
}

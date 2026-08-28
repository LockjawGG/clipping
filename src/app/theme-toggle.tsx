"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

/** Floating light/dark switch. Explicit choice persists and overrides the OS. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("theme");
    } catch {
      /* private mode */
    }
    if (stored === "light" || stored === "dark") setTheme(stored);
    else setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  function apply(next: Theme) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore */
    }
  }

  if (!theme) return null;
  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => apply(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="fixed bottom-4 right-4 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface text-base text-text shadow-card transition-colors hover:bg-elevated"
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}

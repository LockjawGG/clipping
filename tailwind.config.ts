import type { Config } from "tailwindcss";

/** `rgb(var(--x) / <alpha>)` so opacity utilities keep working on tokens. */
const token = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: token("--c-bg"),
        surface: token("--c-surface"),
        "surface-raised": token("--c-surface-raised"),
        border: token("--c-border"),
        text: token("--c-text"),
        muted: token("--c-muted"),
        accent: token("--c-accent"),
        "accent-fg": token("--c-accent-fg"),
        danger: token("--c-danger"),
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        xl: "0.875rem",
      },
      boxShadow: {
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px -8px rgb(0 0 0 / 0.10)",
      },
    },
  },
  plugins: [],
} satisfies Config;

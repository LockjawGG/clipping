"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { duckLabel, DUCK_SILENT_DB } from "@/lib/voiceover/duck.ts";
import { TRANSLATE_TARGETS } from "@/lib/translation/targets.ts";
import { CAPTION_PRESET_IDS } from "@/lib/api/settings.ts";

/**
 * The Settings tab.
 *
 * Every control saves itself the moment it settles (change for discrete
 * controls, release for sliders) and answers with a quiet "Saved ✓" — there is
 * no Save button to forget. Each row says what it affects and *when*: most of
 * these are starting points for new clips and narrations, and pretending they
 * rewrite existing ones would be a lie the editor would then have to keep.
 */

type Settings = {
  censorAllowList: string[];
  censorDenyList: string[];
  transcriptionQuality: "accurate" | "fast";
  transcriptionLanguage: string;
  voiceId: string;
  duckDb: number;
  voiceSpeed: number;
  playlistMax: number;
  defaultCaptionPreset: string;
  defaultAspectRatio: string;
};

type Voice = { id: string; label: string; language: string };

const LANG_LABELS: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", ru: "Russian", pl: "Polish", uk: "Ukrainian",
  tr: "Turkish", ar: "Arabic", he: "Hebrew", hi: "Hindi", ja: "Japanese",
  ko: "Korean", zh: "Chinese", vi: "Vietnamese", th: "Thai", id: "Indonesian",
  sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian", hu: "Hungarian",
};

const PRESET_LABELS: Record<string, string> = {
  CLASSIC: "Classic",
  BOLD: "Bold",
  VIRAL: "Viral",
  MINIMAL: "Minimal",
  KARAOKE: "Karaoke",
};

const ASPECTS = [
  { id: "VERTICAL_9_16", label: "9:16 vertical" },
  { id: "SQUARE_1_1", label: "1:1 square" },
  { id: "LANDSCAPE_16_9", label: "16:9 landscape" },
  { id: "PORTRAIT_4_5", label: "4:5 portrait" },
];

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Chip editor for a word list: type, Enter or Add, click a chip to remove. */
function WordList({
  words,
  tone,
  placeholder,
  onChange,
}: {
  words: string[];
  tone: "keep" | "censor";
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const w = draft.trim().toLowerCase();
    if (!w || words.includes(w)) return setDraft("");
    onChange([...words, w]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      {words.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {words.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onChange(words.filter((x) => x !== w))}
              className={`pill text-xs ${tone === "censor" ? "border-danger/40 text-danger" : ""}`}
              title="Remove"
            >
              {w} ✕
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder={placeholder}
          className="field min-w-0 flex-1 py-1 text-xs"
        />
        <button type="button" onClick={add} disabled={!draft.trim()} className="btn btn-ghost btn-sm">
          Add
        </button>
      </div>
    </div>
  );
}

export function SettingsRail() {
  const [s, setS] = useState<Settings | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [storage, setStorage] = useState<{ totalBytes: number; orphanBytes: number; orphanCount: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupNote, setBackupNote] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings").then((r) => (r.ok ? r.json() : null)).then(setS).catch(() => setError("could not load settings"));
    void fetch("/api/tts/voices").then((r) => (r.ok ? r.json() : null)).then((b) => setVoices(b?.voices ?? [])).catch(() => {});
    void fetch("/api/settings/storage").then((r) => (r.ok ? r.json() : null)).then(setStorage).catch(() => {});
  }, []);

  // Saves are serialized: two quick changes are two PUTs, and firing them
  // concurrently lets the later one clobber the earlier one server-side.
  const saveQueue = useRef(Promise.resolve());
  const save = useCallback((patch: Partial<Settings>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    setError(null);
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error();
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1600);
      } catch {
        setError("that change didn't save — try again");
      }
    });
    return saveQueue.current;
  }, []);

  const cleanUp = async () => {
    setCleaning(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/storage", { method: "POST" });
      if (!res.ok) throw new Error();
      // Fresh numbers, so the panel shows what the cleanup actually reclaimed.
      const after = await fetch("/api/settings/storage");
      if (after.ok) setStorage(await after.json());
    } catch {
      setError("clean-up failed");
    } finally {
      setCleaning(false);
    }
  };

  const backUp = async () => {
    setBackingUp(true);
    setBackupNote(null);
    try {
      const res = await fetch("/api/settings/backup", { method: "POST" });
      const body = (await res.json()) as { file?: string; sizeBytes?: number; error?: string };
      if (!res.ok) throw new Error(body.error);
      setBackupNote(`Backed up ${fmtBytes(body.sizeBytes ?? 0)} → ${body.file}`);
    } catch (e) {
      setBackupNote(e instanceof Error && e.message ? e.message : "backup failed");
    } finally {
      setBackingUp(false);
    }
  };

  if (!s) {
    return <p className="px-4 py-6 text-center text-xs text-muted">{error ?? "Loading settings…"}</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-4 py-1.5">
        <span className="text-xs text-muted">Changes apply to new clips &amp; narrations</span>
        <span className={`text-xs text-accent transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}>Saved ✓</span>
      </div>
      {error && <p className="px-4 pt-2 text-xs text-danger">{error}</p>}

      <Section title="Censoring" hint="Starting lists for every new clip — each clip stays editable on its own.">
        <label className="text-xs font-medium">Always allow</label>
        <WordList words={s.censorAllowList} tone="keep" placeholder="a word the censor should ignore"
          onChange={(w) => save({ censorAllowList: w })} />
        <label className="mt-1 text-xs font-medium">Always censor</label>
        <WordList words={s.censorDenyList} tone="censor" placeholder="a word to always mask & bleep"
          onChange={(w) => save({ censorDenyList: w })} />
      </Section>

      <Section title="Transcription">
        <div className="seg self-start">
          <button type="button" aria-pressed={s.transcriptionQuality === "accurate"}
            onClick={() => save({ transcriptionQuality: "accurate" })}>
            Accurate
          </button>
          <button type="button" aria-pressed={s.transcriptionQuality === "fast"}
            onClick={() => save({ transcriptionQuality: "fast" })}>
            Fast
          </button>
        </div>
        <p className="text-xs text-muted">
          {s.transcriptionQuality === "accurate"
            ? "The most careful reading of unclear speech. Takes the longest."
            : "About 25% quicker — same engine, a lighter search. Punctuation may be a touch rougher."}
        </p>
        <label className="mt-1 flex items-center gap-2 text-xs">
          Language
          <select value={s.transcriptionLanguage} onChange={(e) => save({ transcriptionLanguage: e.target.value })}
            className="field py-0.5 text-xs">
            <option value="">Detect automatically</option>
            {TRANSLATE_TARGETS.map((c) => (
              <option key={c} value={c}>{LANG_LABELS[c] ?? c}</option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted">Pin this if your videos are always in one language.</p>
      </Section>

      <Section title="Narration" hint="Defaults for new narrations.">
        <label className="flex items-center gap-2 text-xs">
          Voice
          <select value={s.voiceId} onChange={(e) => save({ voiceId: e.target.value })} className="field py-0.5 text-xs">
            <option value="">App default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label} · {v.language}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs"
          title="How far the clip's own audio drops while narration plays. Silent means the narration fully covers it.">
          <span className="w-24 shrink-0">Duck · {duckLabel(s.duckDb)}</span>
          {/* Drag updates the label live; the write happens on release/blur so a
              drag is one save, and arrow-key nudges still land via blur. */}
          <input type="range" min={DUCK_SILENT_DB} max={0} step={1} value={s.duckDb}
            onChange={(e) => setS({ ...s, duckDb: Number(e.target.value) })}
            onPointerUp={(e) => save({ duckDb: Number((e.target as HTMLInputElement).value) })}
            onBlur={(e) => save({ duckDb: Number(e.target.value) })}
            className="min-w-0 flex-1" />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0">Speed · {s.voiceSpeed.toFixed(2)}×</span>
          <input type="range" min={0.5} max={2} step={0.05} value={s.voiceSpeed}
            onChange={(e) => setS({ ...s, voiceSpeed: Number(e.target.value) })}
            onPointerUp={(e) => save({ voiceSpeed: Number((e.target as HTMLInputElement).value) })}
            onBlur={(e) => save({ voiceSpeed: Number(e.target.value) })}
            className="min-w-0 flex-1" />
        </label>
      </Section>

      <Section title="New clips" hint="What every new clip starts from.">
        <label className="flex items-center gap-2 text-xs">
          Caption style
          <select value={s.defaultCaptionPreset} onChange={(e) => save({ defaultCaptionPreset: e.target.value })}
            className="field py-0.5 text-xs">
            {CAPTION_PRESET_IDS.map((p) => (
              <option key={p} value={p}>{PRESET_LABELS[p] ?? p}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          Aspect ratio
          <select value={s.defaultAspectRatio} onChange={(e) => save({ defaultAspectRatio: e.target.value })}
            className="field py-0.5 text-xs">
            {ASPECTS.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </label>
      </Section>

      <Section title="Importing">
        <label className="flex items-center gap-2 text-xs">
          Playlist limit
          {/* Commits on blur/Enter, not per keystroke — clamping while someone
              is mid-typing "150" would rewrite the field under them. */}
          <input type="number" min={1} max={500} defaultValue={s.playlistMax}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              const n = Math.max(1, Math.min(500, Math.round(Number(e.target.value)) || 100));
              e.target.value = String(n);
              if (n !== s.playlistMax) void save({ playlistMax: n });
            }}
            className="field w-20 py-0.5 text-xs" />
          videos
        </label>
        <p className="text-xs text-muted">
          The most one pasted playlist link will import. A limit matters: some auto-generated playlists are endless.
        </p>
      </Section>

      <Section title="Storage">
        {storage ? (
          <>
            <p className="text-xs">
              <span className="font-medium">{fmtBytes(storage.totalBytes)}</span>
              <span className="text-muted"> in your library</span>
              {storage.orphanCount > 0 && (
                <span className="text-muted"> · {fmtBytes(storage.orphanBytes)} reclaimable</span>
              )}
            </p>
            <button type="button" onClick={cleanUp} disabled={cleaning || storage.orphanCount === 0}
              className="btn btn-ghost btn-sm self-start"
              title={storage.orphanCount === 0 ? "Nothing unused to remove" : `Removes ${storage.orphanCount} files nothing uses any more`}>
              {cleaning ? "Cleaning…" : storage.orphanCount === 0 ? "Nothing to clean up" : `Clean up ${fmtBytes(storage.orphanBytes)}`}
            </button>
            <p className="text-xs text-muted">Only removes files whose video, clip or narration was deleted.</p>
          </>
        ) : (
          <p className="text-xs text-muted">Measuring…</p>
        )}
      </Section>

      <Section title="Backup" hint="Saves your library's database — clips, transcripts, edits — to a file.">
        <button type="button" onClick={backUp} disabled={backingUp} className="btn btn-ghost btn-sm self-start">
          {backingUp ? "Backing up…" : "Back up now"}
        </button>
        {backupNote && <p className="break-all text-xs text-muted">{backupNote}</p>}
      </Section>
    </div>
  );
}

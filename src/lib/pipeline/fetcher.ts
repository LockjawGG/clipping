import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * yt-dlp treats `-o` as a template: with no `%(ext)s` it appends `.<ext>`, so the
 * file lands *beside* `outputPath` (e.g. `source.mp4`), not at it. The rest of
 * the pipeline addresses the source by the exact, extension-less path, so move
 * whatever yt-dlp produced into place.
 */
async function normalizeDownload(outputPath: string): Promise<void> {
  try {
    await stat(outputPath);
    return; // yt-dlp wrote exactly where we asked
  } catch {
    // fall through and look for `<name>.<ext>` next to it
  }
  const dir = dirname(outputPath);
  const name = basename(outputPath);
  const produced = (await readdir(dir))
    .filter((e) => e.startsWith(`${name}.`) && !e.endsWith(".part"))
    .sort();
  if (produced.length === 0) throw new Error(`yt-dlp produced no output file for ${name}`);
  await rename(join(dir, produced[0]), outputPath);
}

/** Delete a half-finished download and any `.part` / `<name>.<ext>` siblings. */
async function cleanupPartials(outputPath: string): Promise<void> {
  const dir = dirname(outputPath);
  const name = basename(outputPath);
  await rm(outputPath, { force: true }).catch(() => {});
  try {
    for (const e of await readdir(dir)) {
      if (e === name || e.startsWith(`${name}.`) || e.endsWith(".part")) {
        await rm(join(dir, e), { force: true }).catch(() => {});
      }
    }
  } catch {
    /* dir may not exist */
  }
}

/** Largest source height we pull — the clipper never outputs above 1080p. */
export const MAX_SOURCE_HEIGHT = 1080;

export type FetchErrorKind =
  | "unsupported"
  | "unavailable"
  | "auth"
  | "restricted"
  | "network"
  | "no_stream"
  | "too_large"
  | "not_installed"
  | "wont_start"
  | "unknown";

/** A fetch failure with a user-facing message plus the raw tail for debugging. */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;
  readonly technical: string;

  constructor(kind: FetchErrorKind, message: string, technical = "") {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.technical = technical;
  }
}

const FRIENDLY: Record<FetchErrorKind, string> = {
  unsupported: "That link isn’t from a video source this app can read.",
  unavailable: "The video is unavailable — it may have been removed or made private.",
  auth: "This video needs an account to access, so it can’t be pulled in automatically.",
  restricted: "Access to this video is restricted (region-locked or blocked).",
  network: "Couldn’t reach the video source. Check the connection and try again.",
  no_stream: "Found the page, but couldn’t get a usable media stream from it.",
  too_large: "That source is larger than the size limit.",
  not_installed: "The media downloader (yt-dlp) isn’t installed or isn’t on the path.",
  wont_start:
    "yt-dlp is installed but failed to start. Reinstall it (e.g. `pip install -U --force-reinstall yt-dlp`) or point YTDLP_PATH at a standalone build.",
  unknown: "Couldn’t get media from that link.",
};

/**
 * Windows process exit codes for "the exe exists but its runtime won't load":
 * 0xC0000142 STATUS_DLL_INIT_FAILED, 0xC0000135 STATUS_DLL_NOT_FOUND,
 * 0xC000007B STATUS_INVALID_IMAGE_FORMAT. Common with winget-packaged binaries
 * launched from a non-console parent.
 */
const WONT_START_EXIT_CODES = new Set([3221225794, 3221225781, 3221225595]);

/**
 * Map a yt-dlp stderr dump to a `{ kind, message }` a normal user can act on.
 * Pure and order-sensitive: more specific signatures are checked first.
 */
export function classifyFetchError(stderr: string): { kind: FetchErrorKind; message: string } {
  const s = stderr.toLowerCase();
  const is = (re: RegExp) => re.test(s);

  let kind: FetchErrorKind = "unknown";
  if (is(/larger than.*max-filesize|file is larger|exceeds the maximum|filesize.*limit/)) {
    kind = "too_large";
  } else if (
    is(/sign in|log ?in|login required|requires authentication|private video|members-only|member's only|age[- ]restricted|confirm your age|use --cookies|this video is only available/)
  ) {
    kind = "auth";
  } else if (
    is(/not available in your (country|region|location)|geo[- ]?restrict|geoblock|blocked it in your country|content is not available in your|http error 451/)
  ) {
    kind = "restricted";
  } else if (
    is(/video unavailable|this video (is|has been) (removed|deleted|no longer)|has been removed|is no longer available|content isn'?t available|account (has been )?terminated|this video does not exist|removed by the uploader/)
  ) {
    kind = "unavailable";
  } else if (
    is(/unable to download (webpage|api page|json|m3u8)|getaddrinfo|failed to resolve|connection (reset|refused|timed out|aborted)|network is unreachable|temporary failure in name resolution|read timed out|timed out|urlopen error|ssl:|remote end closed/)
  ) {
    kind = "network";
  } else if (
    is(/unsupported url|is not a valid url|no suitable inforextractor|unable to extract webpage|generic.*could not|does not pass url validation/)
  ) {
    kind = "unsupported";
  } else if (
    is(/requested format is not available|no video formats found|unable to extract (video )?(url|data|formats|player)|there'?s no video|no media found|no formats found|forbidden|http error 403/)
  ) {
    kind = "no_stream";
  }
  return { kind, message: FRIENDLY[kind] };
}

export interface FetchResult {
  /** The source's own title, if the downloader reported one. */
  title?: string;
  durationSec?: number;
}

/** What an analyze/preview step surfaces before committing to a download. */
export interface ProbeResult {
  supported: boolean;
  title?: string;
  durationSec?: number;
  thumbnail?: string;
  /** Extractor name, cleaned for display ("YouTube", "Vimeo", "generic"…). */
  source?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  approxBytes?: number;
  isLive: boolean;
}

/**
 * Downloads a video from a URL (YouTube, Vimeo, a direct link, …) to a local
 * file so the rest of the pipeline can treat it exactly like an upload.
 * `onProgress` reports a 0..1 download fraction as it streams.
 */
export interface MediaFetcher {
  readonly name: string;
  fetch(
    url: string,
    outputPath: string,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<FetchResult>;
}

/** The subset an analyze endpoint needs — no download. */
export interface MediaProbe {
  probe(url: string, signal?: AbortSignal): Promise<ProbeResult>;
  /**
   * Enumerate a playlist link. Resolves null when the link is a single video
   * after all, so callers can fall back to the ordinary path.
   */
  probePlaylist(url: string, signal?: AbortSignal): Promise<PlaylistProbeResult | null>;
  version(): Promise<string | null>;
}

export interface YtDlpFetcherOptions {
  /** Path to the yt-dlp binary. */
  binPath: string;
  /** Refuse downloads larger than this many bytes. */
  maxBytes: number;
  /**
   * Browser to impersonate for HTTP (yt-dlp `--impersonate`). Rumble and other
   * Cloudflare-fronted hosts 403 yt-dlp's default TLS fingerprint; a real
   * browser fingerprint (via the bundled curl_cffi) gets through. Default
   * `"chrome"`; set to `""` to disable.
   */
  impersonate?: string;
}

/** Build the yt-dlp argv for one fetch. `impersonate` empty ⇒ flag omitted. */
export function buildYtDlpArgs(
  url: string,
  outputPath: string,
  maxBytes: number,
  impersonate: string,
): string[] {
  const maxMb = Math.max(1, Math.floor(maxBytes / (1024 * 1024)));
  return [
    url,
    "--no-playlist",
    "--no-warnings",
    // Newline-terminated, machine-parseable progress on stdout: `DLP <pct>`.
    // `--progress` is required because `--print-json` otherwise implies quiet.
    "--newline",
    "--progress",
    "--progress-template",
    "DLP %(progress._percent_str)s",
    ...(impersonate ? ["--impersonate", impersonate] : []),
    "--max-filesize",
    `${maxMb}M`,
    // Never pull more than the clipper can use: prefer <=1080p, muxed mp4.
    "-S",
    `res:${MAX_SOURCE_HEIGHT},ext:mp4:m4a`,
    // Prefer a single already-muxed mp4, then mp4 video with m4a audio. The
    // third branch is the one that matters: plenty of sources offer no muxed
    // format at all and no mp4/m4a streams either — VP9 or AV1 video with opus
    // audio in webm is ordinary on YouTube now — and without a codec-agnostic
    // fallback yt-dlp answers "Requested format is not available" for a video
    // it could perfectly well have fetched. `--merge-output-format mp4` below
    // still lands it as mp4. Bare `b` stays last: it only ever matches a muxed
    // format, so it is a fallback for the odd source, not for these.
    "-f",
    "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outputPath,
    "--print-json",
    "--no-simulate",
  ];
}

/**
 * Does this link name a collection rather than one video?
 *
 * Deliberately conservative: only URLs that carry an explicit playlist marker.
 * A plain watch link never becomes a surprise 50-video import, and a watch
 * link *with* `list=` is how people actually share playlists, so it counts.
 */
export function isLikelyPlaylistUrl(url: string): boolean {
  return /[?&]list=/.test(url) || /\/playlist([/?#]|$)/.test(url);
}

/**
 * Argv for enumerating a playlist without downloading anything.
 *
 * `--flat-playlist` returns one small entry per video instead of probing each
 * one — the difference between a second and many minutes on a long list.
 */
export function buildPlaylistProbeArgs(url: string, impersonate: string): string[] {
  return [
    url,
    "--yes-playlist",
    "--flat-playlist",
    "--no-warnings",
    "--skip-download",
    "--dump-single-json",
    ...(impersonate ? ["--impersonate", impersonate] : []),
  ];
}

export interface PlaylistEntry {
  url: string;
  title?: string;
  durationSec?: number;
}

export interface PlaylistProbeResult {
  title: string | null;
  /** What the source says the playlist holds, before any cap. */
  total: number;
  entries: PlaylistEntry[];
}

/** Pure: yt-dlp's flat-playlist JSON → entries. Exported for tests. */
export function parsePlaylistJson(j: Record<string, unknown>): PlaylistProbeResult | null {
  if (j._type !== "playlist" || !Array.isArray(j.entries)) return null;
  const entries: PlaylistEntry[] = [];
  for (const raw of j.entries as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    // Flat entries carry `url` on most extractors; YouTube sometimes only `id`.
    const url =
      (typeof raw.url === "string" && raw.url) ||
      (typeof raw.id === "string" && raw.id
        ? `https://www.youtube.com/watch?v=${raw.id}`
        : null);
    if (!url) continue;
    entries.push({
      url,
      ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}),
      ...(typeof raw.duration === "number" ? { durationSec: Math.round(raw.duration) } : {}),
    });
  }
  return {
    title: typeof j.title === "string" ? j.title : null,
    total: typeof j.playlist_count === "number" ? j.playlist_count : entries.length,
    entries,
  };
}

/** Build the yt-dlp argv for an info-only probe (no download). */
export function buildProbeArgs(url: string, impersonate: string): string[] {
  return [
    url,
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    "--dump-single-json",
    ...(impersonate ? ["--impersonate", impersonate] : []),
  ];
}

/** Clean an extractor key like `YoutubeTab` / `generic` for display. */
function displaySource(j: { extractor_key?: string; extractor?: string }): string | undefined {
  const raw = j.extractor_key || j.extractor;
  if (!raw) return undefined;
  if (/^generic$/i.test(raw)) return "generic";
  return raw.replace(/(Tab|IE|Playlist|Video|User|Channel)$/i, "").replace(/^Youtube$/i, "YouTube");
}

/** `yt-dlp`-backed fetcher. Requires the binary on PATH (or an explicit path). */
export class YtDlpFetcher implements MediaFetcher, MediaProbe {
  readonly name = "yt-dlp";

  private readonly binPath: string;
  private readonly maxBytes: number;
  private readonly impersonate: string;

  constructor(opts: YtDlpFetcherOptions) {
    this.binPath = opts.binPath;
    this.maxBytes = opts.maxBytes;
    this.impersonate = opts.impersonate ?? "chrome";
  }

  async fetch(
    url: string,
    outputPath: string,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<FetchResult> {
    await mkdir(dirname(outputPath), { recursive: true });

    let impersonate = this.impersonate;
    for (;;) {
      const { jsonLine, stderr, code, spawnError } = await this.run(
        buildYtDlpArgs(url, outputPath, this.maxBytes, impersonate),
        signal,
        onProgress,
      );

      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new FetchError(
            "not_installed",
            FRIENDLY.not_installed,
            `${this.binPath}: ${spawnError.message}`,
          );
        }
        await cleanupPartials(outputPath);
        throw new FetchError("unknown", FRIENDLY.unknown, spawnError.message);
      }

      if (code !== 0) {
        // This yt-dlp build can't impersonate (no curl_cffi) — retry plainly.
        if (impersonate && /impersonat|curl[_ ]?cffi/i.test(stderr)) {
          impersonate = "";
          continue;
        }
        await cleanupPartials(outputPath);
        const tail = stderr.split("\n").filter(Boolean).slice(-4).join("\n").trim();
        if (code != null && WONT_START_EXIT_CODES.has(code)) {
          throw new FetchError("wont_start", FRIENDLY.wont_start, `exit ${code} (0x${(code >>> 0).toString(16)})`);
        }
        const { kind, message } = classifyFetchError(stderr);
        throw new FetchError(kind, message, tail || `exit ${code}`);
      }

      await normalizeDownload(outputPath);

      if (!jsonLine) return {};
      const meta = JSON.parse(jsonLine) as {
        title?: string;
        duration?: number;
        filesize_approx?: number;
      };
      if (typeof meta.filesize_approx === "number" && meta.filesize_approx > this.maxBytes) {
        await cleanupPartials(outputPath);
        throw new FetchError(
          "too_large",
          FRIENDLY.too_large,
          `~${Math.round(meta.filesize_approx / 1e6)}MB`,
        );
      }
      return {
        title: meta.title?.trim() || undefined,
        durationSec: typeof meta.duration === "number" ? meta.duration : undefined,
      };
    }
  }

  /**
   * Enumerate a playlist link without downloading. Null when the link turns
   * out to be a single video, so the caller can take the ordinary path.
   * Failures classify exactly as {@link probe} failures do.
   */
  async probePlaylist(url: string, signal?: AbortSignal): Promise<PlaylistProbeResult | null> {
    let impersonate = this.impersonate;
    for (;;) {
      const { stdout, stderr, code, spawnError } = await this.exec(
        buildPlaylistProbeArgs(url, impersonate),
        signal,
      );
      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new FetchError("not_installed", FRIENDLY.not_installed, spawnError.message);
        }
        throw new FetchError("unknown", FRIENDLY.unknown, spawnError.message);
      }
      if (code !== 0) {
        if (impersonate && /impersonat|curl[_ ]?cffi/i.test(stderr)) {
          impersonate = "";
          continue;
        }
        const tail = stderr.split("\n").filter(Boolean).slice(-4).join("\n").trim();
        const { kind, message } = classifyFetchError(stderr);
        throw new FetchError(kind, message, tail || `exit ${code}`);
      }
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (!line) throw new FetchError("no_stream", FRIENDLY.no_stream, "yt-dlp returned no JSON");
      return parsePlaylistJson(JSON.parse(line) as Record<string, unknown>);
    }
  }

  /** Info-only lookup for the analyze/preview step. Downloads nothing. */
  async probe(url: string, signal?: AbortSignal): Promise<ProbeResult> {
    let impersonate = this.impersonate;
    for (;;) {
      const { stdout, stderr, code, spawnError } = await this.exec(
        buildProbeArgs(url, impersonate),
        signal,
      );
      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new FetchError("not_installed", FRIENDLY.not_installed, spawnError.message);
        }
        throw new FetchError("unknown", FRIENDLY.unknown, spawnError.message);
      }
      if (code !== 0) {
        if (impersonate && /impersonat|curl[_ ]?cffi/i.test(stderr)) {
          impersonate = "";
          continue;
        }
        const tail = stderr.split("\n").filter(Boolean).slice(-4).join("\n").trim();
        if (code != null && WONT_START_EXIT_CODES.has(code)) {
          throw new FetchError("wont_start", FRIENDLY.wont_start, `exit ${code} (0x${(code >>> 0).toString(16)})`);
        }
        const { kind, message } = classifyFetchError(stderr);
        throw new FetchError(kind, message, tail || `exit ${code}`);
      }

      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (!line) throw new FetchError("no_stream", FRIENDLY.no_stream, "yt-dlp returned no JSON");

      let j = JSON.parse(line) as Record<string, unknown>;
      if (j._type === "playlist" && Array.isArray(j.entries) && j.entries.length) {
        j = j.entries[0] as Record<string, unknown>;
      }
      const formats = (Array.isArray(j.formats) ? j.formats : []) as Array<{
        vcodec?: string;
        acodec?: string;
        filesize?: number;
        filesize_approx?: number;
      }>;
      const hasVideo =
        (j.vcodec != null && j.vcodec !== "none") ||
        formats.some((f) => f.vcodec && f.vcodec !== "none");
      const hasAudio =
        (j.acodec != null && j.acodec !== "none") ||
        formats.some((f) => f.acodec && f.acodec !== "none");
      const approxBytes =
        (typeof j.filesize_approx === "number" && j.filesize_approx) ||
        (typeof j.filesize === "number" && j.filesize) ||
        formats.reduce((m, f) => Math.max(m, f.filesize ?? f.filesize_approx ?? 0), 0) ||
        undefined;

      return {
        supported: true,
        title: typeof j.title === "string" ? j.title.trim() : undefined,
        durationSec: typeof j.duration === "number" ? j.duration : undefined,
        thumbnail: typeof j.thumbnail === "string" ? j.thumbnail : undefined,
        source: displaySource(j as { extractor_key?: string; extractor?: string }),
        hasVideo,
        hasAudio: hasAudio || (!hasVideo && !!j.url), // direct-audio links
        approxBytes: approxBytes || undefined,
        isLive: j.is_live === true,
      };
    }
  }

  async version(): Promise<string | null> {
    const { stdout, code, spawnError } = await this.exec(["--version"]);
    if (spawnError || code !== 0) return null;
    return stdout.trim().split("\n")[0] || null;
  }

  /**
   * Spawn yt-dlp, streaming output so `DLP <pct>` lines drive `onProgress` and the
   * `--print-json` blob is captured as it appears (it can scroll out of any buffer
   * on a long download).
   */
  private run(
    args: string[],
    signal: AbortSignal | undefined,
    onProgress: ((fraction: number) => void) | undefined,
  ): Promise<{ jsonLine: string | null; stderr: string; code: number | null; spawnError?: Error }> {
    return new Promise((resolve) => {
      const child = spawn(this.binPath, args, { signal });
      let stderr = "";
      let jsonLine: string | null = null;
      let lastReported = 0;
      // yt-dlp may emit progress on either stream depending on version/flags.
      const scan = (buf: string): string => {
        const lines = buf.split("\n");
        const rest = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          const m = /DLP\s*([\d.]+)%/.exec(line);
          if (m) {
            const f = Math.min(1, Number(m[1]) / 100);
            if (onProgress && f > lastReported + 0.005) {
              lastReported = f;
              onProgress(f);
            }
          } else if (line.startsWith("{") && line.endsWith("}")) {
            jsonLine = line;
          }
        }
        return rest;
      };
      let outPending = "";
      let errPending = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outPending = scan(outPending + chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
        errPending = scan(errPending + chunk);
      });
      child.on("error", (spawnError) => resolve({ jsonLine, stderr, code: null, spawnError }));
      child.on("close", (code) => {
        scan(outPending + "\n");
        scan(errPending + "\n");
        resolve({ jsonLine, stderr, code });
      });
    });
  }

  /** Non-streaming spawn — buffers stdout/stderr. For `probe` and `version`. */
  private exec(
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number | null; spawnError?: Error }> {
    return new Promise((resolve) => {
      const child = spawn(this.binPath, args, { signal });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        stdout += c;
        if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
        if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      });
      child.on("error", (spawnError) => resolve({ stdout, stderr, code: null, spawnError }));
      child.on("close", (code) => resolve({ stdout, stderr, code }));
    });
  }
}

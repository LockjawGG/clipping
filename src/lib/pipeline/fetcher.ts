import { execFile } from "node:child_process";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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

export interface FetchResult {
  /** The source's own title, if the downloader reported one. */
  title?: string;
  durationSec?: number;
}

/**
 * Downloads a video from a URL (YouTube, Vimeo, a direct link, …) to a local
 * file so the rest of the pipeline can treat it exactly like an upload.
 */
export interface MediaFetcher {
  readonly name: string;
  fetch(url: string, outputPath: string, signal?: AbortSignal): Promise<FetchResult>;
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
    "--no-progress",
    "--no-warnings",
    ...(impersonate ? ["--impersonate", impersonate] : []),
    "--max-filesize",
    `${maxMb}M`,
    // Prefer a single already-muxed mp4; fall back to bestvideo+bestaudio.
    "-f",
    "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outputPath,
    "--print-json",
    "--no-simulate",
  ];
}

/** `yt-dlp`-backed fetcher. Requires the binary on PATH (or an explicit path). */
export class YtDlpFetcher implements MediaFetcher {
  readonly name = "yt-dlp";

  private readonly binPath: string;
  private readonly maxBytes: number;
  private readonly impersonate: string;

  constructor(opts: YtDlpFetcherOptions) {
    this.binPath = opts.binPath;
    this.maxBytes = opts.maxBytes;
    this.impersonate = opts.impersonate ?? "chrome";
  }

  async fetch(url: string, outputPath: string, signal?: AbortSignal): Promise<FetchResult> {
    await mkdir(dirname(outputPath), { recursive: true });

    let impersonate = this.impersonate;
    for (;;) {
      try {
        const { stdout } = await run(
          this.binPath,
          buildYtDlpArgs(url, outputPath, this.maxBytes, impersonate),
          { signal, maxBuffer: 32 * 1024 * 1024 },
        );
        await normalizeDownload(outputPath);
        const line = stdout.trim().split("\n").filter(Boolean).at(-1);
        if (!line) return {};
        const meta = JSON.parse(line) as {
          title?: string;
          duration?: number;
          filesize_approx?: number;
        };
        if (typeof meta.filesize_approx === "number" && meta.filesize_approx > this.maxBytes) {
          throw new Error(`source is ~${Math.round(meta.filesize_approx / 1e6)}MB, over the limit`);
        }
        return {
          title: meta.title?.trim() || undefined,
          durationSec: typeof meta.duration === "number" ? meta.duration : undefined,
        };
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === "ENOENT") {
          throw new Error(`yt-dlp not found: ${this.binPath} (set YTDLP_PATH or install yt-dlp)`);
        }
        const stderr = e.stderr ?? "";
        // This yt-dlp build can't impersonate (no curl_cffi) — retry plainly.
        if (impersonate && /impersonat|curl[_ ]?cffi/i.test(stderr)) {
          impersonate = "";
          continue;
        }
        const tail = stderr.split("\n").slice(-3).join("\n").trim();
        throw new Error(`yt-dlp failed${tail ? `:\n${tail}` : `: ${e.message}`}`);
      }
    }
  }
}

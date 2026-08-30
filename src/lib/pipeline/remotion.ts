import { copyFile, mkdir, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import type { Cue } from "../captions/layout.ts";
import type { CaptionStyle } from "../captions/presets.ts";
import type { TextStyle } from "../captions/text-style.ts";
import type { WordRule } from "../captions/word-rules.ts";
import type { RenderImageLayer, RenderTextOverlay } from "./deps.ts";

/**
 * Renders animated (word-timed) captions over an already-reframed clip via the
 * Remotion project in `remotion/`. The heavy `@remotion/*` packages are pulled
 * in with dynamic `import()` so they never enter the Next bundle or the
 * strip-only test path — tests use a fake `CaptionRenderer`.
 */
export interface CaptionRenderInput {
  videoPath: string;
  outputPath: string;
  cues: Cue[];
  preset: string;
  style: CaptionStyle;
  /** Resolved rich style (fill, effect layers, glass...). Null = use `style`. */
  textStyle?: TextStyle | null;
  /** Word-level rules (karaoke / highlight / emphasis). */
  wordRules?: WordRule[];
  /** Freestanding text elements composited over the clip. */
  textOverlays?: RenderTextOverlay[];
  /** Animated image / GIF layers, promoted here because the ffmpeg `overlay`
   *  filter cannot express per-frame scale, rotation or opacity. */
  imageOverlays?: RenderImageLayer[];
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  signal?: AbortSignal;
}

export interface CaptionRenderer {
  renderCaptioned(input: CaptionRenderInput): Promise<void>;
}

export interface RemotionRendererOptions {
  /** Entry that calls `registerRoot`. Defaults to `<cwd>/remotion/index.ts`. */
  entryPoint?: string;
  concurrency?: number;
}

export class RemotionCaptionRenderer implements CaptionRenderer {
  private readonly entryPoint: string;
  private readonly concurrency: number | undefined;
  private serveUrl: Promise<string> | undefined;

  constructor(opts: RemotionRendererOptions = {}) {
    this.entryPoint = opts.entryPoint ?? resolve(process.cwd(), "remotion", "index.ts");
    this.concurrency = opts.concurrency;
  }

  /** Bundle the Remotion project once and reuse the served URL. */
  private bundleOnce(): Promise<string> {
    if (!this.serveUrl) {
      this.serveUrl = import("@remotion/bundler")
        .then(({ bundle }) => bundle({ entryPoint: this.entryPoint }))
        // The bundle directory is served as-is, and `staticFile()` resolves to
        // its `public/` subfolder. Overlay images are staged there per render:
        // Chrome refuses to load `file://` from the bundle's http origin, and
        // re-bundling per job just to set `publicDir` would cost seconds each
        // time. Created up front so the first render never races it.
        .then(async (dir) => {
          await mkdir(join(dir, "public"), { recursive: true });
          return dir;
        });
    }
    return this.serveUrl;
  }

  async renderCaptioned(input: CaptionRenderInput): Promise<void> {
    const { renderMedia, selectComposition } = await import("@remotion/renderer");
    const serveUrl = await this.bundleOnce();

    // Stage overlay images inside the served bundle. Names are unique so
    // concurrent renders cannot collide, and they are removed in `finally`.
    const publicDir = join(serveUrl, "public");
    const staged = await Promise.all(
      (input.imageOverlays ?? []).map(async (overlay) => {
        const name = `ov-${randomUUID()}${extname(overlay.path) || ".png"}`;
        await copyFile(overlay.path, join(publicDir, name));
        return { overlay, name };
      }),
    );

    // The clip itself is staged for exactly the same reason as the overlays:
    // the bundle is served over http, and Chrome refuses a `file://` load from
    // an http origin — which failed every animated render, since only the
    // static ffmpeg burn avoids Remotion. An http(s) source is already
    // loadable and is passed straight through.
    const remote = /^https?:\/\//i.test(input.videoPath);
    const videoName = remote ? null : `src-${randomUUID()}${extname(input.videoPath) || ".mp4"}`;
    if (videoName) await copyFile(input.videoPath, join(publicDir, videoName));

    const fps = input.fps > 0 ? input.fps : 30;
    const durationInFrames = Math.max(1, Math.round((input.durationMs / 1000) * fps));
    const inputProps = {
      // A bare name the composition resolves with `staticFile()`, or an http
      // URL used as-is.
      videoSrc: videoName ?? input.videoPath,
      videoIsStatic: videoName !== null,
      cues: input.cues,
      preset: input.preset,
      style: input.style,
      textStyle: input.textStyle ?? null,
      wordRules: input.wordRules ?? [],
      textOverlays: input.textOverlays ?? [],
      imageOverlays: staged.map(({ overlay: o, name }) => ({
        // A bare name; the composition resolves it with `staticFile()`.
        src: name,
        animated: o.animated,
        x: o.x,
        y: o.y,
        scale: o.scale,
        rotation: o.rotation,
        opacity: o.opacity,
        startMs: o.startMs,
        endMs: o.endMs,
        animationJson: o.animationJson,
      })),
      fps,
      durationInFrames,
      width: input.width,
      height: input.height,
    };

    try {
      const composition = await selectComposition({ serveUrl, id: "CaptionedClip", inputProps });
      await renderMedia({
        serveUrl,
        composition,
        codec: "h264",
        outputLocation: input.outputPath,
        inputProps,
        ...(this.concurrency ? { concurrency: this.concurrency } : {}),
      });
    } finally {
      // The bundle is long-lived and shared, so staged assets must not leak
      // into it — a failed render cleans up the same as a successful one.
      await Promise.all([
        ...staged.map(({ name }) => rm(join(publicDir, name), { force: true }).catch(() => {})),
        ...(videoName ? [rm(join(publicDir, videoName), { force: true }).catch(() => {})] : []),
      ]);
    }
  }
}

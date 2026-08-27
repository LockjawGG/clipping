import { resolve } from "node:path";

import type { Cue } from "../captions/layout.ts";
import type { CaptionStyle } from "../captions/presets.ts";

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
      this.serveUrl = import("@remotion/bundler").then(({ bundle }) =>
        bundle({ entryPoint: this.entryPoint }),
      );
    }
    return this.serveUrl;
  }

  async renderCaptioned(input: CaptionRenderInput): Promise<void> {
    const { renderMedia, selectComposition } = await import("@remotion/renderer");
    const serveUrl = await this.bundleOnce();

    const fps = input.fps > 0 ? input.fps : 30;
    const durationInFrames = Math.max(1, Math.round((input.durationMs / 1000) * fps));
    const inputProps = {
      videoSrc: input.videoPath.startsWith("file://") ? input.videoPath : `file://${input.videoPath}`,
      cues: input.cues,
      preset: input.preset,
      style: input.style,
      fps,
      durationInFrames,
      width: input.width,
      height: input.height,
    };

    const composition = await selectComposition({ serveUrl, id: "CaptionedClip", inputProps });
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: input.outputPath,
      inputProps,
      ...(this.concurrency ? { concurrency: this.concurrency } : {}),
    });
  }
}

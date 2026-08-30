import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Gif } from "@remotion/gif";

import type { CaptionStyleProps, CaptionedClipProps, RemotionCue, RemotionWord } from "./schema";
import {
  resolveTextAnimation,
  tracksFor,
  type AnimProp,
  type AnimScope,
  type AnimPhase,
  type AnimTrack,
  type SpringConfig,
} from "../src/lib/captions/anim-spec";
import {
  resolveTextStyle,
  textStyleToCss,
  parseStylePartial,
  type TextStyle,
} from "../src/lib/captions/text-style";
import { applyWordRules, wordEffectCss, type WordRule } from "../src/lib/captions/word-rules";
import { sampleElementAnim, parseElementAnim } from "../src/lib/captions/element-anim";

/**
 * The Remotion interpreter for the declarative animation spec (`anim-spec.ts`).
 *
 * Every caption animation's constants — spring configs, from/to values, timing
 * windows — come from the shared spec, not inline literals. The editor preview
 * reads the same documents, so what you scrub is what burns. The spring math
 * itself stays Remotion-native (`spring()`), so the exported curve is exact.
 */

function activeCue(cues: RemotionCue[], tMs: number): RemotionCue | undefined {
  return cues.find((c) => tMs >= c.startMs && tMs < c.endMs);
}

/** First track matching a prop within a scope+phase of the resolved animation. */
function pick(
  animId: string,
  scope: AnimScope,
  phase: AnimPhase,
  prop: AnimProp,
): AnimTrack | undefined {
  return tracksFor(resolveTextAnimation(animId), scope, phase).find((t) => t.prop === prop);
}

const SPRING_FALLBACK: SpringConfig = { damping: 12, stiffness: 200 };

const Word: React.FC<{
  word: RemotionWord;
  tMs: number;
  animId: string;
  style: CaptionStyleProps;
  wordRules: WordRule[];
  /** Container uses a clipped gradient fill — words must inherit it, not set their own colour. */
  gradientFill: boolean;
  fps: number;
  frame: number;
}> = ({ word, tMs, animId, style, wordRules, gradientFill, fps, frame }) => {
  const anim = resolveTextAnimation(animId);
  const spoken = tMs >= word.startMs;
  const active = tMs >= word.startMs && tMs < word.endMs;
  const cased = (t: string) => (style.uppercase ? t.toUpperCase() : t);

  if (anim.reveal === "word" && !spoken) {
    // Same box model as a shown word so the line doesn't shift as words reveal.
    return <span style={{ display: "inline-block", opacity: 0 }}>{cased(word.text)}</span>;
  }

  if (anim.reveal === "char") {
    const dur = Math.max(1, word.endMs - word.startMs);
    const progress = spoken ? Math.min(1, (tMs - word.startMs) / dur) : 0;
    const shown = spoken && !active ? word.text : word.text.slice(0, Math.ceil(progress * word.text.length));
    return (
      <span
        style={{
          display: "inline-block",
          // let a clipped gradient fill on the container show through
          ...(gradientFill
            ? { color: "inherit", WebkitTextFillColor: "inherit" }
            : { color: style.textColor }),
        }}
      >
        {cased(shown)}
      </span>
    );
  }

  const sinceStart = frame - (word.startMs / 1000) * fps;

  let transform = "none";
  let opacity = 1;
  let scaleVal = 1;

  const popScale = active ? pick(animId, "word", "intro", "scale") : undefined;
  const holdScale = active ? pick(animId, "word", "active", "scale") : undefined;
  const bounceY = active ? pick(animId, "word", "intro", "translateY") : undefined;
  const fadeOpacity = pick(animId, "word", "intro", "opacity");

  if (popScale && popScale.ease === "spring") {
    const sp = spring({ frame: Math.max(0, sinceStart), fps, config: popScale.spring ?? SPRING_FALLBACK });
    scaleVal = interpolate(sp, [0, 1], [popScale.from, popScale.to]);
    transform = `scale(${scaleVal})`;
  } else if (holdScale) {
    scaleVal = holdScale.to;
    transform = `scale(${scaleVal})`;
  } else if (bounceY && bounceY.ease === "spring") {
    const sp = spring({ frame: Math.max(0, sinceStart), fps, config: bounceY.spring ?? SPRING_FALLBACK });
    transform = `translateY(${interpolate(sp, [0, 1], [bounceY.from, bounceY.to])}px)`;
  } else if (fadeOpacity) {
    const winStart = word.startMs + (fadeOpacity.startMs ?? 0);
    const winEnd = winStart + (fadeOpacity.durMs ?? 200);
    opacity = spoken
      ? fadeOpacity.to
      : interpolate(tMs, [winStart, winEnd], [fadeOpacity.from, fadeOpacity.to], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  }

  const highlighted = active || (anim.highlight === "progressive" && spoken);
  const ruleCss = wordEffectCss(applyWordRules(wordRules, { spoken, active }));
  // The explicit colour this word should show, if any (a highlight beats a rule).
  const wordColor = (highlighted ? style.highlightColor : ruleCss.color) as string | undefined;

  // Colour handling. On a gradient caption the container sets
  // `-webkit-text-fill-color: transparent` to clip the gradient; a word that
  // wants its own colour must override BOTH the fill colour and the clip,
  // otherwise it renders as an invisible / outline-only "hollow" word.
  const colorStyle: React.CSSProperties = gradientFill
    ? wordColor
      ? {
          color: wordColor,
          WebkitTextFillColor: wordColor,
          backgroundImage: "none",
          backgroundClip: "border-box",
          WebkitBackgroundClip: "border-box",
        }
      : { color: "inherit", WebkitTextFillColor: "inherit" }
    : { color: wordColor ?? style.textColor };

  // A scaled word overflows its box (transform doesn't reserve layout). Reserve
  // roughly the overflow with horizontal margin so it never collides with the
  // next word; it eases back to 0 as the pop settles.
  const scaleMx =
    scaleVal > 1.001
      ? `${Math.max(0.1, word.text.length * 0.42 * (scaleVal - 1)).toFixed(3)}em`
      : undefined;

  return (
    <span
      style={{
        display: "inline-block",
        transform,
        opacity,
        ...(scaleMx ? { marginLeft: scaleMx, marginRight: scaleMx } : {}),
        ...colorStyle,
        ...ruleCss,
      }}
    >
      {cased(word.text)}
    </span>
  );
};

interface RenderTextOverlay {
  text: string;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startMs: number | null;
  endMs: number | null;
  styleJson: string | null;
  animationJson: string | null;
}

interface RenderImageOverlay {
  /** Bare filename staged in the bundle's `public/` dir; resolved by
   *  `staticFile()`. Chrome refuses `file://` loads from the bundle origin. */
  src: string;
  animated: boolean;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  startMs: number | null;
  endMs: number | null;
  animationJson: string | null;
}

/**
 * Image / GIF layers that carry motion. Static ones stay on the much cheaper
 * ffmpeg `overlay` path — only layers the filter cannot express (per-frame
 * scale, rotation or opacity) are promoted here.
 *
 * Width is a fraction of the frame, matching `buildOverlayCompositeArgs`'s 30%
 * baseline exactly, so promoting a layer never changes its size.
 */
const ImageOverlayLayer: React.FC<{ items: RenderImageOverlay[]; tMs: number }> = ({
  items,
  tMs,
}) => (
  <>
    {items.map((o, i) => {
      const from = o.startMs ?? Number.NEGATIVE_INFINITY;
      const to = o.endMs ?? Number.POSITIVE_INFINITY;
      if (tMs < from || tMs > to) return null;
      const anim = sampleElementAnim(parseElementAnim(o.animationJson), {
        elapsedMs: tMs - (o.startMs ?? 0),
        remainingMs: o.endMs == null ? null : o.endMs - tMs,
      });
      // Width and anchoring mirror `buildOverlayCompositeArgs` exactly — 30% of
      // the frame at scale 1, positioned at ffmpeg's `(W-w)*x` / `(H-h)*y` — so
      // promoting a layer from the ffmpeg path never nudges or resizes it.
      // The translate is a percentage of the element's *own* box, which yields
      // `y*H - y*h` without needing to know the image's aspect ratio up front.
      const width = `${30 * Math.min(4, Math.max(0.02, o.scale))}%`;
      const base = `translate(${-o.x * 100}%, ${-o.y * 100}%) rotate(${o.rotation}deg)`;
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${o.x * 100}%`,
            top: `${o.y * 100}%`,
            width,
            transform:
              anim.transform && anim.transform !== "none" ? `${base} ${anim.transform}` : base,
            opacity: o.opacity * anim.opacity,
            ...(anim.filter ? { filter: anim.filter } : {}),
          }}
        >
          {o.animated ? (
            // A plain <img> animates off wall-clock time, which makes the burn
            // non-deterministic; <Gif> decodes frames against the timeline.
            <Gif src={staticFile(o.src)} fit="contain" style={{ width: "100%", height: "auto" }} />
          ) : (
            <Img src={staticFile(o.src)} style={{ width: "100%", height: "auto" }} />
          )}
        </div>
      );
    })}
  </>
);

const TextOverlayLayer: React.FC<{ items: RenderTextOverlay[]; tMs: number }> = ({ items, tMs }) => (
  <>
    {items.map((o, i) => {
      const from = o.startMs ?? Number.NEGATIVE_INFINITY;
      const to = o.endMs ?? Number.POSITIVE_INFINITY;
      if (tMs < from || tMs > to) return null;
      const css = textStyleToCss(resolveTextStyle(parseStylePartial(o.styleJson)), {
        scale: o.scale || 1,
      });
      const anim = sampleElementAnim(parseElementAnim(o.animationJson), {
        elapsedMs: tMs - (o.startMs ?? 0),
        remainingMs: o.endMs == null ? null : o.endMs - tMs,
      });
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${o.x * 100}%`,
            top: `${o.y * 100}%`,
            transform:
              anim.transform && anim.transform !== "none"
                ? `translate(-50%, -50%) rotate(${o.rotation}deg) ${anim.transform}`
                : `translate(-50%, -50%) rotate(${o.rotation}deg)`,
            maxWidth: "84%",
            opacity: o.opacity * anim.opacity,
            ...(anim.filter ? { filter: anim.filter } : {}),
          }}
        >
          <span style={(css.panel ?? undefined) as unknown as React.CSSProperties | undefined}>
            <span
              style={{
                ...(css.text as unknown as React.CSSProperties),
                display: "inline-block",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {o.text}
            </span>
          </span>
        </div>
      );
    })}
  </>
);

export const CaptionedClip: React.FC<CaptionedClipProps> = ({
  videoSrc,
  cues,
  preset,
  style,
  textStyle,
  wordRules,
  textOverlays,
  imageOverlays,
}) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const cue = activeCue(cues, tMs);
  const animId = preset;
  const rules = (wordRules ?? []) as WordRule[];

  // Rich style (gradient / glow / glass / effect layers) when present, else the
  // scalar props. The scalar `style` still drives per-word highlight colour.
  const rich = textStyle ? resolveTextStyle(textStyle as Partial<TextStyle>) : null;
  const richCss = rich ? textStyleToCss(rich, { scale: 1 }) : null;

  const alignItems =
    style.alignment === "left" ? "flex-start" : style.alignment === "right" ? "flex-end" : "center";

  // Whole-cue intro (slide-up and any future cue-scoped animation).
  let cueTransform = "none";
  let cueOpacity = 1;
  const cueY = pick(animId, "cue", "intro", "translateY");
  const cueFade = pick(animId, "cue", "intro", "opacity");
  if (cue && (cueY || cueFade)) {
    const sinceCue = frame - (cue.startMs / 1000) * fps;
    const cfg = cueY?.spring ?? cueFade?.spring ?? SPRING_FALLBACK;
    const sp = spring({ frame: Math.max(0, sinceCue), fps, config: cfg });
    if (cueY) cueTransform = `translateY(${interpolate(sp, [0, 1], [cueY.from, cueY.to])}px)`;
    if (cueFade) cueOpacity = interpolate(sp, [0, 1], [cueFade.from, cueFade.to]);
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {videoSrc ? <OffthreadVideo src={videoSrc} /> : null}

      {cue ? (
        <AbsoluteFill
          style={{
            justifyContent: "flex-start",
            alignItems,
            paddingTop: style.positionY * height,
            paddingLeft: width * 0.06,
            paddingRight: width * 0.06,
          }}
        >
          <div
            style={
              richCss
                ? {
                    ...(richCss.text as unknown as React.CSSProperties),
                    ...((richCss.panel ?? {}) as unknown as React.CSSProperties),
                    transform: cueTransform,
                    opacity: cueOpacity,
                  }
                : {
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSizePx,
                    fontWeight: style.fontWeight,
                    lineHeight: 1.15,
                    textAlign: style.alignment,
                    wordSpacing: "0.22em",
                    color: style.textColor,
                    WebkitTextStroke: `${style.outlineWidthPx}px ${style.outlineColor}`,
                    paintOrder: "stroke fill",
                    transform: cueTransform,
                    opacity: cueOpacity,
                    ...(style.backgroundColor
                      ? {
                          backgroundColor: style.backgroundColor,
                          padding: "0.12em 0.35em",
                          borderRadius: "0.1em",
                          textShadow: "none",
                        }
                      : { textShadow: "0 4px 18px rgba(0,0,0,0.55)" }),
                  }
            }
          >
            {cue.words.map((w, i) => (
              <React.Fragment key={i}>
                {/* a real space between words — an inline-block trims its own
                    edge whitespace but not a sibling text node, and this keeps
                    a soft-wrap opportunity between words. */}
                {i > 0 ? " " : null}
                <Word
                  word={w}
                  tMs={tMs}
                  animId={animId}
                  style={style}
                  wordRules={rules}
                  gradientFill={!!rich && rich.fill.kind !== "solid"}
                  fps={fps}
                  frame={frame}
                />
              </React.Fragment>
            ))}
          </div>
        </AbsoluteFill>
      ) : null}

      {Array.isArray(textOverlays) && textOverlays.length > 0 ? (
        <AbsoluteFill>
          <TextOverlayLayer items={textOverlays as RenderTextOverlay[]} tMs={tMs} />
        </AbsoluteFill>
      ) : null}

      {/* Image layers render last, matching the ffmpeg path where the overlay
          composite runs after the caption burn. A clip can mix static images
          (ffmpeg) and animated ones (here), so the two must agree on z-order. */}
      {Array.isArray(imageOverlays) && imageOverlays.length > 0 ? (
        <AbsoluteFill>
          <ImageOverlayLayer items={imageOverlays as RenderImageOverlay[]} tMs={tMs} />
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

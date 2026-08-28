import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import type { CaptionPreset, CaptionStyleProps, CaptionedClipProps, RemotionCue, RemotionWord } from "./schema";

function activeCue(cues: RemotionCue[], tMs: number): RemotionCue | undefined {
  return cues.find((c) => tMs >= c.startMs && tMs < c.endMs);
}

const Word: React.FC<{
  word: RemotionWord;
  tMs: number;
  preset: CaptionPreset;
  style: CaptionStyleProps;
  fps: number;
  frame: number;
}> = ({ word, tMs, preset, style, fps, frame }) => {
  const spoken = tMs >= word.startMs;
  const active = tMs >= word.startMs && tMs < word.endMs;
  const cased = (t: string) => (style.uppercase ? t.toUpperCase() : t);

  if (preset === "word-by-word" && !spoken) {
    return <span style={{ opacity: 0 }}>{cased(word.text)} </span>;
  }

  if (preset === "typewriter") {
    const dur = Math.max(1, word.endMs - word.startMs);
    const progress = spoken ? Math.min(1, (tMs - word.startMs) / dur) : 0;
    const shown = spoken && !active ? word.text : word.text.slice(0, Math.ceil(progress * word.text.length));
    return (
      <span style={{ display: "inline-block", margin: "0 0.18em", color: style.textColor }}>
        {cased(shown)}
      </span>
    );
  }

  const sinceStart = frame - (word.startMs / 1000) * fps;

  let transform = "none";
  let opacity = 1;
  if (active && preset === "pop") {
    const sp = spring({ frame: Math.max(0, sinceStart), fps, config: { damping: 12, stiffness: 200 } });
    transform = `scale(${interpolate(sp, [0, 1], [1.35, 1])})`;
  } else if (active && preset === "scale") {
    transform = "scale(1.12)";
  } else if (active && preset === "bounce") {
    const sp = spring({ frame: Math.max(0, sinceStart), fps, config: { damping: 6, stiffness: 180 } });
    transform = `translateY(${interpolate(sp, [0, 1], [-18, 0])}px)`;
  } else if (preset === "fade") {
    opacity = spoken
      ? 1
      : interpolate(tMs, [word.startMs - 120, word.startMs], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
  }

  const highlighted = active || (preset === "karaoke" && spoken);

  return (
    <span
      style={{
        display: "inline-block",
        margin: "0 0.18em",
        transform,
        opacity,
        color: highlighted ? style.highlightColor : style.textColor,
      }}
    >
      {cased(word.text)}
    </span>
  );
};

export const CaptionedClip: React.FC<CaptionedClipProps> = ({ videoSrc, cues, preset, style }) => {
  const frame = useCurrentFrame();
  const { fps, height, width } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const cue = activeCue(cues, tMs);

  const alignItems =
    style.alignment === "left" ? "flex-start" : style.alignment === "right" ? "flex-end" : "center";

  // slide-up: the whole cue rises + fades in over ~180ms.
  let cueTransform = "none";
  let cueOpacity = 1;
  if (cue && preset === "slide-up") {
    const sinceCue = frame - (cue.startMs / 1000) * fps;
    const sp = spring({ frame: Math.max(0, sinceCue), fps, config: { damping: 20, stiffness: 160 } });
    cueTransform = `translateY(${interpolate(sp, [0, 1], [28, 0])}px)`;
    cueOpacity = sp;
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
            style={{
              fontFamily: style.fontFamily,
              fontSize: style.fontSizePx,
              fontWeight: style.fontWeight,
              lineHeight: 1.15,
              textAlign: style.alignment,
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
            }}
          >
            {cue.words.map((w, i) => (
              <Word key={i} word={w} tMs={tMs} preset={preset} style={style} fps={fps} frame={frame} />
            ))}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

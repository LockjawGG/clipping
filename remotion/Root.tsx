import React from "react";
import { Composition } from "remotion";

import { CaptionedClip } from "./CaptionedClip";
import { captionedClipSchema, DEFAULT_CAPTIONED_CLIP_PROPS } from "./schema";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CaptionedClip"
      component={CaptionedClip}
      schema={captionedClipSchema}
      defaultProps={DEFAULT_CAPTIONED_CLIP_PROPS}
      fps={DEFAULT_CAPTIONED_CLIP_PROPS.fps}
      durationInFrames={DEFAULT_CAPTIONED_CLIP_PROPS.durationInFrames}
      width={DEFAULT_CAPTIONED_CLIP_PROPS.width}
      height={DEFAULT_CAPTIONED_CLIP_PROPS.height}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.round(props.durationInFrames)),
        fps: props.fps || 30,
        width: props.width,
        height: props.height,
      })}
    />
  );
};

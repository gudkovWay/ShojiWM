import {
  compileWindowEffect,
  imageSource,
  loadShader,
  shaderStage,
  windowSource,
  type MaybeSignal,
  type WindowEffectHandle,
} from "shoji_wm";
import { RAIN_BORDER_PX, RAIN_CAP_PX } from "./rain-layout";

/**
 * Static Rainlit Shoji candidate: full-profile wooden rails, brass corners
 * and one lower-right lantern, shared by Kitty and Zen.
 *
 * The 26px native border owns the frame; the client opening stays transparent.
 * The shader preserves native header controls without sampling client pixels.
 * Source damage drives redraws; no animated uniform enters this stage.
 */
export function createRainFrameEffect(
  focused: MaybeSignal<number>,
  frameSize: [MaybeSignal<number>, MaybeSignal<number>],
): WindowEffectHandle {
  return compileWindowEffect({
    input: windowSource({ include: "full" }),
    alpha: "preserve",
    capturePadding: 0,
    outsets: { left: 6, right: 6, top: 8, bottom: 0 },
    invalidate: { kind: "on-source-damage-box", damagePadding: 0 },
    pipeline: [
      shaderStage(loadShader("./src/effect/rain-frame.frag"), {
        textures: {
          frame_atlas: imageSource("./assets/rain-shoji-v2/frame-atlas.png"),
        },
        uniforms: {
          focused,
          logical_size: frameSize,
          border_px: RAIN_BORDER_PX,
          cap_px: RAIN_CAP_PX,
        },
      }),
    ],
  });
}

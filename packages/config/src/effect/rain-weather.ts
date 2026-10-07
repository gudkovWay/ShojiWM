import {
  compileWindowEffect,
  get,
  loadShader,
  renderTo,
  renderToIfDirty,
  save,
  shaderStage,
  stateSource,
  stateTexture,
  windowSource,
  type MaybeSignal,
  type WindowEffectHandle,
} from "shoji_wm";
import type { AmbientComposition } from "./ambient-composition";
import { COMPOSITION_INDEX } from "./ambient-composition";
import { RAIN_BORDER_PX } from "./rain-layout";

/**
 * Weather replacement for the client surface of a Kitty terminal: local lamp
 * light over the captured content, then sparse droplet optics that respond to
 * what is actually on screen.
 *
 * The rainlit profile runs three side pipelines that persist across frames and
 * then the two display stages. Capturing the raw window once (`save`) lets the
 * side pipelines reuse that single capture instead of re-reading it:
 *
 *   1. `rain-content-background` builds the rgba16f background reference at
 *      scale 1/8 from the raw capture (primary input), cached while the
 *      window content is unchanged
 *      (`renderToIfDirty`, no phase dependency).
 *   2. `rain-content-mask` builds the rgba8 occupancy mask at scale 1/2 from
 *      the same capture, comparing against that background state and cached
 *      the same way.
 *   3. `rain-drop-motion` is the persistent rgba16f simulation cell at scale
 *      1/8: it reads its own previous state and the mask every frame and
 *      advances the packed episode buckets, including the content-responsive
 *      speed controllers.
 *   4. `rain-light.frag` brightens/tints the real captured source inside the
 *      finite warm footprint and returns **premultiplied** RGB, because its
 *      output feeds the next stage as an intermediate target.
 *   5. `rain-lens.frag` reads the motion state, refracts/blurs the already-lit
 *      source locally and returns **straight** RGB with the original alpha,
 *      because the native final display wrapper multiplies alpha itself.
 *
 * The side pipelines never touch the outer working texture, so the raw capture
 * saved before them is exactly what the light stage reads — the raw window is
 * never captured or read a second time after lighting. The lantern-dusk and
 * moonlit-ink profiles keep the original two stages with no state textures:
 * only the rainlit profile carries the state and mask work.
 *
 * `borderPx` is the reserved painted rail width in logical px that every
 * `border_px` uniform in all three side pipelines and both display stages
 * keeps clear of: it defaults to the legacy 26px ring and the pack-02 caller
 * passes its authored 52px timber instead.
 *
 * Compiled once per window; the phase and frame-size signals are bound
 * eagerly, so no per-frame recompilation happens here.
 */
export function createRainWeatherEffect(
  phase: MaybeSignal<number>,
  composition: AmbientComposition,
  frameSize: [MaybeSignal<number>, MaybeSignal<number>],
  borderPx: number = RAIN_BORDER_PX,
): WindowEffectHandle {
  const compositionIndex = COMPOSITION_INDEX[composition];
  // Temporary rain-debugging diagnostic: 1 makes the final lens stage show
  // the occupancy mask in pure grayscale plus the winning head/tail
  // colour-coded by contact/hold; 2 keeps the original capture readable under
  // a faint mask overlay and the same winner overlay, plus a top strip of
  // bands showing the mask's reason code, the background reference RGB and
  // its alpha and the mask's raw alpha; 3 leaves the normal optics everywhere
  // except a bounded 128 x 32 logical-pixel readout in the top-left corner
  // inside the opening, whose four 8-px rows report the actual motion-state
  // facts (blue phase, green bucket-0 layout magic / 5, cyan alive head count
  // / 12, yellow maximum alive age / 8 s) as an actual-state indicator for
  // manual observation; 0 restores the normal optics path exactly. The modes
  // remain available for manual debugging, but the shipped default is 0, so
  // the normal surface carries no diagnostic corner.
  const RAIN_DIAGNOSTIC_MODE = 0;
  const uniforms = {
    phase,
    composition: compositionIndex,
    logical_size: frameSize,
    border_px: borderPx,
  };
  const rawFull = windowSource({ include: "full" });
  const light = shaderStage(loadShader("./src/effect/rain-light.frag"), {
    uniforms,
  });

  // Non-rainlit profiles have no droplets: the original two stages, no states.
  if (compositionIndex !== 0) {
    return compileWindowEffect({
      input: rawFull,
      alpha: "preserve",
      capturePadding: 0,
      outsets: 0,
      invalidate: { kind: "always" },
      pipeline: [
        light,
        shaderStage(loadShader("./src/effect/rain-lens.frag"), { uniforms }),
      ],
    });
  }

  const backgroundState = stateTexture("rain-content-background-v1", {
    scale: 0.125,
    format: "rgba16f",
    resize: "clear",
  });
  const maskState = stateTexture("rain-content-mask-v1", {
    scale: 0.5,
    format: "rgba8",
    resize: "clear",
  });
  const motionState = stateTexture("rain-drop-motion-v5", {
    scale: 0.125,
    format: "rgba16f",
    resize: "clear",
  });

  return compileWindowEffect({
    input: rawFull,
    alpha: "preserve",
    capturePadding: 0,
    outsets: 0,
    invalidate: { kind: "always" },
    pipeline: [
      // Single raw capture; the side pipelines below resample it to their own
      // working size (1/8 for background and motion, 1/2 for the mask).
      save("rain-raw"),
      // Background reference: cached until the raw window content changes, and
      // deliberately independent of `phase` so the cache is not rebuilt every
      // four-second tick. The primary input is the raw capture.
      renderToIfDirty(backgroundState, {
        dependsOn: [windowSource({ include: "full" })],
        input: get("rain-raw"),
        pipeline: [
          shaderStage(
            loadShader("./src/effect/rain-content-background.frag"),
            {
              uniforms: { logical_size: frameSize, border_px: borderPx },
            },
          ),
        ],
      }),
      // Occupancy mask: compares the raw capture against that background state.
      renderToIfDirty(maskState, {
        dependsOn: [windowSource({ include: "full" })],
        input: get("rain-raw"),
        pipeline: [
          shaderStage(loadShader("./src/effect/rain-content-mask.frag"), {
            textures: { content_background: stateSource(backgroundState) },
            uniforms: { logical_size: frameSize, border_px: borderPx },
          }),
        ],
      }),
      // Persistent droplet simulation: reads its own previous state and the
      // mask, advances the heads every frame and accepts episodes from the
      // four-second candidate slots (14 nominal births per 96 s loop: 7 centre,
      // 5 right and 2 left; family 0 slots and two eligible skips never start
      // an episode). The display
      // stages leave this state untouched.
      renderTo(motionState, {
        input: stateSource(motionState),
        pipeline: [
          shaderStage(loadShader("./src/effect/rain-motion.frag"), {
            textures: { content_mask: stateSource(maskState) },
            uniforms: {
              phase,
              composition: compositionIndex,
              logical_size: frameSize,
              border_px: borderPx,
            },
          }),
        ],
      }),
      // Intermediate stage: premultiplied RGB output feeding the next stage.
      // It reads the raw capture saved above (renderTo leaves it in place).
      light,
      // Final stage: straight RGB + original alpha; native final wrapper
      // multiplies alpha. The motion state arrives as a state source, so it
      // keeps its native ~capture * 0.125 dimensions and normalized raw UV.
      shaderStage(loadShader("./src/effect/rain-lens.frag"), {
        uniforms: {
          ...uniforms,
          diagnostic_mode: RAIN_DIAGNOSTIC_MODE,
        },
        textures: {
          drop_motion: stateSource(motionState),
          content_mask: stateSource(maskState),
          content_background: stateSource(backgroundState),
        },
      }),
    ],
  });
}

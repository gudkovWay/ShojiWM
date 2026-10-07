import {
  backdropSource,
  compileEffect,
  dualKawaseBlur,
  imageSource,
  loadShader,
  shaderStage,
  type CompiledEffectHandle,
  type MaybeSignal,
} from "shoji_wm";
import {
  COMPOSITION_INDEX,
  type AmbientComposition,
} from "./ambient-composition";

/**
 * Animated ambient backdrop for the unified-frame targets (Kitty). This is a
 * native backdrop effect: it blurs the scene captured *behind* the window and
 * layers the selected inner composition on top, while `ClientWindow` renders
 * its own content untouched above it. Glyph pixels are never captured, sampled
 * or warped — text readability is preserved by architecture, not by masking.
 *
 * `phase` is the per-window native animation signal (0..1 over
 * `AMBIENT_PERIOD_MS`, started/stopped by the parent with window visibility);
 * because that signal changes every frame, the effect must use the `always`
 * invalidation policy so each frame re-renders — source-damage invalidation
 * alone would never advance the animation. The compiled pipeline and handle
 * are still cached and reused, so this is a per-frame re-render, not a
 * per-frame recompile or a full-window source replacement.
 * `composition` selects one of the three profiles through `COMPOSITION_INDEX`.
 * `logicalContentSize` is the per-window content rect in logical pixels (frame
 * width minus the 26px side borders, frame height minus the 26px header row
 * above and the 26px bottom border, clamped to at least 1) supplied as a pair
 * of mapped `MaybeSignal`s, exactly like the frame effect's `logical_size`.
 * The shader uses it to author the content lantern and the rain grid in real
 * logical pixels, so both keep their physical size and aspect at any window
 * shape, render scale or DPR.
 *
 * `content_lantern` is the emitted straight-RGBA 512x1024 lantern sprite:
 * a single complete object sampled into the upper-right background, no
 * analytic point glow. The asset is emitted once by the builder alongside the
 * frame atlas; this stage only binds it.
 *
 * Output alpha is preserved and every stage stays premultiplied-safe. The
 * lantern and atmospheric layers modify only the backdrop below the client.
 */
export function createAmbientGlassEffect(
  phase: MaybeSignal<number>,
  composition: AmbientComposition,
  logicalContentSize: [MaybeSignal<number>, MaybeSignal<number>],
): CompiledEffectHandle {
  return compileEffect({
    input: backdropSource(),
    // Room for the blur stage: dualKawaseBlur downsamples and reads a
    // neighbourhood around every pixel, so without padding the edges would
    // sample clamped and show a seam.
    capturePadding: 24,
    // `phase` is a signal changing every frame, so the animated pipeline must
    // re-render each frame; source-damage invalidation would leave it frozen.
    invalidate: { kind: "always" },
    alpha: "preserve",
    pipeline: [
      dualKawaseBlur({ radius: 4, passes: 2 }),
      shaderStage(loadShader("./src/effect/ambient-content.frag"), {
        textures: {
          content_lantern: imageSource(
            "./assets/rain-shoji-v2/content-lantern.png",
          ),
        },
        uniforms: {
          phase,
          composition: COMPOSITION_INDEX[composition],
          logical_content_size: logicalContentSize,
        },
      }),
    ],
  });
}

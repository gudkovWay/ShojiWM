import {
  Box,
  Button,
  Image,
  read,
  useState,
  type WaylandWindow,
} from "shoji_wm";
import type { CompositionRenderable, MaybeSignal } from "shoji_wm/types";
import type { RainlitWindowRuntime } from "./runtime";

/**
 * Native doll controls for the rainlit 07 frame (48px wooden top beam).
 *
 * Three real `<Button>` hit targets in the standard min / max / close order,
 * each carrying source-derived painterly doll art plus an aligned eye-glow
 * overlay from `pack.controls`. Each eye mask shares the doll canvas
 * (`controls.doll`, 32x44 logical) and is placed at its pack-authored
 * `controls.eyes[i]` top-left — FRAME_07 authors [0,0] for all three, so the
 * overlay is a strict 1:1 with no offset math. Action glyphs are NOT baked
 * into the sprites: the existing generic SVG glyphs (`minus.svg`,
 * `maximize-2.svg`, `minimize-2.svg`, `x.svg`) are overlaid on the painted
 * belt/plaque and stay visible before any hover, so colour and eyes are
 * never the only affordance.
 *
 * Doll art and glyphs are pointer-events-none; the Button keeps the entire
 * stable rectangle as the hit target and native hit-testing already gives
 * button actions priority over resize edges. Eye opacity comes from the
 * shared native motion track (`runtime.motion.eyes`), hover feeds
 * `runtime.setHoveredAction`, and press pulses `runtime.pulseAction` before
 * the original native action runs immediately. Maximize stays guarded by
 * `isResizable`/`isMaximized` and reads as disabled otherwise.
 */

type DollAction = "min" | "max" | "close";

// Action glyph overlay: 12px glyph centred horizontally on the painted
// belt/plaque zone in the lower half of the 32x44 doll canvas (top = 60% of
// canvas height). Exact optical position is unverified until the authored
// sprites are reviewed on screen.
const GLYPH_PX = 12;
const GLYPH_TOP_FRACTION = 0.6;

const dollArtStyle = (width: number, height: number) =>
  ({
    position: "absolute",
    left: 0,
    top: 0,
    width,
    height,
    zIndex: 1,
    pointerEvents: "none",
  }) as const;

function DollControl(props: {
  window: WaylandWindow;
  runtime: RainlitWindowRuntime;
  action: DollAction;
}): CompositionRenderable {
  const { window, runtime, action } = props;
  const controls = runtime.pack.controls;
  if (!controls) {
    return null;
  }
  const [width, height] = controls.doll;
  const [eyesLeft, eyesTop] =
    action === "min"
      ? controls.eyes[0]
      : action === "max"
        ? controls.eyes[1]
        : controls.eyes[2];

  const dollSrc: string =
    action === "min"
      ? controls.min
      : action === "max"
        ? controls.max
        : controls.close;
  const eyesSrc: string =
    action === "min"
      ? controls.eyesMin
      : action === "max"
        ? controls.eyesMax
        : controls.eyesClose;
  // FrameMotion.eyes is authored in min/max/close order.
  const eyesOpacity: MaybeSignal<number> =
    action === "min"
      ? runtime.motion.eyes[0]
      : action === "max"
        ? runtime.motion.eyes[1]
        : runtime.motion.eyes[2];

  const setHovered = (hovered: boolean) => {
    runtime.setHoveredAction(action, hovered);
  };

  const onClick = () => {
    if (action === "min") {
      runtime.pulseAction(action);
      window.minimize();
    } else if (action === "close") {
      runtime.pulseAction(action);
      window.close();
    } else if (!read(window.isResizable)) {
      return;
    } else if (read(window.isMaximized)) {
      runtime.pulseAction(action);
      window.unmaximize();
    } else {
      runtime.pulseAction(action);
      window.maximize();
    }
  };

  return (
    <Box
      style={{
        position: "relative",
        width,
        height,
        flexShrink: 0,
        // Non-resizable windows keep the visible doll and glyph but read as
        // inactive, matching the plaque controls' disabled treatment.
        opacity:
          action === "max"
            ? window.isResizable((resizable) => (resizable ? 1 : 0.45))
            : undefined,
      }}
    >
      <Button onHoverChange={setHovered} onClick={onClick} style={{ width, height }} />
      <Image src={dollSrc} style={dollArtStyle(width, height)} />
      <Image
        src={eyesSrc}
        style={{
          ...dollArtStyle(width, height),
          left: eyesLeft,
          top: eyesTop,
          opacity: eyesOpacity,
        }}
      />
      <Image
        src={
          action === "min"
            ? "./assets/minus.svg"
            : action === "close"
              ? "./assets/x.svg"
              : window.isMaximized((maximized) =>
                  maximized ? "./assets/minimize-2.svg" : "./assets/maximize-2.svg",
                )
        }
        style={{
          position: "absolute",
          width: GLYPH_PX,
          height: GLYPH_PX,
          left: Math.round((width - GLYPH_PX) / 2),
          top: Math.round(height * GLYPH_TOP_FRACTION),
          zIndex: 2,
          pointerEvents: "none",
        }}
      />
    </Box>
  );
}

export const RainlitDollControls = ({
  window,
  runtime,
}: {
  window: WaylandWindow;
  runtime: RainlitWindowRuntime;
}): CompositionRenderable => {
  const controls = runtime.pack.controls;
  if (!controls) {
    return null;
  }
  return (
    <Box
      direction="row"
      style={{
        alignItems: "start",
        // Inter-button gaps stay ordinary beam drag surface; no movable hit
        // target is placed between the three stable buttons.
        gap: 4,
      }}
    >
      <DollControl window={window} runtime={runtime} action="min" />
      <DollControl window={window} runtime={runtime} action="max" />
      <DollControl window={window} runtime={runtime} action="close" />
    </Box>
  );
};

/**
 * Native wood controls for the rainlit 02 painterly frame.
 *
 * Three real `<Button>` targets (min / max / close), each exactly 36x36 with a
 * 6px inter-button gap. The material is the actual GPT-Image-2 upscaled painted
 * brass plate (`plate.png`, cropped to the true alpha plate bbox of
 * `plate-source.webp`), rendered as an `<Image>`; there is no flat coloured
 * rectangle or border behind it. Hover swaps to `plate-hover.png` (subtle
 * material brightness + warm rim light) via local state, never a CSS fill.
 * Glyphs are 14px engraved dark warm brown SVGs with a muted highlight, always
 * visible and pointer-events-none, centred on the measured optical centre of
 * the plate's rivet face. The Button stays fully transparent as the single
 * stable hit target; native hit-testing already gives button actions priority
 * over resize edges. Maximize keeps the original `isResizable` /
 * `isMaximized` native toggle and reads as disabled (opacity 0.45) otherwise.
 */
const WOOD_CONTROL_SIZE = 36;
const WOOD_ROW_GAP = 6;
const WOOD_GLYPH_PX = 14;
const CONTROLS_DIR = "./assets/rainlit-frames/02/design-faithful/controls";
// Optical centre of the plate's rivet face, measured on the cropped plate
// source (ring centre ~ (0.494, 0.478) of the plate). Fractions of the 36px
// control, so the 14px glyph lands on the real rivet, not raw canvas centre.
const GLYPH_CENTRE_X = 0.494 * WOOD_CONTROL_SIZE - WOOD_GLYPH_PX / 2;
const GLYPH_CENTRE_Y = 0.478 * WOOD_CONTROL_SIZE - WOOD_GLYPH_PX / 2;
const MAX_DISABLED_OPACITY = 0.45;

type WoodAction = "min" | "max" | "close";

const glyphSrc = (action: WoodAction, maximized: boolean) => {
  if (action === "min") return `${CONTROLS_DIR}/minus.svg`;
  if (action === "close") return `${CONTROLS_DIR}/close.svg`;
  return maximized
    ? `${CONTROLS_DIR}/restore.svg`
    : `${CONTROLS_DIR}/maximize.svg`;
};

function WoodControl(props: {
  window: WaylandWindow;
  runtime: RainlitWindowRuntime;
  action: WoodAction;
}): CompositionRenderable {
  const { window, runtime, action } = props;
  const [hover, setHover] = useState(false);

  const setHovered = (hovered: boolean) => {
    setHover(hovered);
    runtime.setHoveredAction(action, hovered);
  };

  const onClick = () => {
    if (action === "min") {
      runtime.pulseAction(action);
      window.minimize();
    } else if (action === "close") {
      runtime.pulseAction(action);
      window.close();
    } else if (!read(window.isResizable)) {
      return;
    } else if (read(window.isMaximized)) {
      runtime.pulseAction(action);
      window.unmaximize();
    } else {
      runtime.pulseAction(action);
      window.maximize();
    }
  };

  return (
    <Box
      style={{
        position: "relative",
        width: WOOD_CONTROL_SIZE,
        height: WOOD_CONTROL_SIZE,
        flexShrink: 0,
        // Non-resizable windows keep the visible glyph but read as inactive.
        opacity:
          action === "max"
            ? window.isResizable((resizable) =>
                resizable ? 1 : MAX_DISABLED_OPACITY,
              )
            : undefined,
      }}
    >
      <Image
        src={hover((active) =>
          active
            ? `${CONTROLS_DIR}/plate-hover.png`
            : `${CONTROLS_DIR}/plate.png`,
        )}
        style={{
          position: "absolute",
          width: WOOD_CONTROL_SIZE,
          height: WOOD_CONTROL_SIZE,
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
      <Button
        onHoverChange={setHovered}
        onClick={onClick}
        style={{
          width: WOOD_CONTROL_SIZE,
          height: WOOD_CONTROL_SIZE,
          background: "#00000000",
        }}
      />
      <Image
        src={window.isMaximized((maximized) => glyphSrc(action, maximized))}
        style={{
          position: "absolute",
          width: WOOD_GLYPH_PX,
          height: WOOD_GLYPH_PX,
          left: Math.round(GLYPH_CENTRE_X),
          top: Math.round(GLYPH_CENTRE_Y),
          zIndex: 1,
          pointerEvents: "none",
        }}
      />
    </Box>
  );
}

export const RainlitWoodControls = ({
  window,
  runtime,
}: {
  window: WaylandWindow;
  runtime: RainlitWindowRuntime;
}): CompositionRenderable => (
  <Box
    direction="row"
    style={{
      alignItems: "start",
      // Inter-button gaps stay ordinary header drag surface; no movable hit
      // target is placed between the three stable buttons.
      gap: WOOD_ROW_GAP,
    }}
  >
    <WoodControl window={window} runtime={runtime} action="min" />
    <WoodControl window={window} runtime={runtime} action="max" />
    <WoodControl window={window} runtime={runtime} action="close" />
  </Box>
);

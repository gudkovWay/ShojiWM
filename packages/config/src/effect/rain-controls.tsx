import {
  Box,
  Button,
  Image,
  read,
  useState,
  type WaylandWindow,
} from "shoji_wm";
import type { CompositionRenderable, MaybeSignal } from "shoji_wm/types";

/**
 * Native inlay controls for the unified 26px wooden frame header.
 *
 * These are the real clickable controls (not shader-painted fakes): each is a
 * `<Button>` inside a small brown-wood plaque with a warm brass trim, always
 * showing its glyph so close/min/max stay visible even when the rain art toggle
 * is off. They are the target chrome for kitty/zen only; the legacy controls in
 * `index.tsx` remain in use for every other app.
 *
 * The plaque is 24px wide and 20px tall, leaving 3px of breathing room inside
 * the 26px header. Hit-testing gives button actions priority over the resize
 * edges, so the small target resize band never steals a control click.
 */

const PLAQUE_WIDTH = 24;
const PLAQUE_HEIGHT = 20;
const PLAQUE_RADIUS = 3;
const ICON_PX = 14;
const ICON_LEFT = (PLAQUE_WIDTH - ICON_PX) / 2;
const ICON_TOP = (PLAQUE_HEIGHT - ICON_PX) / 2;

// Brown wood plaque with a warm brass trim; the close plaque keeps a red cue.
const PLAQUE_WOOD = "#49363F";
const PLAQUE_WOOD_HOVER = "#5F464D";
const BRASS = "#B08D57";
const BRASS_HOVER = "#D9B573";
const CLOSE_ACCENT = "#B4553F";
const CLOSE_ACCENT_HOVER = "#E07A5F";
const CLOSE_HOVER = "#8E3B33";

const PLAQUE_ICON_STYLE = {
  width: ICON_PX,
  height: ICON_PX,
  position: "absolute",
  left: ICON_LEFT,
  top: ICON_TOP,
  zIndex: 1,
  pointerEvents: "none",
} as const;

function RainControlPlaque(props: {
  icon: MaybeSignal<string>;
  onClick: () => void;
  background: (hover: boolean) => string;
  border: (hover: boolean) => string;
  opacity?: MaybeSignal<number>;
}): CompositionRenderable {
  const [hover, setHover] = useState(false);

  return (
    <Box style={{ position: "relative", flexShrink: 0, opacity: props.opacity }}>
      <Button
        onHoverChange={setHover}
        onClick={props.onClick}
        style={{
          width: PLAQUE_WIDTH,
          height: PLAQUE_HEIGHT,
          borderRadius: PLAQUE_RADIUS,
          background: hover((active) => props.background(active)),
          border: { px: 1, color: hover((active) => props.border(active)) },
        }}
      />
      <Image src={props.icon} style={PLAQUE_ICON_STYLE} />
    </Box>
  );
}

export const RainMinimizeButton = ({ window }: { window: WaylandWindow }) => (
  <RainControlPlaque
    icon="./assets/minus.svg"
    onClick={() => window.minimize()}
    background={(active) => (active ? PLAQUE_WOOD_HOVER : PLAQUE_WOOD)}
    border={(active) => (active ? BRASS_HOVER : BRASS)}
  />
);

export const RainMaximizeButton = ({ window }: { window: WaylandWindow }) => (
  <RainControlPlaque
    icon={window.isMaximized((maximized) =>
      maximized ? "./assets/minimize-2.svg" : "./assets/maximize-2.svg",
    )}
    onClick={() => {
      if (!read(window.isResizable)) {
        return;
      }
      if (read(window.isMaximized)) {
        window.unmaximize();
      } else {
        window.maximize();
      }
    }}
    background={(active) => (active ? PLAQUE_WOOD_HOVER : PLAQUE_WOOD)}
    border={(active) => (active ? BRASS_HOVER : BRASS)}
    // Non-resizable windows keep the visible glyph but read as inactive.
    opacity={window.isResizable((resizable) => (resizable ? 1 : 0.45))}
  />
);

export const RainCloseButton = ({ window }: { window: WaylandWindow }) => (
  <RainControlPlaque
    icon="./assets/x.svg"
    onClick={window.close}
    background={(active) => (active ? CLOSE_HOVER : PLAQUE_WOOD)}
    border={(active) => (active ? CLOSE_ACCENT_HOVER : CLOSE_ACCENT)}
  />
);

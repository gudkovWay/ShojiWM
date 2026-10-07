import { computed, read, type MaybeSignal } from "shoji_wm";
import type { FrameLayer, FrameMotion, FramePack, MotionInput, Rect } from "./types";

/**
 * Rainlit 07 - "Lacquered Knot and Dolls".
 *
 * Painterly lacquered-wood frame with a deliberately deep 48-logical top beam,
 * a fixed red knot at the upper left and two independently swaying tassels.
 * The master's three wooden dolls are NOT part of this atlas: they drive the
 * native min/max/close buttons from `controls`, and the lower-right shelf that
 * held them in the master is deliberately absent from every derived cell.
 *
 * All material is derived from the approved painterly master by
 * `tools/build-rainlit-07.py`; see `assets/rainlit-frames/07/source.json` for
 * measured source crops, the uniform source->atlas scale and the documented
 * reconstruction of the extra beam thickness. No asset is loaded or compiled
 * at module import; the pack is inert data plus an authored motion factory.
 */

const ATLAS = "./assets/rainlit-frames/07/frame-atlas.png";

// Atlas cells, measured and emitted by tools/build-rainlit-07.py.
const RAIL_TOP: Rect = [2, 2, 1024, 192];
const RAIL_BOTTOM: Rect = [2, 196, 1024, 104];
const RAIL_LEFT: Rect = [1028, 196, 104, 512];
const RAIL_RIGHT: Rect = [1134, 196, 104, 512];
const CORNER_TL: Rect = [1240, 196, 168, 256];
const CORNER_TR: Rect = [1410, 196, 168, 256];
const CORNER_BL: Rect = [1580, 196, 168, 168];
const CORNER_BR: Rect = [1750, 196, 168, 168];
const KNOT: Rect = [1920, 196, 119, 68];
const TASSEL_A: Rect = [2, 710, 65, 276];
const TASSEL_B: Rect = [69, 710, 51, 336];

/**
 * Static knot plus two tassels. Each tassel pivots about its own measured
 * thread root (pivot below), so the cords stay attached to the knot while the
 * bodies swing; the knot itself carries no motion channel. The moving sprites
 * were cut out of the static cells first, so no second painted copy of a
 * tassel remains behind them.
 */
const LAYERS: FrameLayer[] = [
  {
    id: "knot",
    cell: KNOT,
    anchor: "tl",
    offset: [-22.67, 48.37],
    size: [29.63, 16.93],
    pivot: [0, 0],
  },
  {
    id: "tassel_a",
    cell: TASSEL_A,
    anchor: "tl",
    offset: [-22.07, 60.47],
    size: [16.33, 68.93],
    pivot: [11.64, 2.42],
    angle: "tasselA",
  },
  {
    id: "tassel_b",
    cell: TASSEL_B,
    anchor: "tl",
    offset: [-6.95, 60.47],
    size: [12.7, 84.05],
    pivot: [3.78, 2.42],
    angle: "tasselB",
  },
];

const TAU = Math.PI * 2;

/** Authored quiet period of the shared native clock. */
const PERIOD_SECONDS = 46;

/** Eased 0..1 focus ramp with a per-role onset delay (staged awakening). */
function staged(progress: number, delay: number): number {
  const span = Math.max(0.0001, 1 - delay);
  const ramp = Math.min(1, Math.max(0, (progress - delay) / span));
  return ramp * ramp * (3 - 2 * ramp);
}

/**
 * Authored motion for 07.
 *
 * Every time-dependent channel is an INTEGER harmonic of the declared 46s
 * period (whole cycles per loop), so the native clock seam is invisible:
 * `gust` mixes harmonics 1/2/3, the tassels carry their own harmonic plus a
 * small lag, and the light stays exactly zero. `gust` is the shared SIGNED
 * wind scalar [-1, 1]; under reduced motion it is exactly 0. It only tilts the
 * tassels (bounded rotation about their thread roots) and never scales a
 * time-advancing position.
 *
 * 07 has NO lamp: `light` is identically zero so the interior renders no
 * lamp footprint, and `emissions` is empty. The only interior light is the
 * localized per-eye reflection, driven by the actual eyes below. Hover
 * strengthens only the hovered doll's eyes; press adds a short brightening
 * that the runtime decays (and clears outright under reduced motion). Under
 * reduced motion the bodies hold their rest angle and the eyes/focus stay
 * fully useful.
 */
export function createMotion07(input: MotionInput): FrameMotion {
  const reduced = input.reduced;

  const gust = computed(() => {
    if (reduced()) return 0;
    const t = input.seconds();
    const slow = Math.sin((TAU * t * 1) / PERIOD_SECONDS);
    const mid = Math.sin((TAU * t * 2) / PERIOD_SECONDS + 1.7);
    const drift = Math.sin((TAU * t * 3) / PERIOD_SECONDS + 0.4);
    return slow * 0.55 + mid * 0.3 + drift * 0.15;
  });

  const tasselA = computed(() => {
    if (reduced()) return 0;
    const t = input.seconds();
    return gust() * 0.021 + Math.sin((TAU * t * 2) / PERIOD_SECONDS + 0.9) * 0.004;
  });

  const tasselB = computed(() => {
    if (reduced()) return 0;
    const t = input.seconds();
    // slightly heavier, lagging body - its own phase, not a copy of A
    return gust() * 0.027 + Math.sin((TAU * t * 3) / PERIOD_SECONDS + 2.4) * 0.005;
  });

  // No lamp: the light channel is exactly zero (including reduced motion), so
  // the interior never paints a fictive warm source.
  const light = computed(() => 0);

  const shade = computed(() => (reduced() ? 0.16 : 0.16 + gust() * 0.02));

  // Eyes wake off the smooth native focus track in a staged order (delays are
  // fractions of that transition, ~0/66/132 ms apart); one doll lifts on its
  // own hover and answers a press with a short brightening that the runtime
  // decays (never while reduced). No looped blinking.
  const eyeChannel = (
    delay: number,
    hover: MaybeSignal<number>,
    press: MaybeSignal<number>,
  ) =>
    computed(() => {
      const base = staged(read(input.focus), delay);
      const h = read(hover);
      const p = read(press);
      const value = base * (0.55 + 0.45 * h) + h * 0.32 + p * 0.5;
      return Math.min(1, Math.max(0, value));
    });

  const eyes: FrameMotion["eyes"] = [
    eyeChannel(0, input.hoverMin, input.pressMin),
    eyeChannel(0.22, input.hoverMax, input.pressMax),
    eyeChannel(0.44, input.hoverClose, input.pressClose),
  ];

  return {
    angles: { tasselA, tasselB },
    reveals: {},
    emissions: {},
    wind: gust,
    light,
    shade,
    eyes,
  };
}

/**
 * Frozen pack for 07. Insets: 26 on the sides/bottom and a genuine 48-logical
 * lacquered beam on top (the only pack with this geometry), which is where the
 * native doll controls live. The knot overhangs the ring's left edge, hence
 * the asymmetric left outset.
 */
export const FRAME_07: FramePack = {
  id: "07",
  title: "Rainlit 07 - Lacquered Knot and Dolls",
  version: 1,
  atlas: ATLAS,
  atlasSize: [2048, 2048],
  insets: { left: 26, right: 26, top: 48, bottom: 26 },
  outsets: { left: 24, right: 4, top: 2, bottom: 14 },
  corners: { tl: CORNER_TL, tr: CORNER_TR, bl: CORNER_BL, br: CORNER_BR },
  cornerSize: { top: [42, 64], bottom: [42, 42] },
  rails: { top: RAIL_TOP, bottom: RAIL_BOTTOM, left: RAIL_LEFT, right: RAIL_RIGHT },
  railPeriod: { horizontal: 256, vertical: 128 },
  layers: LAYERS,
  periodSeconds: PERIOD_SECONDS,
  minimumRoot: [240, 160],
  interior: {
    rainStrength: 0.22,
    coolness: 0.58,
    lightAnchor: [0.88, 0.06],
    lightSpread: [0.24, 0.2],
    lightColor: [1.0, 0.58, 0.34],
    edgeShade: 0.18,
  },
  controls: {
    min: "./assets/rainlit-frames/07/doll-min.png",
    max: "./assets/rainlit-frames/07/doll-max.png",
    close: "./assets/rainlit-frames/07/doll-close.png",
    eyesMin: "./assets/rainlit-frames/07/eyes-min.png",
    eyesMax: "./assets/rainlit-frames/07/eyes-max.png",
    eyesClose: "./assets/rainlit-frames/07/eyes-close.png",
    // Shared logical canvas for all six images (the PNGs are 4x = 128x176).
    doll: [32, 44],
    // The eye masks are authored on the SAME full canvas as their doll, with
    // the glow already at the measured pupil positions, so every overlay sits
    // at the canvas origin. No per-doll offset math is needed.
    eyes: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  },
  createMotion: createMotion07,
};

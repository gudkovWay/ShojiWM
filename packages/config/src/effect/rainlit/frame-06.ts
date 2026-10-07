import { computed, read } from "shoji_wm";
import type { FrameMotion, FramePack, MotionInput } from "./types";

/**
 * Rainlit frame profile 06 — patinated bronze, celadon ceramic and a paper
 * pendant.
 *
 * Authoring authority: `tools/build-rainlit-06.py`, which measures the
 * approved `06-painterly.webp` master (RGB, no embedded alpha), derives honest
 * alpha by segmentation, repairs the rounded inner opening to the square
 * material-supported native contour and packs `frame-atlas.png`. The measured
 * cut map and provenance live in
 * `packages/config/assets/rainlit-frames/06/source.json`.
 *
 * Coordinate semantics are the frozen ones in `./types`: `anchor` is a root
 * corner point, `offset` is the signed top-left translation from it, `pivot`
 * is a local logical point from the layer top-left, `angle` is radians and
 * `emission` is an RGB light gain (neutral ≈ 1) that preserves the overlay
 * mask alpha.
 *
 * The bronze frame, the ceramic joins and the lamp sculpture are fixed. Only
 * the paper pendant pivots about its cord attachment; the three lamp apertures
 * carry one shared light, not three unrelated flames. Nothing here reads or
 * changes terminal content or palette.
 */

const ATLAS = "./assets/rainlit-frames/06/frame-atlas.png";

const TAU = Math.PI * 2;

/** Authored quiet period of the shared native clock. */
const PERIOD_SECONDS = 24;

/** The one authored lamp: all three apertures and the sheen read this. */
const LAMP_PERIOD_SECONDS = 12;

/** Rest light scalar under reduced motion (the apertures stay calm, not dark). */
const LIGHT_REST = 0.97;

function lampWaveAt(seconds: number, phase: number): number {
  return Math.sin(seconds * (TAU / LAMP_PERIOD_SECONDS) + phase);
}

export const FRAME_06: FramePack = {
  id: "06",
  title: "Bronze, celadon and ceramic lamp",
  version: 1,
  atlas: ATLAS,
  atlasSize: [2048, 2048],
  insets: { left: 26, right: 26, top: 26, bottom: 26 },
  outsets: { left: 39, right: 94, top: 1, bottom: 52 },
  corners: {
    tl: [0, 732, 168, 168],
    tr: [172, 732, 168, 168],
    bl: [0, 904, 168, 168],
    br: [172, 904, 168, 168],
  },
  cornerSize: { top: [42, 42], bottom: [42, 42] },
  rails: {
    top: [0, 0, 1024, 104],
    bottom: [0, 108, 1024, 104],
    left: [0, 216, 104, 512],
    right: [108, 216, 104, 512],
  },
  railPeriod: { horizontal: 256, vertical: 128 },
  layers: [
    {
      id: "pendant-hook",
      cell: [344, 732, 92, 204],
      anchor: "tl",
      offset: [-23, 0],
      size: [23, 51],
      pivot: [0, 0],
    },
    {
      id: "pendant",
      cell: [344, 940, 132, 500],
      anchor: "tl",
      offset: [-35, 17],
      size: [33, 125],
      // cord attachment at source (82, 151) -> local logical (12, 3)
      pivot: [12, 3],
      angle: "pendant",
    },
    {
      id: "lamp",
      cell: [480, 732, 368, 624],
      anchor: "br",
      offset: [1, -105],
      size: [92, 156],
      pivot: [0, 0],
    },
    {
      id: "lamp-slits",
      cell: [852, 732, 368, 624],
      anchor: "br",
      offset: [1, -105],
      size: [92, 156],
      pivot: [0, 0],
      emission: "slit",
    },
    {
      id: "lamp-sheen",
      cell: [1224, 732, 368, 624],
      anchor: "br",
      offset: [1, -105],
      size: [92, 156],
      pivot: [0, 0],
      emission: "sheen",
    },
  ],
  periodSeconds: PERIOD_SECONDS,
  minimumRoot: [240, 160],
  interior: {
    rainStrength: 0.35,
    coolness: 0.72,
    lightAnchor: [0.9, 0.86],
    lightSpread: [0.34, 0.4],
    lightColor: [1.0, 0.72, 0.38],
    edgeShade: 0.24,
  },
  createMotion: createMotion06,
};

/**
 * 06 motion: the paper pendant pivots about its cord attachment with a small
 * two-component sway (~±1.25°, slower than 02), and the single authored lamp
 * drives all three ceramic apertures plus the local ceramic/bronze sheen. The
 * ceramic silhouette never scales or pulses; the lamp stays on its mount.
 */
export function createMotion06(input: MotionInput): FrameMotion {
  const calm = computed(() => read(input.reduced));

  // Finding 9: every time-dependent channel is an integer harmonic of the
  // 24s native clock (period 24/k), so each loop seam is continuous. The
  // pendant sway uses 12s and 6s components.
  const pendant = computed(() => {
    if (calm()) return 0;
    const t = read(input.seconds);
    return Math.sin(t * (TAU / 12)) * 0.0105 + Math.sin(t * (TAU / 6) + 1.9) * 0.0045;
  });

  const lampEnergy = computed(() => {
    if (calm()) return LIGHT_REST;
    return 0.955 + 0.04 * lampWaveAt(read(input.seconds), 0.7);
  });

  // The three apertures share the lamp; the emission is an RGB gain near 1.
  const slit = computed(() => {
    if (calm()) return 0.98;
    return 0.94 + 0.07 * lampWaveAt(read(input.seconds), 0.7);
  });

  // Weak local ceramic/bronze reflection follows the same light, lagging.
  const sheen = computed(() => {
    if (calm()) return 0.86;
    return 0.82 + 0.14 * lampWaveAt(read(input.seconds), 1.5);
  });

  // Wind is a signed tilt channel in [-1,1] with zero rest; its 12s and 8s
  // components are integer harmonics of the clock, so the seam is
  // continuous and reduced motion rests at exactly 0.
  const wind = computed(() => {
    if (calm()) return 0;
    const t = read(input.seconds);
    return 0.14 * Math.sin(t * (TAU / 12)) + 0.06 * Math.sin(t * (TAU / 8) + 2.3);
  });

  const shade = computed(() => {
    if (calm()) return 0;
    return 0.05 + 0.03 * Math.sin(read(input.seconds) * (TAU / 12) + 1.1);
  });

  return {
    angles: { pendant },
    reveals: {},
    emissions: { slit, sheen },
    wind,
    light: lampEnergy,
    shade,
    eyes: [0, 0, 0],
  };
}

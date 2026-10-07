import { computed, read, type MaybeSignal, type ReadonlySignal } from "shoji_wm";
import type {
  FrameLayer,
  FrameMotion,
  FramePack,
  MotionInput,
  RainlitFrameId,
} from "./types";

/**
 * Rainlit frame 09 — "Rain Charms & Paper Garlands".
 *
 * Authored profile, not a rendered/runtime-verified result. The atlas is the
 * reproducible output of `tools/build-rainlit-09.py` from the owner-approved
 * painterly master; provenance, cuts, alpha authority and geometry live in
 * `packages/config/assets/rainlit-frames/09/source.json`.
 *
 * Structure: the neutral wooden rails and the four one-shot corners contain no
 * ornament at all. The bamboo blind, both exterior mounts, the three cloth rain
 * charms and the three folded-paper cranes are their own atlas cells. Each
 * cloth/paper cell carries its own continuous connector, so the chains are
 * built from a stationary root with per-link lagging angles and never show a
 * second static copy of a garland behind the moving one.
 *
 * Geometry contract (frozen, see source.json): anchor is a point (tl=(0,0),
 * tr=(rootWidth,0), bl=(0,rootHeight), br=(rootWidth,rootHeight)); `offset` is
 * the layer top-left translation from that point, signed +x right / +y down;
 * `pivot` is a local logical point from the layer's own top-left; a child's
 * offset/pivot are relative to the parent's unrotated top-left, so the joint
 * stays connected through the whole swing. `angle` is radians.
 *
 * This profile has no reveal, no emission, no lamp, no eyes and no bamboo
 * unroll: `light` and the eye channels are constant zero, which is the
 * deliberate difference from frame 02.
 */

const FRAME_ID: RainlitFrameId = "09";

// Logical geometry emitted by the builder; all values are logical pixels.

const LAYERS: FrameLayer[] = [
  // Fixed structures. No angle / reveal / emission channel.
  {
    id: "bamboo",
    cell: [0, 736, 562, 152],
    anchor: "tl",
    offset: [2.925, -10.651],
    size: [140.4, 37.904],
    pivot: [0, 0],
  },
  {
    id: "mount-left",
    cell: [572, 736, 96, 48],
    anchor: "tl",
    offset: [-25.025, 0.313],
    size: [24.05, 15.036],
    pivot: [0, 0],
  },
  {
    id: "mount-right",
    cell: [678, 736, 71, 53],
    anchor: "tr",
    offset: [0.325, -0.313],
    size: [17.55, 13.157],
    pivot: [0, 0],
  },

  // Cloth chain: heaviest, slowest, lagging link by link. The hem deforms
  // softly; the heads stay fixed, so `deform: "cloth"` is per body segment.
  {
    id: "fabric-1",
    cell: [759, 736, 139, 256],
    anchor: "tl",
    offset: [-36.075, 15.349],
    size: [34.775, 63.904],
    pivot: [18.85, 0],
    angle: "fabric1",
    deform: "cloth",
  },
  {
    id: "fabric-2",
    cell: [908, 736, 139, 215],
    anchor: "tl",
    offset: [0, 62.651],
    size: [34.775, 53.88],
    pivot: [18.85, 0],
    parent: "fabric-1",
    angle: "fabric2",
    deform: "cloth",
  },
  {
    id: "fabric-3",
    cell: [1057, 736, 139, 226],
    anchor: "tl",
    offset: [0, 52.627],
    size: [34.775, 56.386],
    pivot: [17.875, 0],
    parent: "fabric-2",
    angle: "fabric3",
    deform: "cloth",
  },

  // Folded paper: rigid pivot rotation, no rubber wing stretch.
  {
    id: "crane-1",
    cell: [1206, 736, 151, 205],
    anchor: "tr",
    offset: [0.975, 10.337],
    size: [37.7, 51.373],
    pivot: [11.7, 0],
    angle: "crane1",
  },
  {
    id: "crane-2",
    cell: [1367, 736, 151, 150],
    anchor: "tl",
    offset: [0, 50.12],
    size: [37.7, 37.59],
    pivot: [15.6, 0],
    parent: "crane-1",
    angle: "crane2",
  },
  {
    id: "crane-3",
    cell: [1528, 736, 151, 153],
    anchor: "tl",
    offset: [0, 36.964],
    size: [37.7, 38.217],
    pivot: [15.925, 0],
    parent: "crane-2",
    angle: "crane3",
  },
];

const DEG = Math.PI / 180;

/** Declared native clock period; every time-dependent scalar is periodic on it. */
const PERIOD_SECONDS = 21;
const BASE_RATE = (2 * Math.PI) / PERIOD_SECONDS;

/**
 * One authored gust drives both garlands and the Kitty rain. The three summed
 * harmonics are integer multiples (1x/2x/3x) of the declared 21-second clock,
 * so this scalar — and every angle derived from it — is seam-continuous across
 * the native loop reset; the arbitrary constant phase lags only offset the
 * links. The frame and the interior read the exact same scalar and never drift
 * apart. The result is a bounded signed gust in [-1, 1] with rest 0.
 */
function breeze(t: number): number {
  return (
    0.55 * Math.sin(BASE_RATE * t) +
    0.3 * Math.sin(2 * BASE_RATE * t + 1.7) +
    0.15 * Math.sin(3 * BASE_RATE * t + 4.1)
  );
}

function chainAngle(
  seconds: ReadonlySignal<number>,
  reduced: ReadonlySignal<boolean>,
  amplitudeDeg: number,
  lagSeconds: number,
): ReadonlySignal<number> {
  return computed(() => {
    if (read(reduced)) {
      return 0;
    }
    return DEG * amplitudeDeg * breeze(read(seconds) - lagSeconds);
  });
}

export function createRainlit09Motion(input: MotionInput): FrameMotion {
  const { seconds, reduced } = input;

  const wind = computed(() => (read(reduced) ? 0 : breeze(read(seconds))));
  const shade = computed(() => 0.88 + 0.12 * Math.abs(wind.value));

  const zero: ReadonlySignal<number> = computed(() => 0);

  const angles: Record<string, MaybeSignal<number>> = {
    // Cloth: heavier and slower, an extra lag per link so the hem trails.
    fabric1: chainAngle(seconds, reduced, 1.5, 0),
    fabric2: chainAngle(seconds, reduced, 1.35, 0.9),
    fabric3: chainAngle(seconds, reduced, 1.2, 1.8),
    // Paper: lighter, quicker reaction, a smaller per-link lag.
    crane1: chainAngle(seconds, reduced, 2.6, 0),
    crane2: chainAngle(seconds, reduced, 2.3, 0.5),
    crane3: chainAngle(seconds, reduced, 2.0, 1.0),
  };

  return {
    angles,
    reveals: {},
    emissions: {},
    wind,
    light: zero,
    shade,
    eyes: [zero, zero, zero],
  };
}

export const FRAME_09: FramePack = {
  id: FRAME_ID,
  title: "Rain Charms & Paper Garlands",
  version: 1,
  atlas: "./assets/rainlit-frames/09/frame-atlas.png",
  atlasSize: [2048, 2048],
  insets: { left: 26, right: 26, top: 26, bottom: 26 },
  outsets: { left: 48, right: 52, top: 14, bottom: 4 },
  corners: {
    tl: [216, 216, 168, 168],
    tr: [388, 216, 168, 168],
    bl: [560, 216, 168, 168],
    br: [732, 216, 168, 168],
  },
  cornerSize: { top: [42, 42], bottom: [42, 42] },
  rails: {
    top: [0, 0, 1024, 104],
    bottom: [0, 108, 1024, 104],
    left: [0, 216, 104, 512],
    right: [108, 216, 104, 512],
  },
  railPeriod: { horizontal: 256, vertical: 128 },
  layers: LAYERS,
  periodSeconds: PERIOD_SECONDS,
  minimumRoot: [240, 240],
  interior: {
    rainStrength: 0.85,
    coolness: 0.9,
    lightAnchor: [0.5, 0.55],
    lightSpread: [0.7, 0.62],
    // Air-rain profile: no lamp, no warm reflection to fake.
    lightColor: [0, 0, 0],
    edgeShade: 0.12,
  },
  createMotion: createRainlit09Motion,
};

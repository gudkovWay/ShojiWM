import type { FramePack } from "./types";

/**
 * Design-faithful artwork metadata for rainlit pack 02.
 *
 * Authored by `tools/build-rainlit-02.py` from the real `gpt-image-2`
 * component masters under
 * `assets/rainlit-frames/02/design-faithful/source/`; measured cell
 * rectangles, cuts and provenance live in
 * `assets/rainlit-frames/02/design-faithful/source.json`. The 52 logical px
 * ring doubles every ornament's geometry while the accepted bamboo cells
 * keep their authored pixels.
 *
 * Imported pure: no asset loading, effect compilation or selection side
 * effects.
 *
 * `lightPlacement` is the measured real paper-lamp centre and bounded
 * spill. It belongs to the pack's INTERIOR profile rather than the
 * top-level frame geometry, so `frame-02.ts` spreads the rest of the
 * artwork and binds this field under `interior`.
 */
export interface Frame02Art
  extends Pick<
    FramePack,
    "atlas" | "atlasSize" | "corners" | "cornerSize" | "rails" | "railPeriod" | "layers"
  > {
  readonly lightPlacement: NonNullable<FramePack["interior"]["lightPlacement"]>;
}

export const FRAME_02_ART: Frame02Art = {
  atlas: "./assets/rainlit-frames/02/design-faithful/frame-atlas.png",
  atlasSize: [2048, 2048],
  corners: {
    tl: [1032, 112, 416, 416],
    tr: [1452, 112, 416, 416],
    bl: [4, 532, 416, 416],
    br: [424, 532, 416, 416],
  },
  cornerSize: {
    top: [104, 104],
    bottom: [104, 104],
  },
  rails: {
    top: [4, 4, 1024, 104],
    bottom: [4, 112, 1024, 104],
    left: [844, 532, 104, 512],
    right: [952, 532, 104, 512],
  },
  railPeriod: { horizontal: 512, vertical: 256 },
  layers: [
    {
      id: "bamboo-slat",
      cell: [565, 1048, 331, 52],
      anchor: "tl",
      offset: [40.5, 18.5],
      size: [165.5, 26],
      pivot: [82.75, -17],
      angle: "bambooAngle",
      reveal: "bambooReveal",
      revealMode: "slide",
      translateY: "bambooTranslateY",
    },
    {
      id: "bamboo-roll",
      cell: [230, 1048, 331, 68],
      anchor: "tl",
      offset: [40.5, -15.5],
      size: [165.5, 34],
      pivot: [82.75, 17],
      angle: "bambooAngle",
      translateY: "bambooTranslateY",
    },
    {
      id: "tie-near",
      cell: [900, 1048, 38, 114],
      anchor: "tl",
      offset: [61, -17],
      size: [19, 57],
      pivot: [9.5, 2],
    },
    {
      id: "tie-far",
      cell: [942, 1048, 38, 114],
      anchor: "tl",
      offset: [165, -17],
      size: [19, 57],
      pivot: [9.5, 2],
    },
    {
      id: "crane-hook",
      cell: [984, 1048, 30, 44],
      anchor: "tr",
      offset: [13, 36],
      size: [15, 22],
      pivot: [7.5, 11],
    },
    {
      id: "crane",
      cell: [1060, 532, 320, 256],
      anchor: "tr",
      offset: [-18.192, 58],
      size: [80, 63.931],
      pivot: [38.692, 0],
      angle: "craneAngle",
    },
    {
      id: "lamp-bracket",
      cell: [4, 1048, 222, 146],
      anchor: "br",
      offset: [-10.635, -173.415],
      size: [55.44, 36.435],
      pivot: [40.635, 23.415],
    },
    {
      id: "lamp",
      cell: [1384, 532, 235, 509],
      anchor: "br",
      offset: [1.86, -152.1],
      size: [58.695, 127.365],
      pivot: [28.14, 2.1],
      angle: "lampAngle",
    },
    {
      id: "lamp-paper",
      cell: [1623, 532, 235, 509],
      anchor: "br",
      offset: [1.86, -152.1],
      size: [58.695, 127.365],
      pivot: [28.14, 2.1],
      angle: "lampAngle",
      emission: "lampEnergy",
    },
    {
      id: "lamp-wood-glow",
      cell: [1018, 1048, 80, 230],
      anchor: "br",
      offset: [-40, -158],
      size: [40, 115],
      pivot: [20, 12],
      emission: "lampEnergy",
    },
  ],
  lightPlacement: {
    anchor: "br",
    offset: [31.1, -87.2],
    spread: [114.4, 88.4],
  },
};

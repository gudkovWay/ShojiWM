/**
 * Shared logical geometry for rainlit frame pack 02 (bamboo roll, paper crane,
 * paper lamp). ONE constants source consumed by the frame pack
 * (`frame-02.ts`), the daughter-scene motion (`scene-02.ts`) and the runtime
 * (`runtime.ts`), so the painted ring, the client opening, the real floor, the
 * decorative button and the fixed suspension anchors can never drift apart.
 *
 * Values are LOGICAL pixels, measured from the design-faithful 02 artwork
 * (`packages/config/assets/rainlit-frames/02/design-faithful/`): the ring is
 * one authored 52px painted timber beam on every side, so the protected client
 * opening is the root minus 2 x 52 and the runtime derives the real client
 * floor and the client-local positions from that single inset. Nothing here
 * constructs signals, loads assets or compiles effects.
 *
 * `FRAME_02_BAMBOO_ANCHORS` are the two FIXED upper suspension anchors of the
 * loosened red loops in LOGICAL ROOT coordinates; at rest they coincide with
 * the tie layers' world pivots (`offset + pivot`), and they are the anchors the
 * runtime's fixed cords are drawn from.
 */

/** Painted timber ring inset per side, logical px (one authored beam). */
export const FRAME_02_INSET = 52;

/** Declared minimum root [width, height] below which ornaments shrink uniformly. */
export const FRAME_02_MINIMUM_ROOT = [480, 320] as const;

/** Authored maximum bottom of the exposed bamboo at rest, logical px. */
export const FRAME_02_BAMBOO_MAX_BOTTOM = 44.5;

/**
 * Fixed upper suspension anchors of the two loosened loops, LOGICAL ROOT
 * px, in tie-near / tie-far order. Each equals that tie layer's rest world
 * pivot, so the cord length is zero at the quiet seam.
 */
export const FRAME_02_BAMBOO_ANCHORS = [
  [70.5, -15],
  [174.5, -15],
] as const;

/**
 * Logical root x span the scene scale opens for the decorative button: the
 * button sits at `FRAME_02_INSET` at scene scale 0 and one span further right
 * at scene scale 1. Shared so the runtime's button uniform, the motion's
 * press-contact geometry and the authored story can never disagree.
 */
export const FRAME_02_BUTTON_SPAN = 92;

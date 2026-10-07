/**
 * Shared unified-frame geometry, owned by the frame integration workstream.
 *
 * The native chrome (index.tsx) and the two rain GLSL factories must agree on
 * exactly one border constant, otherwise the painted material and the reserved
 * native ring drift apart:
 *
 * - `RAIN_BORDER_PX` — painted rails reserved by positive side/bottom insets
 *   and a native header of the same height. The top has no extra inset;
 *   the total target overhead is a fixed 52px.
 * - `RAIN_CAP_PX` — fixed brass corner cap size in logical px.
 *
 * The source atlas is unchanged; only this logical geometry is shared between
 * the native layout and the shader uniforms.
 */
export const RAIN_BORDER_PX = 26;
export const RAIN_CAP_PX = 42;

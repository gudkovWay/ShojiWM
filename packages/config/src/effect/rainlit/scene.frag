// Rainlit bamboo-girl scene stage (pack 02, Kitty interiors only). Compiled
// by rainlit/runtime.ts and appended AFTER the generic frame shader
// (frame.frag) in the WINDOW frame-effect pipeline. Its input `tex` is the
// frame shader's own output: STRAIGHT (unpremultiplied) RGBA frame art — the
// painted ring outside the client opening, the captured native header band,
// and a perfectly transparent client opening (frame.frag hard-returns 0
// there). This stage therefore composites the story foreground OVER the
// frame art INSIDE the client opening, and returns the incoming frame art
// completely untouched anywhere outside it — EXCEPT the fixed suspension
// cords, which are the one overlay allowed across the native frame/client
// clip so the cable never breaks at the boundary.
//
// Frozen semantics:
// - The effect rect is the whole decorated window, so the shader recovers the
//   ROOT logical pixel exactly like frame.frag (effect_frame_px over
//   frame_rect_px / root logical size), then subtracts the ring insets ONCE
//   to reach the client-local space every position uniform is authored in.
// - The incoming straight frame art is premultiplied exactly once into the
//   accumulator; every sprite (bamboo layers, girl, button, impacts) is then
//   composited with a genuine source-over in premultiplied space, and the
//   accumulator is converted back to straight RGB at the boundary exactly
//   once (the compositor multiplies RGB by alpha at the final boundary).
//   Sprite alpha is NEVER weighted by the incoming alpha: inside the client
//   the incoming alpha is 0, so that would erase the whole foreground.
// - The four bamboo layers (slat, roll, tie-near, tie-far) are drawn from the
//   ORIGINAL pack atlas using the SAME cells/sizes/pivots/positions/angles/
//   reveal/translation the frame stage uses (runtime reuses the identical FK
//   signals), so the group reads as one continuous object across the frame
//   ring and the client.
// - Fixed red suspension: two ~1px braided cords span from the FIXED upper
//   anchors (shared `FRAME_02_BAMBOO_ANCHORS`, root [70.5, -15] and
//   [174.5, -15], scaled by the same ornament scale) down to the CURRENT
//   moving tie pivots (pos + pivot, the pivot is rotation-invariant, so the
//   attachment is stable). At rest both ends coincide; as the assembly
//   descends the cord lengthens — a controlled payout with real tension — and
//   a bounded lateral sag appears only on the floor impact. Nothing here
//   introduces a second clock; the descent length is the existing shared
//   `bambooOffsetY`. The cord is drawn BEFORE the bamboo layers, so it stays
//   behind the bundle and the ties.
// - The girl is one indexed 16-cell atlas draw with a uniform whole-sprite
//   horizontal mirror (facing < -0.5 flips the local u axis); alpha comes
//   from the atlas's real transparency, never a luminance key. The authored
//   girl fade (`g_opacity`) and the button gate (`b_opacity`) are the SAME
//   signal, so the STORY overlay (girl + button) is exactly transparent at
//   rest / quiet / reduced.
// - There is NO ambient foreground weather and NO lamp spill here: the
//   rejected grey swaying lanes/drops were removed by owner imperative, and
//   the restored S-tier ambient (the legacy lantern backdrop plus the
//   content-aware weather `replace`) owns the interior lighting through its
//   own effects. This stage only composites the story foreground.
// - The decorative button and the floor/ceiling impacts are SMALL LOCALIZED
//   fields drawn as bounded source-over face/warm-dust sprites: no opaque
//   plate, no global flash, and no multiplicative shade over client pixels
//   (which are not sampled here).
// - Both atlases are preloaded image sources bound once at compile time.

uniform sampler2D frame_atlas;
uniform vec2 frame_atlas_size; // source px
uniform sampler2D scene_atlas;
uniform vec2 scene_atlas_size; // source px
uniform vec2 logical_size;     // client opening logical size
uniform vec2 scene_frame_size; // ROOT logical size (frame.frag's logical_size)
uniform vec4 scene_insets;     // left, top, right, bottom logical px (ring)
uniform float scene_scale;     // sceneScale = girlScale / 0.20
uniform vec4 sc_cell[4];
uniform vec2 sc_size[4];
uniform vec2 sc_pivot[4];
uniform vec2 sc_pos[4];
uniform float sc_angle[4];
uniform float sc_reveal[4];
uniform float sc_reveal_mode[4];
uniform vec4 g_cell;
uniform vec2 g_pos;
uniform vec2 g_size;
uniform float g_facing;
uniform float g_opacity;
uniform float b_opacity;
uniform vec2 b_center;
uniform vec2 b_size;
uniform float b_press;
uniform float floor_impact;
uniform float ceiling_impact;
// Fixed suspension: upper anchors (client-local logical px), moving tie-pivot
// attachments, and the 0..1 floor-impact slack that bends the cord a little.
uniform vec2 cord_a0;
uniform vec2 cord_e0;
uniform vec2 cord_a1;
uniform vec2 cord_e1;
uniform float cord_slack;

// Half-source-texel inset sample of one atlas cell (identical to the frame
// stage's helper): keeps linear filtering inside the cell's transparent
// gutter. `t` is local [0,1]^2.
vec4 rl_scene_cell_sample(sampler2D atlas, vec2 atlas_size, vec4 cell, vec2 t) {
    vec2 c = clamp(t, 0.0, 1.0);
    vec2 px = cell.xy + vec2(0.5) + c * (cell.zw - vec2(1.0));
    return texture2D(atlas, px / max(atlas_size, vec2(1.0)));
}

// Premultiplied source-over: both operands are premultiplied.
vec4 rl_scene_over(vec4 dst, vec4 src) {
    return src + dst * (1.0 - src.a);
}

// One fixed suspension cord: a thin braided red line from the fixed upper
// anchor `a` to the current tie pivot `e`. Distance is measured to a quadratic
// Bezier whose control point adds a bounded lateral sag only under the floor
// impact (`slack`), so the payout stays taut while it lengthens. Returns
// premultiplied coverage. The cord is near-vertical, so the braid phase is
// keyed to y (a cheap, stable parameter along its length).
vec4 rl_scene_cord(vec2 p, vec2 a, vec2 e, float slack, float seed) {
    // Conservative bounds reject BEFORE any geometry work: the cord endpoints,
    // the <=3 px lateral sag and the sub-pixel braided weave all stay inside
    // this box, so a fragment far from the cord skips the segment evaluation.
    vec2 lo = min(a, e) - vec2(4.0, 1.0);
    vec2 hi = max(a, e) + vec2(4.0, 1.0);
    if (p.x < lo.x || p.x > hi.x || p.y < lo.y || p.y > hi.y) {
        return vec4(0.0);
    }
    vec2 chord = e - a;
    float len = length(chord);
    vec2 perp = len > 1e-3 ? vec2(-chord.y, chord.x) / len : vec2(1.0, 0.0);
    vec2 ctrl = 0.5 * (a + e) + perp * (clamp(slack, 0.0, 1.0) * 3.0);
    // Small braided weave: the centreline drifts a fraction of a pixel.
    vec2 pw = vec2(p.x - 0.15 * sin(p.y * 0.7 + seed * 2.1), p.y);
    vec2 prev = a;
    float dmin = 1e9;
    for (int k = 1; k <= 8; k++) {
        float t = float(k) / 8.0;
        float mt = 1.0 - t;
        vec2 pt = mt * mt * a + 2.0 * mt * t * ctrl + t * t * e;
        vec2 pa = pw - prev;
        vec2 ba = pt - prev;
        float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
        dmin = min(dmin, length(pa - ba * h));
        prev = pt;
    }
    // ~1 px cord: half-width 0.5 with a sub-pixel antialiased shoulder.
    float body = 1.0 - smoothstep(0.44, 0.60, dmin);
    // Braided highlight ripple; only ever DARKENS coverage, never widens it.
    float braid = 0.82 + 0.18 * sin(p.y * 1.8 + seed * 1.3);
    float cov = body * braid;
    if (cov <= 1e-4) {
        return vec4(0.0);
    }
    vec3 col = vec3(0.60, 0.135, 0.115);
    return vec4(col * cov, cov);
}

vec4 shader_main(EffectContext effect) {
    vec4 src = texture2D(tex, effect.texture_uv);
    vec2 logical = max(logical_size, vec2(1.0));

    // Root logical pixel, recovered exactly like frame.frag; then ONE inset
    // subtraction into the client-local space the position uniforms use.
    vec2 root = max(scene_frame_size, vec2(1.0));
    vec2 framePx = max(effect.frame_rect_px.zw, vec2(1.0));
    vec2 p = effect_frame_px(effect) / (framePx / root) - scene_insets.xy;

    // Fixed suspension, drawn in BOTH spaces so the cable crosses the native
    // frame/client clip with no gap.
    vec4 cord = rl_scene_over(
        rl_scene_cord(p, cord_a0, cord_e0, cord_slack, 0.0),
        rl_scene_cord(p, cord_a1, cord_e1, cord_slack, 1.0)
    );

    // Outside the client opening (frame ring, header band) the incoming frame
    // art — rails, corners, real native controls — is returned untouched,
    // except where the suspension cord actually covers a pixel.
    if (p.x < 0.0 || p.y < 0.0 || p.x > logical.x || p.y > logical.y) {
        if (cord.a <= 1e-4) {
            return src;
        }
        vec4 pm = rl_scene_over(vec4(src.rgb * src.a, src.a), cord);
        float a = clamp(pm.a, 0.0, 1.0);
        if (a <= 1e-4) {
            return vec4(0.0);
        }
        return vec4(pm.rgb / a, a);
    }

    // Premultiply the incoming straight frame art once. Inside the client this
    // is exactly zero, so only the sprites below contribute coverage.
    vec4 acc = vec4(src.rgb * src.a, src.a);
    acc = rl_scene_over(acc, cord);

    // Bamboo continuation: the exact frame-stage layer math, in client-local
    // space. Sampled from the ORIGINAL pack atlas so the material matches
    // the ring pixel for pixel. Genuine source-over: the layer's real alpha is
    // used directly, never weighted by the incoming coverage.
    for (int i = 0; i < 4; i++) {
        vec2 size = max(sc_size[i], vec2(0.001));
        vec2 pivot = sc_pivot[i];
        float ang = sc_angle[i];
        float ca = cos(ang);
        float sa = sin(ang);
        vec2 c = p - (sc_pos[i] + pivot);
        vec2 q = vec2(ca * c.x + sa * c.y, -sa * c.x + ca * c.y) + pivot;
        float rev = clamp(sc_reveal[i], 0.0, 1.0);
        bool slide = sc_reveal_mode[i] > 0.5;
        if (slide) {
            if (rev <= 0.0) { continue; }
            q.y += (1.0 - rev) * size.y;
        }
        vec2 t = q / size;
        if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) { continue; }
        vec4 cs = rl_scene_cell_sample(frame_atlas, frame_atlas_size, sc_cell[i], t);
        acc = rl_scene_over(acc, vec4(cs.rgb * cs.a, cs.a));
    }

    // The girl: one indexed atlas draw with a uniform mirror. facing < -0.5
    // means the sheet was authored facing left and this draw is reflected to
    // face right; the reflection flips the local u axis only. Alpha is the
    // atlas's real transparency times the authored girl fade.
    {
        vec2 q = p - g_pos;
        if (g_facing < -0.5) { q.x = g_size.x - q.x; }
        vec2 t = q / max(g_size, vec2(0.001));
        float ga = clamp(g_opacity, 0.0, 1.0);
        if (t.x >= 0.0 && t.x <= 1.0 && t.y >= 0.0 && t.y <= 1.0 && ga > 0.001) {
            vec4 gs = rl_scene_cell_sample(scene_atlas, scene_atlas_size, g_cell, t);
            float a = gs.a * ga;
            acc = rl_scene_over(acc, vec4(gs.rgb * a, a));
        }
    }

    // Decorative press button: a small soft rounded face with a warm rim,
    // brightness following the same causal press channel that releases the
    // bamboo. Gated by the authored girl opacity so it never appears at rest,
    // quiet or reduced. Alpha stays far below opaque; no plate, no flash.
    {
        float gate = clamp(b_opacity, 0.0, 1.0);
        vec2 hb = b_size * 0.5;
        vec2 d = abs(p - b_center) / max(hb, vec2(0.001));
        float m = max(d.x, d.y);
        float face = (1.0 - smoothstep(0.85, 1.0, m));
        float rim = smoothstep(0.55, 0.85, m) * (1.0 - smoothstep(0.85, 1.0, m));
        vec3 faceCol = vec3(0.16, 0.13, 0.10) + vec3(0.55, 0.38, 0.18) * b_press * 0.45;
        float faceA = (0.30 * face + 0.35 * rim) * (0.55 + 0.45 * b_press) * gate;
        acc = rl_scene_over(acc, vec4(faceCol * faceA, faceA));
        // Bounded warm halo while pressed, lighting only EXISTING coverage.
        vec2 hd = (p - b_center) / max(hb * 3.0, vec2(0.001));
        float halo = exp(-dot(hd, hd)) * b_press * 0.30 * gate;
        acc.rgb += vec3(1.0, 0.72, 0.35) * halo * acc.a;
    }

    // Floor impact: a bounded warm dust kiss at the REAL client floor under the
    // bamboo bundle (the girl is offscreen during the drop, so the impact must
    // follow the bundle, not the girl). Drawn source-over, never a
    // multiplicative shade over client pixels.
    {
        float bx = sc_pos[1].x + sc_size[1].x * 0.5;
        vec2 c = vec2(bx, logical.y - 1.0);
        vec2 d = (p - c) / vec2(max(70.0 * scene_scale, 1.0), max(11.0 * scene_scale, 1.0));
        float f = exp(-dot(d, d)) * clamp(floor_impact, 0.0, 1.0);
        float da = f * 0.30;
        acc = rl_scene_over(acc, vec4(vec3(0.62, 0.55, 0.42) * da, da));
    }

    // Ceiling impact: the same warm dust at the nearest client-top point UNDER
    // the bamboo bundle (the resting bundle centre is above the client, so the
    // visible hit line is the client top edge beneath it).
    {
        float bx = sc_pos[1].x + sc_size[1].x * 0.5;
        vec2 c = vec2(bx, 0.0);
        vec2 d = (p - c) / vec2(max(60.0 * scene_scale, 1.0), max(16.0 * scene_scale, 1.0));
        float f = exp(-dot(d, d)) * clamp(ceiling_impact, 0.0, 1.0);
        float da = f * 0.24;
        acc = rl_scene_over(acc, vec4(vec3(0.66, 0.60, 0.46) * da, da));
    }

    float outA = clamp(acc.a, 0.0, 1.0);
    if (outA <= 1e-4) {
        return vec4(0.0);
    }
    // Final boundary: back to straight RGB carrying the original alpha.
    return vec4(acc.rgb / outA, outA);
}

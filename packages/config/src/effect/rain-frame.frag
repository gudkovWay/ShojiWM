// Rainlit Shoji v2 static candidate. Native-size source-derived wood and brass
// are sampled from the layered RGBA atlas; only neutral structural rails repeat.
// The native 26px ring and 42px fixed joins stay independent of window size.
// The protected rectangular client opening is transparent before any artwork
// is evaluated. Native runtime appearance and joins remain unverified.
//
// All geometry is expressed in logical pixels. `logical_size` is the root
// logical size supplied by the parent; the physical/logical scale comes from
// the native frame rect, so the painted material always lines up with the
// reserved border. `border_px` (26) and `cap_px` (42) are the shared layout
// constants supplied by the factory, so the window layout and this GLSL agree
// on exactly one border thickness instead of a hidden reservation. The frame
// is static: no phase, no time, no events.
//
// Inside the top header band — y in [0, border), x in [border, W-border] — the
// captured native source (the transparent native header surface plus its real
// minimize/maximize/close controls) is composited source-over the painted wood
// after the focus trim, so the interactive native glyphs and hover plates read
// above the frame instead of being covered by it. `tex` is the premultiplied
// full-source capture and `rf_over` expects premultiplied input, matching the
// premultiplied accumulator; only the header band is sampled, never the client
// or the rest of the ring.
//
// The internal accumulator is premultiplied (straight atlas samples are
// premultiplied exactly once). Because this is the final stage of the whole
// window effect, the accumulator is converted back to straight RGB at the
// final boundary — the native display wrapper multiplies RGB by alpha, so
// premultiplied output here would be double-premultiplied. Zero alpha
// returns zero.
//
// The atlas is 1024x1024. Every structural rail has 104 source pixels across
// its full material profile: 26 logical pixels at natural 0.25 scale, sufficient
// source detail for 2x outputs without enlarging a 7px crop. Corners are 168px
// canvases with matching 104px L-profile arms, uniformly drawn at 42px once.
// Source-derived rail endpoints are authored to repeat; sculpture never repeats.

uniform sampler2D frame_atlas;
uniform vec2 logical_size;  // root logical width/height
// Identical structural art for Kitty and Zen; app-specific ambiance is separate.
uniform float focused;      // 0..1 focus strength
uniform float border_px;    // reserved native border width (26, shared layout)
uniform float cap_px;       // fixed brass corner cap size (42, shared layout)

const vec2 RF_ATLAS_PX = vec2(1024.0, 1024.0);

// Sample one atlas cell. `t` is local [0,1]^2 inside the cell; a half-source-
// texel inset keeps linear filtering inside the cell's transparent gutter.
vec4 rf_cell(vec4 cell, vec2 t) {
    vec2 c = clamp(t, 0.0, 1.0);
    vec2 px = cell.xy + vec2(0.5) + c * (cell.zw - vec2(1.0));
    return texture2D(frame_atlas, px / RF_ATLAS_PX);
}

// Antialiased coverage of an axis-aligned rectangle in logical pixels.
float rf_rect(vec2 p, vec2 lo, vec2 hi, vec2 aa) {
    vec2 enter = smoothstep(lo - aa, lo + aa, p);
    vec2 leave = vec2(1.0) - smoothstep(hi - aa, hi + aa, p);
    return clamp(enter.x * enter.y * leave.x * leave.y, 0.0, 1.0);
}

// Straight atlas sample -> premultiplied, scaled by coverage.
vec4 rf_pm(vec4 c, float cov) {
    float a = c.a * cov;
    return vec4(c.rgb * a, a);
}

// Premultiplied source-over.
vec4 rf_over(vec4 dst, vec4 src) {
    return src + dst * (1.0 - src.a);
}

vec4 shader_main(EffectContext effect) {
    vec2 logical = max(logical_size, vec2(1.0));
    vec2 framePx = max(effect.frame_rect_px.zw, vec2(1.0));
    vec2 scale = framePx / logical;
    vec2 aa = vec2(1.0) / max(scale, vec2(1.0));

    // Logical-pixel position relative to the frame's top-left (negative in the
    // exterior outsets, past `logical` beyond the right/bottom edges).
    vec2 p = effect_frame_px(effect) / scale;

    // Shared layout constants (logical px). Clamped at zero so a bad binding
    // can never invert the ring or open the protected client.
    float border = max(border_px, 0.0);
    float cap = max(cap_px, 0.0);

    // Hard invariant: the protected client opening is perfectly transparent.
    // Returned before any rail, cap or ornament is evaluated.
    if (p.x >= border && p.x <= logical.x - border && p.y >= border && p.y <= logical.y - border) {
        return vec4(0.0);
    }

    // Uniform shrink for genuinely tiny roots: ornaments and their offsets
    // scale together so they keep their aspect ratio and stay inside the
    // exterior budget. The ring and the fixed corner caps never scale.
    float fit = clamp(min(logical.x / 240.0, logical.y / 160.0), 0.0, 1.0);

    vec4 acc = vec4(0.0);

    // Full-depth structural wood, repeated only along its natural long axis.
    // Corresponding corner supports share the same transverse material profile.
    //
    // Mitred rail turn. The four rail rectangles overlap in the 26x26 logical
    // corner squares, so the top/bottom and left/right rails must meet on the
    // same 45-degree mitre the corner atlas cells are authored with, instead of
    // one rail overwriting the whole intersection. Each pixel takes the arm
    // whose outer frame contour is nearer: distance to the nearest horizontal
    // edge (top or bottom) versus the nearest vertical edge (left or right).
    // Outside the corner squares a single distance dominates and the weight is
    // exactly 1, so a plain rail run is untouched; the protected opening and
    // the native header band are both evaluated before this and stay untouched.
    float dh = min(p.y, logical.y - p.y);
    float dv = min(p.x, logical.x - p.x);
    float mitreAA = max(aa.x, 0.375);  // authored 1.5 atlas px at 4 atlas px/logical
    float wh = clamp(0.5 + (dv - dh) / mitreAA, 0.0, 1.0);
    wh = wh * wh * (3.0 - 2.0 * wh);
    float wv = 1.0 - wh;

    float rTop = rf_rect(p, vec2(0.0, 0.0), vec2(logical.x, border), aa) * wh;
    if (rTop > 0.0) {
        vec4 c = rf_cell(vec4(0.0, 0.0, 1024.0, 104.0),
                         vec2(fract(p.x / 256.0), p.y / border));
        acc = rf_over(acc, rf_pm(c, rTop));
    }
    float rBottom = rf_rect(p, vec2(0.0, logical.y - border), vec2(logical.x, logical.y), aa) * wh;
    if (rBottom > 0.0) {
        vec4 c = rf_cell(vec4(0.0, 108.0, 1024.0, 104.0),
                         vec2(fract(p.x / 256.0),
                              (p.y - (logical.y - border)) / border));
        acc = rf_over(acc, rf_pm(c, rBottom));
    }
    float rLeft = rf_rect(p, vec2(0.0, 0.0), vec2(border, logical.y), aa) * wv;
    if (rLeft > 0.0) {
        vec4 c = rf_cell(vec4(0.0, 216.0, 104.0, 512.0),
                         vec2(p.x / border, fract(p.y / 128.0)));
        acc = rf_over(acc, rf_pm(c, rLeft));
    }
    float rRight = rf_rect(p, vec2(logical.x - border, 0.0), vec2(logical.x, logical.y), aa) * wv;
    if (rRight > 0.0) {
        vec4 c = rf_cell(vec4(108.0, 216.0, 104.0, 512.0),
                         vec2((p.x - (logical.x - border)) / border,
                              fract(p.y / 128.0)));
        acc = rf_over(acc, rf_pm(c, rRight));
    }

    // Four complete one-shot brass fittings over matching L-shaped wood.
    // The cap's inner arm ends cross-fade into whatever rail phase a given
    // window size presents: under a fixed 42 px cap a fixed atlas cell cannot
    // phase-match every window, so this is a bounded 2 logical px material
    // transition into the running rail, not a guaranteed native join. Only
    // that quiet wood fades; the brass hardware itself is never faded.
    // Uniform scaling preserves the authored hardware proportions.
    float cTL = rf_rect(p, vec2(0.0, 0.0), vec2(cap, cap), aa);
    if (cTL > 0.0) {
        vec4 c = rf_cell(vec4(224.0, 216.0, 168.0, 168.0), p / cap);
        float tip = smoothstep(0.0, 2.0, cap - p.x)
                  * smoothstep(0.0, 2.0, cap - p.y);
        acc = rf_over(acc, rf_pm(c, cTL * tip));
    }
    float cTR = rf_rect(p, vec2(logical.x - cap, 0.0), vec2(logical.x, cap), aa);
    if (cTR > 0.0) {
        vec2 lo = vec2(logical.x - cap, 0.0);
        vec4 c = rf_cell(vec4(396.0, 216.0, 168.0, 168.0), (p - lo) / cap);
        float tip = smoothstep(0.0, 2.0, p.x - lo.x)
                  * smoothstep(0.0, 2.0, cap - p.y);
        acc = rf_over(acc, rf_pm(c, cTR * tip));
    }
    float cBL = rf_rect(p, vec2(0.0, logical.y - cap), vec2(cap, logical.y), aa);
    if (cBL > 0.0) {
        vec2 lo = vec2(0.0, logical.y - cap);
        vec4 c = rf_cell(vec4(224.0, 388.0, 168.0, 168.0), (p - lo) / cap);
        float tip = smoothstep(0.0, 2.0, cap - p.x)
                  * smoothstep(0.0, 2.0, p.y - lo.y);
        acc = rf_over(acc, rf_pm(c, cBL * tip));
    }
    float cBR = rf_rect(p, vec2(logical.x - cap, logical.y - cap), vec2(logical.x, logical.y), aa);
    if (cBR > 0.0) {
        vec2 lo = vec2(logical.x - cap, logical.y - cap);
        vec4 c = rf_cell(vec4(396.0, 388.0, 168.0, 168.0), (p - lo) / cap);
        float tip = smoothstep(0.0, 2.0, p.x - lo.x)
                  * smoothstep(0.0, 2.0, p.y - lo.y);
        acc = rf_over(acc, rf_pm(c, cBR * tip));
    }

    // One complete lantern and attachment, on supporting material only.
    // The fixed 1:2 canvas stays isotropic and never enters the client opening.
    vec2 lampSize = vec2(border, border * 2.0) * fit;
    vec2 lampLo = vec2(logical.x - lampSize.x,
                       logical.y - border - lampSize.y);
    vec2 lampHi = lampLo + lampSize;
    float lampCoverage = rf_rect(p, lampLo, lampHi, aa);
    if (lampCoverage > 0.0) {
        vec4 c = rf_cell(vec4(568.0, 216.0, 104.0, 208.0),
                         (p - lampLo) / max(lampSize, vec2(0.001)));
        acc = rf_over(acc, rf_pm(c, lampCoverage));
    }

    // Modest focus trim on the painted chrome only: never a wash over content.
    float focus = clamp(focused, 0.0, 1.0);
    acc.rgb *= mix(0.80, 1.0, focus);

    // Native header UI. The captured source is the premultiplied full window
    // capture; inside the header band only, it is composited source-over the
    // painted rail so the real native controls and hover plates stay above the
    // wood. The client opening keeps its transparent early return, and no other
    // ring pixel samples the source.
    if (p.x >= border && p.x <= logical.x - border && p.y >= 0.0 && p.y < border) {
        acc = rf_over(acc, texture2D(tex, effect.texture_uv));
    }

    acc.a = clamp(acc.a, 0.0, 1.0);
    // Final boundary: convert the premultiplied accumulator to straight RGB
    // carrying the original alpha; the native display wrapper multiplies RGB
    // by alpha on the way to the screen.
    if (acc.a <= 0.0) {
        return vec4(0.0);
    }
    return vec4(acc.rgb / acc.a, acc.a);
}

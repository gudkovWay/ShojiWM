// Dot-Dark cursor trail: a short, tapered, connected stroke drawn behind the
// hardware cursor through an output overlay. The cursor itself is never drawn
// or replaced here.
//
// The TypeScript runtime publishes one fixed-size uniform array per effect
// frame; every slot is always present so the shader binding is structural and
// only the numbers change:
//
//   u_trail[0]      meta  : (logical_width, logical_height, output_scale, point_count)
//   u_trail[1]      bbox  : (min_x, min_y, max_x, max_y)
//   u_trail[2]      head  : (head_x, head_y, head_radius, 0)
//   u_trail[3 + i]  point : (x, y, radius, opacity), i = 0 is the live head
//
// Coordinates and radii are logical output-local pixels. The fragment arrives
// in physical texture pixels, so it is divided by the run's static output
// scale before any comparison. This shader reads no texture at all: the trail
// is procedural and the array is the entire input.
//
// The eight points already carry the resampled taper from the runtime, so this
// shader only measures each fragment against the seven segments between them.
// Overlapping joints keep the strongest coverage instead of summing, which
// avoids double-darkened knots. A thin charcoal outline wraps a pale fill, and
// a ~3px cutout around the live head leaves the hardware cursor's own dot and
// rim untouched. The bounding-box reject skips the rest of the output before
// any segment work.

// 8 points -> 7 segments -> 3 meta slots + 8 points.
#define DT_SEGMENTS 7
#define DT_SLOTS 11

uniform vec4 u_trail[DT_SLOTS];

const vec3 DT_FILL = vec3(0.7608, 0.7804, 0.8000); // #c2c7cc
const vec3 DT_EDGE = vec3(0.1059, 0.1137, 0.1255); // #1b1d20

vec4 shader_main(EffectContext effect) {
    float count = u_trail[0].w;
    vec4 bounds = u_trail[1];

    // Physical -> logical output-local, then the cheap full-output reject.
    vec2 frag = effect_content_px(effect) / max(u_trail[0].z, 0.000001);
    if (count < 1.5 ||
        frag.x < bounds.x || frag.y < bounds.y ||
        frag.x > bounds.z || frag.y > bounds.w) {
        return vec4(0.0);
    }

    float coverage = 0.0;
    vec3 color = DT_EDGE;

    for (int i = 0; i < DT_SEGMENTS; i++) {
        vec4 a = u_trail[3 + i];
        vec4 b = u_trail[4 + i];
        // Unused tail slots carry zero opacity; no dynamic loop bound is
        // needed (GLSL ES 1.00 wants a constant one anyway).
        float live = step(float(i) + 1.0, count);

        vec2 ab = b.xy - a.xy;
        float abLen2 = dot(ab, ab);
        // Resampling can emit coincident points; a zero denominator is legal
        // input and must not divide.
        float t = abLen2 > 0.000001
            ? clamp(dot(frag - a.xy, ab) / abLen2, 0.0, 1.0)
            : 0.0;
        vec2 closest = a.xy + ab * t;
        float d = length(frag - closest);

        float radius = mix(a.z, b.z, t);
        float opacity = mix(a.w, b.w, t) * live;
        if (opacity <= 0.0 || radius <= 0.0) {
            continue;
        }

        // 1px antialiased outer boundary; the fill stops about 1px inside it.
        float outer = 1.0 - smoothstep(radius - 0.5, radius + 0.5, d);
        float fill = 1.0 - smoothstep(radius - 1.5, radius - 0.5, d);
        float segment = outer * opacity;
        if (segment > coverage) {
            coverage = segment;
            color = mix(DT_EDGE, DT_FILL, fill);
        }
    }

    // Keep the live head's central dot free for the hardware cursor.
    float headDistance = length(frag - u_trail[2].xy);
    coverage *= smoothstep(u_trail[2].z - 0.8, u_trail[2].z + 0.6, headDistance);

    if (coverage < 0.004) {
        return vec4(0.0);
    }
    // The overlay uses `alpha: "preserve"`, which expects premultiplied output.
    return vec4(color * coverage, coverage);
}

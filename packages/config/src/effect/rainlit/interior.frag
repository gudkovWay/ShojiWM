// Rainlit Kitty interior: compiled by rainlit/runtime.ts as
// compileEffect({ input: backdropSource(), pipeline: [dualKawaseBlur, this
// stage] }) — `tex` is the blurred scene BEHIND the window, never the
// window's own captured glyphs. The effect never reads terminal text or
// palette; every modulation below is spatial + scalar only.
//
// Frozen semantics:
// - The ShaderEffect wraps only ClientWindow, so this effect's rect IS the
//   actual client opening. The runtime binds the real client size (root minus
//   the frame insets) and this shader evaluates its own full local rect via
//   `effect_content_uv`; it never rescales to the root or subtracts the root
//   insets again.
// - rainStrength scrolls sparse procedural streaks. The scroll uses an integer
//   number of cycles per pack period (`period_seconds`), so it is exactly
//   seam-continuous with the native clock wrap; `wind` only TILTS the
//   streak columns (never vary their rate/position speed). No GPU state.
// - lightAnchor/lightSpread/lightColor give the pack's local lamp footprint
//   inside the client, scaled by the shared authored `light` scalar and
//   already converted to client-local normalized coordinates by the runtime.
//   A pack whose `light` is authored ZERO (07/09) shows no footprint at all.
// - eyes are the three native min/max/close strengths. Each reflection sits
//   under its ACTUAL native button: `eye_centers` is the same per-role
//   min/max/close client-local x the native header lays out, `eye_center_y`
//   is the client top edge (a bounded peripheral glow), and `eye_radius`
//   follows the real doll footprint. Hues are role-specific and faint; no
//   global flash, no extra lamps.
// - coolness/edgeShade/shade are pack profile constants scaled by scalars.
// - The effect compiles with alpha "preserve": `tex` RGB is premultiplied.
//   Tints and multiplications act directly on that premultiplied RGB (never
//   unpremultiplied in between); every additive light/rain-lift/eye
//   contribution is scaled by src.a so it fades with the backdrop's own
//   coverage. Alpha is preserved untouched; a single unpremultiply
//   (rgb / src.a) happens at the return, with a zero output when alpha ~0.
//
// All parameters arrive bound once by the runtime from the selected pack;
// no per-frame recompilation, no texture loads, no IPC.

uniform vec2 logical_size;   // actual client opening logical width/height
uniform float focused;       // 0..1 smooth native focus
uniform float seconds;       // pack period clock, seconds (0..period_seconds)
uniform float period_seconds;// native loop period of the pack
uniform float wind;          // shared SIGNED wind scalar
uniform float light;         // authored local light scalar (≈0..1)
uniform float shade;         // authored interior shade scalar (≈0..1)
uniform vec3 eyes;           // min, max, close strengths 0..1
uniform float rain_strength; // pack interior.rainStrength
uniform float coolness;      // pack interior.coolness
uniform float edge_shade;    // pack interior.edgeShade
uniform vec2 light_anchor;   // CLIENT-LOCAL normalized, lamp center
uniform vec2 light_spread;   // CLIENT-LOCAL normalized, [radiusX, radiusY]
uniform vec3 light_color;    // linear lamp color
uniform vec3 eye_centers;    // CLIENT-LOCAL normalized x, min/max/close order
uniform float eye_center_y;  // CLIENT-LOCAL normalized y of the reflection line
uniform vec2 eye_radius;     // CLIENT-LOCAL normalized reflection [rx, ry]

float rl_hash(float n) {
    return fract(sin(n) * 43758.5453);
}

// Integer streaks cycles per pack period: keeps the scroll seam-continuous.
const float RL_RAIN_CYCLES = 4.0;

vec4 shader_main(EffectContext effect) {
    vec4 src = texture2D(tex, effect.texture_uv);
    vec3 rgb = src.rgb;
    // This effect's rect is the client opening, so content uv is exactly the
    // local normalized position; no root insets are applied here.
    vec2 uv = clamp(effect_content_uv(effect), 0.0, 1.0);
    vec2 logical = max(logical_size, vec2(1.0));

    // Cool interior tint: mild channel rebalance plus a small cool lift.
    rgb = mix(rgb, rgb * vec3(0.82, 0.94, 1.12), coolness * 0.5);
    rgb += vec3(0.0, 0.008, 0.028) * coolness * src.a;

    // Sparse procedural rain streaks: short bright segments in scattered
    // columns. The scroll advances by whole cycles per pack period, so the
    // native clock wrap is invisible; wind only slants the columns.
    if (rain_strength > 0.001) {
        float progress = clamp(seconds / max(period_seconds, 1.0), 0.0, 1.0);
        float xw = uv.x + wind * 0.035 * (1.0 - uv.y);
        float col = floor(xw * 96.0);
        float h = rl_hash(col * 127.1);
        float y = fract(uv.y * (0.5 + h) + progress * RL_RAIN_CYCLES + h * 0.37);
        float seg = smoothstep(0.0, 0.02, y) * smoothstep(0.10, 0.03, y);
        seg *= step(0.75, h); // sparse columns only
        rgb *= 1.0 + seg * 0.10 * rain_strength;
    }

    // Local lamp footprint: elliptical falloff in client-local normalized
    // space, already converted from the pack's logical object geometry. The
    // additive lift is scaled by src.a so it vanishes with backdrop coverage.
    if (light > 0.001) {
        vec2 d = (uv - light_anchor) / max(light_spread, vec2(0.0001));
        float fall = exp(-dot(d, d));
        rgb += light_color * fall * light * 0.04 * src.a;
    }

    // Native doll eye reflections (07): one faint localized warm point per
    // header button, ordered min/max/close and placed at the same client-local
    // x as the native row. The reflection line hugs the client top edge, so it
    // stays a bounded peripheral field.
    {
        vec2 inv = 1.0 / max(eye_radius, vec2(1e-4));
        vec2 d0 = (uv - vec2(eye_centers.x, eye_center_y)) * inv;
        vec2 d1 = (uv - vec2(eye_centers.y, eye_center_y)) * inv;
        vec2 d2 = (uv - vec2(eye_centers.z, eye_center_y)) * inv;
        float e0 = exp(-dot(d0, d0));
        float e1 = exp(-dot(d1, d1));
        float e2 = exp(-dot(d2, d2));
        // Faint bounded per-role glows (min/max/close hues preserved); each
        // additive contribution is scaled by src.a like the lamp lift.
        rgb += vec3(1.0, 0.85, 0.55) * e0 * clamp(eyes.x, 0.0, 1.0) * 0.035 * src.a;
        rgb += vec3(1.0, 0.72, 0.40) * e1 * clamp(eyes.y, 0.0, 1.0) * 0.035 * src.a;
        rgb += vec3(1.0, 0.60, 0.55) * e2 * clamp(eyes.z, 0.0, 1.0) * 0.04 * src.a;
    }

    // Client-edge shade: darkens a 24 logical px band inside the opening.
    float edge = min(
        min(uv.x * logical.x, (1.0 - uv.x) * logical.x),
        min(uv.y * logical.y, (1.0 - uv.y) * logical.y)
    );
    rgb *= 1.0 - edge_shade * (1.0 - smoothstep(0.0, 24.0, edge));

    // Global interior shade scalar.
    rgb *= 1.0 - 0.15 * clamp(shade, 0.0, 1.0);

    // Small focus lift on the interior only.
    rgb *= mix(0.96, 1.0, clamp(focused, 0.0, 1.0));

    // Single unpremultiply at the boundary: the compositor consumes
    // unpremultiplied RGB plus the preserved alpha. Alpha ~0 emits zero.
    if (src.a <= 1e-4) {
        return vec4(0.0);
    }
    return vec4(rgb / src.a, src.a);
}

#!/usr/bin/env python3
"""Author the design-faithful "02" rainlit frame variant.

Run from the repository root:

    python3 tools/build-rainlit-02.py

The build is self-contained: it reads ONLY the canonical, immutable production
copies under ``design-faithful/source/`` (checked up front) and never reads or
re-copies the ignored scratch directory.

This is the design-faithful rebuild of pack 02 requested by the owner: the
frame ring is 52 LOGICAL px of real painted timber on every side instead of the
legacy 26 px, the rails are neutral generated wood with no repeated hardware,
each corner carries its own one-shot joinery, and the crane and paper lamp come
from real ``gpt-image-2`` component masters instead of crops of the frozen
1536x1024 approved concept.

Inputs (production copies under ``design-faithful/source/``):

  wood-gpt-image-2.webp     1536x1024 RGB   painted timber sheet: 2 horizontal
                                            planks + 2 vertical posts
  corners-gpt-image-2.webp  1254x1254 RGBA  2x2 corner sheet with hardware
  crane-gpt-image-2.webp    1349x1166 RGBA  paper crane component master
  lamp-gpt-image-2.webp     1024x1536 RGBA  paper-lamp component master
  brass-gpt-image-2.webp    1536x1024 RGBA  brass plate/rivet master (native
                                            controls; copied here so the variant
                                            is self-contained, not consumed below)
  legacy/*.png                              the accepted bamboo roll/mat/ties,
                                            the fixed crane hook and the lamp
                                            wood glow, kept byte-identical
  generation-manifest.json                  the frozen generation record, kept
                                            for historic attribution

The agent-side generation inputs (`*-request.json`, `guidance-frozen.txt`) are
deliberately NOT shipped; the retained ``generation-manifest.json`` carries the
historic provenance instead.

Outputs live in ``packages/config/assets/rainlit-frames/02/design-faithful/``:

  frame-atlas.png     2048x2048 straight RGBA atlas, >= 2 px gutters
  layers/*.png        independent rail / corner / ornament cells
  source.json         provenance, measured cuts, cell map, layer geometry

plus the typed artwork module ``src/effect/rainlit/frame-02-art.ts`` and two
offline review images under ``.superpowers/assets/frame02-design-faithful/``
(clearly labelled NOT RUNTIME).

The 52 px ring doubles every ornament's LOGICAL geometry while the accepted
bamboo cells keep their authored pixels; one-shot components (corners, crane,
lamp) are packed at 4 atlas px per logical px and the rails at the 2 atlas px
per logical px the generated sheet actually provides, with the authored
512 logical horizontal / 256 logical vertical periods.

No renderer, geometry or runtime behaviour is verified by this script; it only
authors assets.  It is deterministic: identical inputs produce identical bytes.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parent.parent
PACK_DIR = REPO / "packages/config/assets/rainlit-frames/02"
OUT_DIR = PACK_DIR / "design-faithful"
SOURCE_DIR = OUT_DIR / "source"
LEGACY_SOURCE_DIR = SOURCE_DIR / "legacy"
ATLAS_NAME = "frame-atlas.png"
PROVENANCE_NAME = "source.json"
ART_TS = REPO / "packages/config/src/effect/rainlit/frame-02-art.ts"
GENERATED_DIR = REPO / ".superpowers/assets/frame02-design-faithful"
PREVIEW_PNG = GENERATED_DIR / "offline-frame02-design-faithful-preview.png"
COMPONENTS_PNG = GENERATED_DIR / "offline-frame02-design-faithful-components.png"

ATLAS_SIZE = 2048
GUTTER = 4                      # >= 2 px transparent gutters between cells
INSET = 52                      # logical ring on every side
CORNER_LOGICAL = 104            # one-shot corner canvas (two 52 px arms)
CORNER_PX = CORNER_LOGICAL * 4  # 4 atlas px per logical px
RAIL_PX_H = 1024                # 512 logical x 2 atlas px
RAIL_PX_V = 512                 # 256 logical x 2 atlas px
RAIL_CROSS_PX = 104             # 52 logical x 2 atlas px
RAIL_TRIM = 16                  # source px trimmed from each endcap bevel
RAIL_FADE = 96                  # cross-faded wrap band inside one rail period
STITCH_FADE = 32                # cross-fade where two posts are stitched
RAIL_PERIOD = {"horizontal": 512, "vertical": 256}
COMPONENT_PX = 4                # atlas px per logical px for one-shot components
ALPHA_CUT = 0.35 * 255.0        # alpha units are 0..255, not 0..1
APEX_MIN_PAPER_PX = 6           # bright paper px that mark the crane body's apex

LAMP_SCALE = 0.105              # logical px per source px (all lamp masks)
LAMP_ANCHOR_SRC = (542.0, 285.0)
LAMP_ANCHOR_BR = (30.0, -150.0)
CRANE_ATTACH_TR = (20.5, 58.0)
CRANE_TARGET_H = 64.0
CRANE_MAX_W = 80.0

#: fixed geometry handed down by the frozen spec; the bamboo group keeps its
#: accepted source cells and doubles every logical offset/size/pivot.
LAYER_FIXED = {
    "bamboo-slat": dict(anchor="tl", offset=(40.5, 18.5), size=(165.5, 26.0),
                        pivot=(82.75, 13.0), reveal="bambooReveal",
                        reveal_mode="slide", translate_y="bambooTranslateY"),
    "bamboo-roll": dict(anchor="tl", offset=(40.5, -15.5), size=(165.5, 34.0),
                        pivot=(82.75, 17.0), translate_y="bambooTranslateY"),
    "tie-near": dict(anchor="tl", offset=(61.0, -17.0), size=(19.0, 57.0),
                     pivot=(9.5, 2.0), angle="tiesAngle",
                     translate_y="bambooTranslateY"),
    "tie-far": dict(anchor="tl", offset=(165.0, -17.0), size=(19.0, 57.0),
                    pivot=(9.5, 2.0), angle="tiesAngle",
                    translate_y="bambooTranslateY"),
    "crane-hook": dict(anchor="tr", offset=(13.0, 36.0), size=(15.0, 22.0),
                       pivot=(7.5, 11.0)),
    "lamp-wood-glow": dict(anchor="br", offset=(-40.0, -158.0), size=(40.0, 115.0),
                           pivot=(20.0, 12.0), emission="lampEnergy"),
}
LEGACY_CELL_SOURCES = {
    "bamboo-slat": "slat.png",
    "bamboo-roll": "roll.png",
    "tie-near": "tie-a.png",
    "tie-far": "tie-b.png",
    "crane-hook": "crane-hook.png",
    "lamp-wood-glow": "lamp-wood-glow.png",
}
LAYER_ORDER = ["bamboo-slat", "bamboo-roll", "tie-near", "tie-far", "crane-hook",
               "crane", "lamp-bracket", "lamp", "lamp-paper", "lamp-wood-glow"]
ORDER = [
    "top-rail", "bottom-rail",
    "corner-tl", "corner-tr", "corner-bl", "corner-br",
    "left-rail", "right-rail",
    "crane", "lamp", "lamp-paper", "lamp-bracket",
    "bamboo-roll", "bamboo-slat", "tie-near", "tie-far",
    "crane-hook", "lamp-wood-glow",
]
SOURCE_FILES = ["wood", "corners", "crane", "lamp", "brass"]

#: the production inputs this builder reads. They are canonical and immutable:
#: the builder never reads or re-copies the ignored scratch directory.
REQUIRED_SOURCES = (
    [f"{kind}-gpt-image-2.webp" for kind in SOURCE_FILES]
    + ["generation-manifest.json"]
    + [f"legacy/{name}" for name in LEGACY_CELL_SOURCES.values()]
)


# ---------------------------------------------------------------------------
# generic helpers
# ---------------------------------------------------------------------------
def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_rgba(path: Path) -> np.ndarray:
    """Straight RGBA float array; RGB under alpha 0 may hold decoder garbage.

    The generated masters carry genuine near-opaque alpha with anti-aliased
    edges, so alpha is preserved exactly as authored and never re-keyed from
    RGB luminance or colour.
    """
    return np.asarray(Image.open(path).convert("RGBA")).astype(np.float32)


def to_image(arr: np.ndarray) -> Image.Image:
    """Straight RGBA image; RGB is zeroed exactly where alpha is zero."""
    out = np.round(np.clip(arr, 0.0, 255.0)).astype(np.uint8)
    out[out[..., 3] == 0] = 0
    return Image.fromarray(out, "RGBA")


def runs_1d(flags: np.ndarray) -> list[tuple[int, int]]:
    """Half-open [start, end) runs of a 1-D boolean flag vector."""
    idx = np.nonzero(np.diff(np.concatenate(([False], flags, [False])).astype(np.int8)))[0]
    return list(zip(idx[0::2].tolist(), idx[1::2].tolist()))


def close_mask(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(radius):
        nxt = out.copy()
        nxt[1:, :] |= out[:-1, :]
        nxt[:-1, :] |= out[1:, :]
        nxt[:, 1:] |= out[:, :-1]
        nxt[:, :-1] |= out[:, 1:]
        out = nxt
    for _ in range(radius):
        nxt = out.copy()
        nxt[1:, :] &= out[:-1, :]
        nxt[:-1, :] &= out[1:, :]
        nxt[:, 1:] &= out[:, :-1]
        nxt[:, :-1] &= out[:, 1:]
        out = nxt
    return out


def erode(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    out = mask.copy()
    for _ in range(radius):
        nxt = out.copy()
        nxt[1:, :] &= out[:-1, :]
        nxt[:-1, :] &= out[1:, :]
        nxt[:, 1:] &= out[:, :-1]
        nxt[:, :-1] &= out[:, 1:]
        out = nxt
    return out


def aa_alpha(mask: np.ndarray, blur: float = 0.7) -> np.ndarray:
    img = Image.fromarray((mask.astype(np.uint8) * 255))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(blur))).astype(np.float32) / 255.0


def label_components(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """4-connected run-length labelling; returns (resolved labels, roots).

    One Python iteration per image row over that row's runs with union-find, so
    multi-megapixel masks stay fast without SciPy.
    """
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    parent: list[int] = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    prev: list[tuple[int, int, int]] = []
    next_label = 1
    for y in range(h):
        row = mask[y].astype(np.int8)
        idx = np.nonzero(np.diff(np.concatenate(([0], row, [0]))))[0]
        cur: list[tuple[int, int, int]] = []
        pi = 0
        for s, e in zip(idx[0::2].tolist(), idx[1::2].tolist()):
            lab = 0
            while pi < len(prev) and prev[pi][1] <= s:
                pi += 1
            k = pi
            while k < len(prev) and prev[k][0] < e:
                if lab == 0:
                    lab = prev[k][2]
                else:
                    union(lab, prev[k][2])
                k += 1
            if lab == 0:
                lab = next_label
                parent.append(lab)
                next_label += 1
            cur.append((s, e, lab))
            labels[y, s:e] = lab
        prev = cur
    root = np.array([find(i) for i in range(next_label)], dtype=np.int32)
    return root[labels], root


def largest_component(mask: np.ndarray, min_area: int = 1) -> np.ndarray:
    labels, _ = label_components(mask)
    counts = np.bincount(np.asarray(labels, dtype=np.int64).ravel())
    if counts.size <= 1:
        return np.zeros_like(mask)
    counts[0] = 0
    if counts.max() < min_area:
        return np.zeros_like(mask)
    return labels == int(counts.argmax())


def fill_holes(mask: np.ndarray) -> np.ndarray:
    labels, _ = label_components(~mask)
    border = set(labels[0].tolist()) | set(labels[-1].tolist())
    border |= set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    outside = np.isin(labels, np.fromiter(border, dtype=np.int32))
    return mask | ~outside


def bbox_of(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if not xs.size:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def resize_premult(arr: np.ndarray, w: int, h: int) -> np.ndarray:
    """Resample straight RGBA to (w, h) in premultiplied alpha.

    Resampling straight RGBA bleeds the decoder's garbage RGB (and any dark
    matte) through partly transparent edges; premultiplying first keeps visible
    colour and alpha independent, then RGB is un-premultiplied and zeroed
    exactly where alpha is zero.
    """
    arr = np.asarray(arr, dtype=np.float32)
    a = arr[..., 3:4] / 255.0
    pm = np.concatenate([arr[..., :3] / 255.0 * a, a], axis=2) * 255.0
    out = np.empty((h, w, 4), dtype=np.float32)
    for c in range(4):
        ch = Image.fromarray(np.ascontiguousarray(pm[..., c]), mode="F")
        out[..., c] = np.asarray(ch.resize((w, h), Image.LANCZOS), dtype=np.float32)
    a2 = np.clip(out[..., 3:4] / 255.0, 0.0, 1.0)
    rgb = np.where(a2 > 1e-6, out[..., :3] / 255.0 / np.maximum(a2, 1e-6), 0.0)
    return np.concatenate([np.clip(rgb, 0.0, 1.0), a2], axis=2) * 255.0


def _sample_axis(src: np.ndarray, coords: np.ndarray, axis: int) -> np.ndarray:
    n = src.shape[axis]
    c = np.clip(coords, 0.0, float(n - 1))
    i0 = np.floor(c).astype(np.int64)
    i1 = np.minimum(i0 + 1, n - 1)
    f = (c - i0).astype(np.float32)
    if axis == 1:
        return src[:, i0] * (1 - f)[None, :, None] + src[:, i1] * f[None, :, None]
    return src[i0] * (1 - f)[:, None, None] + src[i1] * f[:, None, None]


def warp_separable(arr: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Premultiplied separable warp of straight RGBA to (len(ys), len(xs), 4)."""
    arr = np.asarray(arr, dtype=np.float32)
    a = arr[..., 3:4] / 255.0
    pm = np.concatenate([arr[..., :3] / 255.0 * a, a], axis=2) * 255.0
    out = _sample_axis(_sample_axis(pm, xs, 1), ys, 0)
    a2 = np.clip(out[..., 3:4] / 255.0, 0.0, 1.0)
    rgb = np.where(a2 > 1e-6, out[..., :3] / 255.0 / np.maximum(a2, 1e-6), 0.0)
    return np.concatenate([np.clip(rgb, 0.0, 1.0), a2], axis=2) * 255.0


def piecewise_axis(n_src: int, inner_src: int, n_out: int) -> np.ndarray:
    """Monotone piecewise map: [0, inner] -> [0, half], [inner, n] -> [half, out]."""
    half = n_out // 2
    inner_src = int(np.clip(inner_src, 1, n_src - 1))
    xs = np.arange(n_out, dtype=np.float64)
    lo = xs <= half
    coords = np.empty(n_out, dtype=np.float64)
    coords[lo] = xs[lo] * (inner_src / half)
    coords[~lo] = inner_src + (xs[~lo] - half) * ((n_src - inner_src) / (n_out - half))
    return coords


def crossfade_ends(arr: np.ndarray, axis: int, band: int) -> np.ndarray:
    """Cross-fade one end of a tileable cell into the other (neutral material)."""
    a = arr.astype(np.float32).copy()
    n = a.shape[axis]
    band = min(band, n // 4)
    if band < 2:
        return arr
    for i in range(band):
        t = i / band
        if axis == 1:
            a[:, i] = (1 - t) * a[:, n - band + i] + t * a[:, i]
        else:
            a[i, :] = (1 - t) * a[n - band + i, :] + t * a[i, :]
    return a


def stitch_spans(images: list[np.ndarray], need: int, fade: int) -> np.ndarray:
    """Concatenate independent neutral spans, cross-fading each junction.

    Two generated posts of the same sheet supply 890 bevel-free rows together;
    stitching them keeps the vertical rail period at the real 2 atlas px per
    logical px instead of upscaling one post's 445 rows to a fake 512.
    """
    out = images[0]
    for nxt in images[1:]:
        if out.shape[0] >= need:
            break
        f = min(fade, out.shape[0], nxt.shape[0])
        ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)[:, None, None]
        joined = out[-f:] * (1 - ramp) + nxt[:f] * ramp
        out = np.concatenate([out[:-f], joined, nxt[f:]], axis=0)
    return out[:need]


# ---------------------------------------------------------------------------
# wood sheet -> neutral rails
# ---------------------------------------------------------------------------
def measure_wood(rgb: np.ndarray) -> dict:
    """Locate the sheet's 2 horizontal planks and 2 vertical posts by occlusion."""
    h, w, _ = rgb.shape
    bg = np.median(rgb[0:60].reshape(-1, 3), axis=0)
    occ = close_mask(np.linalg.norm(rgb - bg, axis=2) > 14.0, 1)

    strips = [r for r in runs_1d(occ[: h // 2].mean(axis=1) > 0.02) if r[1] - r[0] > 60]
    posts = [c for c in runs_1d(occ[h // 2:].mean(axis=0) > 0.02) if c[1] - c[0] > 60]
    if len(strips) < 2 or len(posts) < 2:
        raise SystemExit(f"wood sheet layout not recognised: strips={strips} posts={posts}")

    strip_span, post_span = [], []
    for y0, y1 in strips[:2]:
        xs = np.nonzero(occ[y0:y1].mean(axis=0) > 0.5)[0]
        strip_span.append((int(xs.min()), int(xs.max()) + 1))
    # the posts sit under the planks, so their own row extent is measured only
    # below the last plank: the plank rows would otherwise span the posts'
    # columns too and stitch background into the vertical rail
    lower_start = strips[1][1] + 10
    for x0, x1 in posts[:2]:
        ys = np.nonzero(occ[lower_start:, x0:x1].mean(axis=1) > 0.3)[0]
        post_span.append((int(ys.min()) + lower_start, int(ys.max()) + 1 + lower_start))
    return {
        "sheet_size": [int(w), int(h)],
        "background_rgb": [round(float(v), 1) for v in bg],
        "occlusion_threshold": 14.0,
        "horizontal_strips": [
            {"rows": list(strips[i][:2]), "cols": list(strip_span[i]),
             "size": [strip_span[i][1] - strip_span[i][0], strips[i][1] - strips[i][0]]}
            for i in range(2)
        ],
        "vertical_posts": [
            {"cols": list(posts[i][:2]), "rows": list(post_span[i]),
             "size": [posts[i][1] - posts[i][0], post_span[i][1] - post_span[i][0]]}
            for i in range(2)
        ],
    }


def _neutral_long_span(lo: int, hi: int, need: int) -> tuple[int, int]:
    """Trim both endcap bevels, never inventing material beyond the sheet."""
    lo, hi = lo + RAIL_TRIM, hi - RAIL_TRIM
    if hi - lo <= need:
        return lo, hi
    centre = (lo + hi) // 2
    return centre - need // 2, centre - need // 2 + need


def build_horizontal_rail(rgb: np.ndarray, wood: dict, side: str) -> np.ndarray:
    strip = wood["horizontal_strips"][0 if side == "top" else 1]
    y0, y1 = strip["rows"]
    x0, x1 = _neutral_long_span(strip["cols"][0], strip["cols"][1], RAIL_PX_H)
    slab = rgb[y0:y1, x0:x1]
    cell = resize_premult(np.dstack([slab, np.full(slab.shape[:2], 255.0, dtype=np.float32)]),
                          RAIL_PX_H, RAIL_CROSS_PX)
    if side == "bottom":
        # the shader's cell row 0 is this rail's INNER edge, so mirror the
        # cross-section to keep the painted outer edge facing outward
        cell = cell[::-1]
    return crossfade_ends(cell, 1, RAIL_FADE)


def build_vertical_rail(wood: dict, rgb: np.ndarray, side: str) -> np.ndarray:
    spans = []
    for post in wood["vertical_posts"]:
        x0, x1 = post["cols"]
        y0, y1 = _neutral_long_span(post["rows"][0], post["rows"][1], 10_000)
        spans.append(rgb[y0:y1, x0:x1])
    order = [0, 1] if side == "left" else [1, 0]
    slab = stitch_spans([spans[i] for i in order], RAIL_PX_V, STITCH_FADE)
    cell = resize_premult(np.dstack([slab, np.full(slab.shape[:2], 255.0, dtype=np.float32)]),
                          RAIL_CROSS_PX, RAIL_PX_V)
    if side == "right":
        cell = cell[:, ::-1]
    return crossfade_ends(cell, 0, RAIL_FADE)


def rail_cross_profile(cell: np.ndarray, side: str) -> np.ndarray:
    return cell.mean(axis=1 if side in ("top", "bottom") else 0)   # (104, 4)


def match_rail_profile(cell: np.ndarray, target: np.ndarray,
                       side: str) -> tuple[np.ndarray, np.ndarray]:
    """Bounded cross-section tone match of a rail cell to a corner arm profile.

    The rail keeps its own generated material and grain; only the cross-section
    tone is nudged toward the one-shot corner arm it abuts, with the per-row
    gain smoothed along the cross-section and clamped to [0.85, 1.18], so the
    join shows no hard tonal step without repainting the wood and without an
    opaque plate or matte hiding it.
    """
    axis = 1 if side in ("top", "bottom") else 0
    prof = rail_cross_profile(cell, side)
    lum = lambda c: 0.2126 * c[:, 0] + 0.7152 * c[:, 1] + 0.0722 * c[:, 2]

    def smooth(v: np.ndarray, radius: int = 3) -> np.ndarray:
        k = np.ones(2 * radius + 1) / (2 * radius + 1)
        padded = np.concatenate([v[:radius][::-1], v, v[-radius:][::-1]])
        return np.convolve(padded, k, mode="valid")

    gain = np.clip(smooth(lum(target)) / np.maximum(smooth(lum(prof)), 1.0),
                   0.85, 1.18).astype(np.float32)
    out = cell.copy()
    scale = gain[:, None, None] if axis == 1 else gain[None, :, None]
    out[..., :3] = np.clip(out[..., :3] * scale, 0, 255)
    return out, gain


# ---------------------------------------------------------------------------
# corner sheet -> one-shot corner cells
# ---------------------------------------------------------------------------
def _empty_band(empty: np.ndarray, centre: int) -> tuple[int, int]:
    i = centre
    while i > 0 and empty[i]:
        i -= 1
    lo = i + 1
    i = centre
    while i < len(empty) - 1 and empty[i]:
        i += 1
    return lo, i


def measure_corners(rgba: np.ndarray) -> tuple[dict, dict]:
    """Split the 2x2 corner sheet and measure one piece per corner."""
    mask = rgba[..., 3] > 32
    h, w = mask.shape
    rlo, rhi = _empty_band(mask.mean(axis=1) == 0, h // 2)
    clo, chi = _empty_band(mask.mean(axis=0) == 0, w // 2)
    quadrants = {
        "tl": (slice(0, rlo), slice(0, clo)),
        "tr": (slice(0, rlo), slice(chi, w)),
        "bl": (slice(rhi, h), slice(0, clo)),
        "br": (slice(rhi, h), slice(chi, w)),
    }
    pieces, metrics = {}, {}
    for key, (sy, sx) in quadrants.items():
        bb = bbox_of(mask[sy, sx])
        if bb is None:
            raise SystemExit(f"corner sheet quadrant {key} is empty")
        x0, y0, x1, y1 = bb
        piece = rgba[sy.start + y0:sy.start + y1, sx.start + x0:sx.start + x1].copy()
        metrics[key] = {"sheet_rect": [sx.start + x0, sy.start + y0,
                                       sx.start + x1, sy.start + y1]}
        if key in ("tr", "br"):          # canonical: outer corner at top-left
            piece = piece[:, ::-1]
        if key in ("bl", "br"):
            piece = piece[::-1]
        pm = piece[..., 3] > 32
        rowcov, colcov = pm.mean(axis=1), pm.mean(axis=0)
        rows = np.nonzero(rowcov >= 0.6)[0]
        cols = np.nonzero(colcov >= 0.6)[0]
        if not rows.size or not cols.size:
            raise SystemExit(f"corner {key}: arms not measurable")
        r0, c0 = int(rows.min()), int(cols.min())
        work = piece[r0:, c0:]
        metrics[key].update({
            "piece_size": [int(work.shape[1]), int(work.shape[0])],
            "arm_leg_width_src": int(np.count_nonzero(colcov[c0:] >= 0.6)),
            "arm_beam_thickness_src": int(np.count_nonzero(rowcov[r0:] >= 0.6)),
            "arm_length_src": [int(work.shape[1]), int(work.shape[0])],
        })
        pieces[key] = work
    return pieces, metrics


def canonical_corner(cell: np.ndarray, key: str) -> np.ndarray:
    """Outer corner at the top-left, so cross-sections always run 0..half."""
    if key in ("tr", "br"):
        cell = cell[:, ::-1]
    if key in ("bl", "br"):
        cell = cell[::-1]
    return cell


def build_corner_cells(pieces: dict, metrics: dict) -> dict:
    """Normalise each measured corner piece to a 104x104 logical cell.

    The inner arm turn is pinned to exactly (52, 52) logical and the arms fill
    the 104 px canvas, so the piecewise map's two scales differ only by the
    piece's own arm asymmetry (bounded anisotropy, recorded per corner).
    """
    cells = {}
    for key, work in pieces.items():
        h_src, w_src = work.shape[:2]
        leg_w = metrics[key]["arm_leg_width_src"]
        beam_t = metrics[key]["arm_beam_thickness_src"]
        coords = (piecewise_axis(w_src, leg_w, CORNER_PX),
                  piecewise_axis(h_src, beam_t, CORNER_PX))
        cell = warp_separable(work, *coords)
        # the shader samples every corner cell with corner-local (0,0), so each
        # piece is stored with its outer corner on its own cell corner again
        if key in ("tr", "br"):
            cell = cell[:, ::-1]
        if key in ("bl", "br"):
            cell = cell[::-1]
        metrics[key]["anisotropy"] = round(beam_t / leg_w, 4)
        metrics[key]["arm_leg_width_logical"] = round(CORNER_LOGICAL / 2 * 1.0, 3)
        metrics[key]["arm_beam_thickness_logical"] = round(CORNER_LOGICAL / 2 * 1.0, 3)
        cells[f"corner-{key}"] = cell
    return cells


def corner_arm_profiles(cells: dict) -> tuple[np.ndarray, np.ndarray]:
    """Mean cross-section of the four corner arms at the rail's cross resolution.

    The corner cells hold 4 atlas px per logical px and the rails 2, so the
    measured arm profile (208 px per 52 logical px) is mean-pooled by two to
    the rail's own 104 px cross-section before it is used as the match target.
    """
    half = CORNER_PX // 2
    band = slice(int(half * 1.35), int(half * 1.9))
    horiz, vert = [], []
    for key in ("tl", "tr", "bl", "br"):
        cell = canonical_corner(cells[f"corner-{key}"], key)
        horiz.append(cell[:, band].mean(axis=1)[:half])
        vert.append(cell[band, :].mean(axis=0)[:half])
    pool = (RAIL_CROSS_PX, half // RAIL_CROSS_PX)
    return (np.stack(horiz).mean(axis=0).reshape(pool[0], pool[1], 4).mean(axis=1),
            np.stack(vert).mean(axis=0).reshape(pool[0], pool[1], 4).mean(axis=1))


# ---------------------------------------------------------------------------
# crane master -> moving body cell
# ---------------------------------------------------------------------------
def measure_crane(rgba: np.ndarray) -> dict:
    """Isolate the paper body: cut the upper cord, keep the largest component."""
    al = rgba[..., 3]
    r, g, b = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    solid = al > ALPHA_CUT
    red = (r > 85) & (r > g * 1.35) & (r > b * 1.3) & solid
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    paper = solid & ~red & (lum > 100.0)
    apex_rows = np.nonzero(paper.sum(axis=1) >= APEX_MIN_PAPER_PX)[0]
    if not apex_rows.size:
        raise SystemExit("crane: no paper body found")
    apex_y = int(apex_rows.min())

    below = np.zeros_like(solid)
    below[apex_y:] = True
    body = largest_component(solid & below, min_area=200)
    bb = bbox_of(body)
    if bb is None:
        raise SystemExit("crane: empty body")
    x0, y0, x1, y1 = bb
    top = np.nonzero(body.any(axis=1))[0][:8]
    apex_x = float(np.mean([np.nonzero(body[y])[0].mean() for y in top]))
    cord_bb = bbox_of(largest_component(red))
    return {
        "source_size": [int(rgba.shape[1]), int(rgba.shape[0])],
        "alpha_threshold": f"alpha > {ALPHA_CUT:.0f} of 255",
        "red_cord_test": f"r > 85, r > 1.35g, r > 1.3b, alpha > {ALPHA_CUT:.0f}",
        "upper_cord_rect": list(cord_bb) if cord_bb else None,
        "apex": [round(apex_x, 1), apex_y],
        "body_rect": [x0, y0, x1, y1],
        "body_size": [x1 - x0, y1 - y0],
        "cut": f"every source row above the measured apex y={apex_y} (the upper cord and its fringe) leaves the moving body",
        "retained": ("the whole paper body below the apex: full wings, crease and dark folds, "
                     "plus the red attachment strand that runs down the cone's right edge"),
        "_mask": body,
        "_alpha": al,
        "_apex": (apex_x, apex_y),
    }


def build_crane_cell(rgba: np.ndarray, crane: dict) -> tuple[np.ndarray, dict]:
    x0, y0, x1, y1 = crane["body_rect"]
    src_w, src_h = x1 - x0, y1 - y0
    scale = min(CRANE_TARGET_H / src_h, CRANE_MAX_W / src_w)
    logical = (src_w * scale, src_h * scale)
    cell_w = max(1, int(round(logical[0] * COMPONENT_PX)))
    cell_h = max(1, int(round(logical[1] * COMPONENT_PX)))
    sub = rgba[y0:y1, x0:x1]
    body = crane["_mask"][y0:y1, x0:x1]
    out = np.zeros((src_h, src_w, 4), dtype=np.float32)
    out[..., :3] = sub[..., :3]
    out[..., 3] = np.where(body, sub[..., 3], 0.0)
    cell = resize_premult(out, cell_w, cell_h)

    apex_x, apex_y = crane["_apex"]
    pivot = ((apex_x - x0) * scale, (apex_y - y0) * scale)
    geo = {
        "anchor": "tr",
        "size": [round(logical[0], 3), round(logical[1], 3)],
        "pivot": [round(pivot[0], 3), round(pivot[1], 3)],
        "offset": [round(CRANE_ATTACH_TR[0] - pivot[0], 3),
                   round(CRANE_ATTACH_TR[1] - pivot[1], 3)],
        "angle": "craneAngle",
        "scale_logical_per_source_px": round(scale, 6),
        "cell": [cell_w, cell_h],
        "rotation_extent_tr": {
            "left": round(CRANE_ATTACH_TR[0] - pivot[0], 3),
            "right": round(CRANE_ATTACH_TR[0] - pivot[0] + logical[0], 3),
            "bottom": round(CRANE_ATTACH_TR[1] - pivot[1] + logical[1], 3),
            "note": "measured at rest; the +/-0.032 rad craneAngle sweep stays inside the 68 px right outset",
        },
    }
    return cell, geo


# ---------------------------------------------------------------------------
# lamp master -> static bracket + moving lamp + paper emission
# ---------------------------------------------------------------------------
def measure_lamp(rgba: np.ndarray) -> dict:
    """Partition the lamp master at the measured link root, by connectivity."""
    al = rgba[..., 3]
    solid = fill_holes(close_mask(al > ALPHA_CUT, 1))
    h, w = solid.shape
    occ_rows = solid.any(axis=1)
    top_rows = np.nonzero(occ_rows)[0]
    if not top_rows.size:
        raise SystemExit("lamp: empty alpha")
    arm_y = int(top_rows.min())
    arm_probe = int(next(y for y in range(arm_y, h) if occ_rows[y]))
    arm_w = 0.0
    for y in range(arm_y, arm_y + 30):
        row = np.nonzero(solid[y])[0]
        if row.size:
            arm_w = max(arm_w, float(row.max() - row.min() + 1))
    # the bracket's horizontal arm is one run per row; the wall leg and the
    # hanging link are the two runs that appear underneath it
    arm_bottom = None
    for y in range(arm_y + 20, h):
        if len(runs_1d(solid[y])) >= 2:
            arm_bottom = y
            break
    if arm_bottom is None:
        raise SystemExit("lamp: bracket arm not found")

    probe = np.nonzero(solid[arm_bottom + 30])[0]
    if not probe.size:
        raise SystemExit("lamp: nothing hangs below the bracket arm")
    runs = runs_1d(np.isin(np.arange(w), probe))
    hook_lo, hook_hi = runs[-1]           # the hook/link is the rightmost structure

    cut = None
    for y in range(arm_bottom, min(arm_bottom + 260, h)):
        row = np.nonzero(solid[y, max(hook_lo - 10, 0):hook_hi + 11])[0]
        if row.size and (row.max() - row.min() + 1) > (hook_hi - hook_lo + 1) + 6:
            cut = y - 1
            break
    if cut is None:
        raise SystemExit("lamp: link root not found")

    band = np.zeros_like(solid)
    band[cut:cut + 3, max(hook_lo - 2, 0):] = True
    parts = solid & ~band
    labels, _ = label_components(parts)
    seed_row = np.nonzero(parts[arm_probe])[0]
    arm_seed = labels[arm_probe, int(seed_row.mean())]
    below = labels[cut + 4:]
    below = below[below > 0]
    if below.size == 0:
        raise SystemExit("lamp: no lower structure below the link root")
    vals, counts = np.unique(below, return_counts=True)
    moving_label = int(vals[counts.argmax()])
    if arm_seed == 0 or moving_label == 0 or arm_seed == moving_label:
        raise SystemExit(f"lamp: {cut} did not separate the hook from the arch")
    static = fill_holes(labels == arm_seed)
    moving = fill_holes(labels == moving_label)

    lum = 0.2126 * rgba[..., 0] + 0.7152 * rgba[..., 1] + 0.0722 * rgba[..., 2]
    warm = (rgba[..., 0] >= rgba[..., 2] - 12) & (rgba[..., 1] >= rgba[..., 2] - 20)
    paper = largest_component(fill_holes(close_mask(moving & (lum > 110) & warm, 2)),
                              min_area=256)
    paper = erode(paper, 1)

    return {
        "source_size": [int(w), int(h)],
        "alpha_threshold": f"alpha > {ALPHA_CUT:.0f} of 255",
        "bracket_arm_rows": [arm_y, arm_bottom],
        "bracket_arm_width_px": round(arm_w, 1),
        "link_root_row": cut,
        "static_rect": list(bbox_of(static)),
        "moving_rect": list(bbox_of(moving)),
        "paper_rect": list(bbox_of(paper)),
        "alpha_partition": (
            f"a three-row band at y={cut} over the upper link's own columns is removed, which "
            "disconnects the lower arch from the hook; each side is then the connected component "
            "seeded in the wood arm (static bracket: wall arm, support leg and upper link) and in "
            "the shade (moving lamp: lower arch, caps, paper and peg). That mask is hole-filled "
            "only to seed the components and to bound each cell: every cell's alpha is the "
            "master's AUTHORED alpha multiplied by its own partition coverage, so the link's "
            "genuine inner opening and the anti-aliased edges stay as transparent as the master "
            "authored them and no pixel is drawn by both parts. No luminance key and no opaque "
            "patch anywhere."
        ),
        "paper_test": ("moving coverage with luminance > 110 and a warm (r >= b) hue, hole-filled "
                       "and eroded 1 px; dark recesses are never keyed out by luminance and the "
                       "lamp layer keeps its full authored alpha"),
        "_alpha": al,
        "_static": static,
        "_moving": moving,
        "_paper": paper,
    }


def _lamp_geo(rect: tuple[int, int, int, int]) -> dict:
    x0, y0, x1, y1 = rect
    return {
        "anchor": "br",
        "offset": [round(LAMP_ANCHOR_BR[0] + (x0 - LAMP_ANCHOR_SRC[0]) * LAMP_SCALE, 3),
                   round(LAMP_ANCHOR_BR[1] + (y0 - LAMP_ANCHOR_SRC[1]) * LAMP_SCALE, 3)],
        "size": [round((x1 - x0) * LAMP_SCALE, 3), round((y1 - y0) * LAMP_SCALE, 3)],
        "pivot": [round((LAMP_ANCHOR_SRC[0] - x0) * LAMP_SCALE, 3),
                  round((LAMP_ANCHOR_SRC[1] - y0) * LAMP_SCALE, 3)],
        "cell": [max(1, int(round((x1 - x0) * LAMP_SCALE * COMPONENT_PX))),
                 max(1, int(round((y1 - y0) * LAMP_SCALE * COMPONENT_PX)))],
        "cell_px_per_logical": round(COMPONENT_PX, 3),
    }


def build_lamp_cells(rgba: np.ndarray, lamp: dict) -> tuple[dict, dict]:
    cells, geo = {}, {}

    def masked(rect: tuple[int, int, int, int], cover: np.ndarray,
               paper: np.ndarray | None = None) -> np.ndarray:
        """Cell RGBA from the master's own pixels and its own alpha.

        The cell alpha is the master's AUTHORED alpha multiplied by the
        measured partition coverage (and, for the emissive overlay, by the
        paper weight). Hole-filling is used only to seed the partition and to
        bound each cell, so a genuine transparent opening -- the hanging
        link's inner hole, any gap enclosed by the shade -- never becomes an
        opaque patch carrying the decoder's RGB, and no luminance key is used:
        where the master authored alpha 0 the cell stays transparent and
        `to_image` zeroes that RGB.
        """
        x0, y0, x1, y1 = rect
        sub = rgba[y0:y1, x0:x1]
        a = sub[..., 3] / 255.0 * cover[y0:y1, x0:x1].astype(np.float32)
        if paper is not None:
            a = a * paper[y0:y1, x0:x1]
        out = np.zeros((y1 - y0, x1 - x0, 4), dtype=np.float32)
        out[..., :3] = sub[..., :3]
        out[..., 3] = np.clip(a, 0.0, 1.0) * 255.0
        return out

    static_rect = tuple(lamp["static_rect"])
    moving_rect = tuple(lamp["moving_rect"])

    g = _lamp_geo(static_rect)
    geo["lamp-bracket"] = dict(g)
    cells["lamp-bracket"] = resize_premult(
        masked(static_rect, lamp["_static"]), g["cell"][0], g["cell"][1])

    g = _lamp_geo(moving_rect)
    geo["lamp"] = dict(g)
    geo["lamp"]["angle"] = "lampAngle"
    cells["lamp"] = resize_premult(
        masked(moving_rect, lamp["_moving"]), g["cell"][0], g["cell"][1])

    geo["lamp-paper"] = dict(g)
    geo["lamp-paper"]["angle"] = "lampAngle"
    geo["lamp-paper"]["emission"] = "lampEnergy"
    paper_a = aa_alpha(lamp["_paper"], 0.8)
    cells["lamp-paper"] = resize_premult(
        masked(moving_rect, lamp["_moving"], paper=paper_a), g["cell"][0], g["cell"][1])

    ys, xs = np.nonzero(lamp["_paper"])
    cx, cy = float(xs.mean()), float(ys.mean())
    px0, py0, px1, py1 = lamp["paper_rect"]
    centre = (LAMP_ANCHOR_BR[0] + (cx - LAMP_ANCHOR_SRC[0]) * LAMP_SCALE,
              LAMP_ANCHOR_BR[1] + (cy - LAMP_ANCHOR_SRC[1]) * LAMP_SCALE)
    half_w = (px1 - px0) / 2.0 * LAMP_SCALE
    half_h = (py1 - py0) / 2.0 * LAMP_SCALE
    light = {
        "anchor": "br",
        "offset": [round(centre[0], 1), round(centre[1], 1)],
        "spread": [round(max(3.9 * half_w, 2.2 * INSET), 1),
                   round(max(1.9 * half_h, 1.7 * INSET), 1)],
        "derivation": (
            "measured paper centroid in logical root coordinates "
            f"({cx:.0f},{cy:.0f}) source -> BR+({centre[0]:.1f},{centre[1]:.1f}); bounded spill = "
            f"max(3.9 x measured paper half-width {half_w:.1f}, 2.2 insets) by "
            f"max(1.9 x measured paper half-height {half_h:.1f}, 1.7 insets), so the exp(-d^2) "
            "falloff crosses the 52 px ring and reaches about one inset into the client"
        ),
        "paper_rect_source": list(lamp["paper_rect"]),
        "paper_half_extent_logical": [round(half_w, 2), round(half_h, 2)],
    }
    return cells, {"geometry": geo, "lightPlacement": light}


# ---------------------------------------------------------------------------
# legacy accepted cells
# ---------------------------------------------------------------------------
def legacy_cells() -> dict:
    """The accepted bamboo/hook/glow cells, read from the production copies."""
    return {layer_id: load_rgba(LEGACY_SOURCE_DIR / name)
            for layer_id, name in LEGACY_CELL_SOURCES.items()}


def build_checks(cells: dict, corner_cells: dict, crane: dict, lamp: dict) -> dict:
    """Numeric checks on the artefacts that were just authored."""
    out: dict = {}
    half = CORNER_PX // 2
    for key in ("tl", "tr", "bl", "br"):
        cell = corner_cells[f"corner-{key}"]
        can = canonical_corner(cell, key)
        a = cell[..., 3] > 32
        out[f"corner-{key}"] = {
            "alpha_bbox": list(bbox_of(a)),
            "coverage": round(float(a.mean()), 4),
            "beam_band_fill": round(float((can[:half, half:, 3] > 32).mean()), 4),
            "leg_band_fill": round(float((can[half:, :half, 3] > 32).mean()), 4),
            "inner_quadrant_fill": round(float((can[half:, half:, 3] > 32).mean()), 4),
            "inner_turn_px": [half, half],
        }
    for name in ("top-rail", "bottom-rail", "left-rail", "right-rail"):
        a = cells[name][..., 3]
        out[name] = {"size": [int(cells[name].shape[1]), int(cells[name].shape[0])],
                     "alpha_min": int(a.min()), "alpha_max": int(a.max())}
    crane_a = cells["crane"][..., 3]
    out["crane"] = {
        "size": [int(cells["crane"].shape[1]), int(cells["crane"].shape[0])],
        "coverage": round(float((crane_a > 127).mean()), 4),
        "touches_bbox": list(bbox_of(crane_a > 32)),
        "apex_px": crane["apex"],
        "cord_removed": crane["upper_cord_rect"],
    }
    out["lamp"] = {
        "static_moving_overlap_px": int((lamp["_static"] & lamp["_moving"]).sum()),
        "static_moving_union_matches_solid": bool(
            np.array_equal(lamp["_static"] | lamp["_moving"],
                           fill_holes(close_mask(lamp["_static"] | lamp["_moving"], 0)))),
        "static_rect": list(bbox_of(lamp["_static"])),
        "moving_rect": list(bbox_of(lamp["_moving"])),
        "paper_rect": list(bbox_of(lamp["_paper"])),
    }
    for layer_id in LAYER_ORDER:
        a = cells[layer_id][..., 3]
        out[f"layer:{layer_id}"] = {
            "size": [int(cells[layer_id].shape[1]), int(cells[layer_id].shape[0])],
            "alpha_coverage": round(float((a > 8).mean()), 4),
        }
    # genuine transparent openings inside a part's connectivity hull must stay
    # transparent: the cell alpha is authored alpha x partition coverage
    out["lamp"]["authored_transparent_px_inside_bracket_hull"] = int(
        (lamp["_static"] & (lamp["_alpha"] <= ALPHA_CUT)).sum())
    out["lamp"]["authored_transparent_px_inside_moving_hull"] = int(
        (lamp["_moving"] & (lamp["_alpha"] <= ALPHA_CUT)).sum())
    out["crane"]["authored_transparent_px_inside_body_mask"] = int(
        (crane["_mask"] & (crane["_alpha"] <= ALPHA_CUT)).sum())
    return out


# ---------------------------------------------------------------------------
# packing + writing
# ---------------------------------------------------------------------------
def pack_cells(cells: dict) -> tuple[Image.Image, dict]:
    atlas = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
    rects: dict[str, list[int]] = {}
    x = y = GUTTER
    shelf_h = 0
    for name in ORDER:
        img = to_image(cells[name])
        w, h = img.size
        if x + w + GUTTER > ATLAS_SIZE:
            x = GUTTER
            y += shelf_h + GUTTER
            shelf_h = 0
        if y + h + GUTTER > ATLAS_SIZE:
            raise SystemExit(f"atlas overflow while packing {name}")
        atlas.alpha_composite(img, (x, y))
        rects[name] = [x, y, w, h]
        x += w + GUTTER
        shelf_h = max(shelf_h, h)
    return atlas, rects


def require_sources() -> None:
    """Fail loudly unless every production input copy is present.

    The canonical inputs live under `design-faithful/source/`; nothing in the
    ignored scratch directory is read or re-copied by a build.
    """
    missing = [name for name in REQUIRED_SOURCES if not (SOURCE_DIR / name).is_file()]
    if missing:
        raise SystemExit("missing production source copies under "
                         f"{SOURCE_DIR.relative_to(REPO)}: {', '.join(missing)}")


def production_manifest() -> dict:
    """Hash the production inputs that the build actually consumed."""
    return {
        str(path.relative_to(SOURCE_DIR)): {"sha256": sha256_file(path),
                                            "bytes": path.stat().st_size}
        for path in sorted(SOURCE_DIR.rglob("*")) if path.is_file()
    }


def write_art_ts(art: dict) -> None:
    def num(v: float) -> str:
        s = f"{float(v):.3f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    def rect(r) -> str:
        return "[" + ", ".join(str(int(v)) for v in r) + "]"

    def pair(p) -> str:
        return "[" + ", ".join(num(v) for v in p) + "]"

    lines = [
        "import type { FramePack } from \"./types\";",
        "",
        "/**",
        " * Design-faithful artwork metadata for rainlit pack 02.",
        " *",
        " * Authored by `tools/build-rainlit-02.py` from the real `gpt-image-2`",
        " * component masters under",
        " * `assets/rainlit-frames/02/design-faithful/source/`; measured cell",
        " * rectangles, cuts and provenance live in",
        " * `assets/rainlit-frames/02/design-faithful/source.json`. The 52 logical px",
        " * ring doubles every ornament's geometry while the accepted bamboo cells",
        " * keep their authored pixels.",
        " *",
        " * Imported pure: no asset loading, effect compilation or selection side",
        " * effects.",
        " *",
        " * `lightPlacement` is the measured real paper-lamp centre and bounded",
        " * spill. It belongs to the pack's INTERIOR profile rather than the",
        " * top-level frame geometry, so `frame-02.ts` spreads the rest of the",
        " * artwork and binds this field under `interior`.",
        " */",
        "export interface Frame02Art",
        "  extends Pick<",
        "    FramePack,",
        '    "atlas" | "atlasSize" | "corners" | "cornerSize" | "rails" | "railPeriod" | "layers"',
        "  > {",
        '  readonly lightPlacement: NonNullable<FramePack["interior"]["lightPlacement"]>;',
        "}",
        "",
        "export const FRAME_02_ART: Frame02Art = {",
        f'  atlas: "{art["atlas"]}",',
        f'  atlasSize: [{art["atlasSize"][0]}, {art["atlasSize"][1]}],',
        "  corners: {",
    ]
    for key in ("tl", "tr", "bl", "br"):
        lines.append(f"    {key}: {rect(art['corners'][key])},")
    lines += [
        "  },",
        "  cornerSize: {",
        f"    top: {pair(art['cornerSize']['top'])},",
        f"    bottom: {pair(art['cornerSize']['bottom'])},",
        "  },",
        "  rails: {",
    ]
    for key in ("top", "bottom", "left", "right"):
        lines.append(f"    {key}: {rect(art['rails'][key])},")
    lines += [
        "  },",
        f"  railPeriod: {{ horizontal: {art['railPeriod']['horizontal']},"
        f" vertical: {art['railPeriod']['vertical']} }},",
        "  layers: [",
    ]
    for layer in art["layers"]:
        lines.append("    {")
        lines.append(f'      id: "{layer["id"]}",')
        lines.append(f"      cell: {rect(layer['cell'])},")
        lines.append(f'      anchor: "{layer["anchor"]}",')
        lines.append(f"      offset: {pair(layer['offset'])},")
        lines.append(f"      size: {pair(layer['size'])},")
        lines.append(f"      pivot: {pair(layer['pivot'])},")
        for key, ts_key in (("reveal", "reveal"), ("revealMode", "revealMode"),
                            ("translateY", "translateY"), ("angle", "angle"),
                            ("emission", "emission")):
            if key in layer:
                lines.append(f'      {ts_key}: "{layer[key]}",')
        lines.append("    },")
    lines += [
        "  ],",
        "  lightPlacement: {",
        f'    anchor: "{art["lightPlacement"]["anchor"]}",',
        f"    offset: {pair(art['lightPlacement']['offset'])},",
        f"    spread: {pair(art['lightPlacement']['spread'])},",
        "  },",
        "};",
        "",
    ]
    ART_TS.write_text("\n".join(lines))


def write_overview(cells: dict, art: dict) -> None:
    """Offline, clearly non-runtime preview and component sheet for review.

    The canvas is the root PLUS the authored outsets, so the crane, the lamp
    and the bamboo that legitimately hang outside the window stay visible
    instead of being clipped at the root edge like they are on screen.
    """
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    root_w, root_h = 1240, 780
    out_l, out_r, out_t, out_b = 0, 68, 24, 0
    canvas_w, canvas_h = root_w + out_l + out_r, root_h + out_t + out_b
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (24, 26, 30, 255))
    ox, oy = out_l, out_t           # root origin inside the canvas

    def tile(name: str, box: tuple[int, int, int, int]) -> None:
        x0, y0, x1, y1 = box
        if x1 <= x0 or y1 <= y0:
            return
        cell = to_image(cells[name]).resize((x1 - x0, y1 - y0), Image.LANCZOS)
        canvas.alpha_composite(cell, (x0 + ox, y0 + oy))

    tile("corner-tl", (0, 0, CORNER_LOGICAL, CORNER_LOGICAL))
    tile("corner-tr", (root_w - CORNER_LOGICAL, 0, root_w, CORNER_LOGICAL))
    tile("corner-bl", (0, root_h - CORNER_LOGICAL, CORNER_LOGICAL, root_h))
    tile("corner-br", (root_w - CORNER_LOGICAL, root_h - CORNER_LOGICAL, root_w, root_h))
    for x in range(CORNER_LOGICAL, root_w - CORNER_LOGICAL, RAIL_PERIOD["horizontal"]):
        tile("top-rail", (x, 0, min(x + RAIL_PERIOD["horizontal"], root_w - CORNER_LOGICAL), INSET))
        tile("bottom-rail", (x, root_h - INSET,
                             min(x + RAIL_PERIOD["horizontal"], root_w - CORNER_LOGICAL), root_h))
    for y in range(CORNER_LOGICAL, root_h - CORNER_LOGICAL, RAIL_PERIOD["vertical"]):
        tile("left-rail", (0, y, INSET, min(y + RAIL_PERIOD["vertical"], root_h - CORNER_LOGICAL)))
        tile("right-rail", (root_w - INSET, y, root_w,
                            min(y + RAIL_PERIOD["vertical"], root_h - CORNER_LOGICAL)))

    for layer in art["layers"]:
        w = max(1, int(round(layer["size"][0])))
        h = max(1, int(round(layer["size"][1])))
        anchor = layer["anchor"]
        x = (root_w if anchor in ("tr", "br") else 0) + layer["offset"][0]
        y = (root_h if anchor in ("bl", "br") else 0) + layer["offset"][1]
        img = to_image(cells[layer["id"]]).resize((w, h), Image.LANCZOS)
        canvas.alpha_composite(img, (int(round(x)) + ox, int(round(y)) + oy))

    draw = ImageDraw.Draw(canvas)
    draw.rectangle([ox, oy, ox + root_w - 1, oy + root_h - 1], outline=(150, 60, 60, 200))
    draw.rectangle([ox + INSET, oy + INSET, ox + root_w - INSET - 1, oy + root_h - INSET - 1],
                   outline=(90, 200, 255, 170))
    draw.text((ox + INSET + 6, oy + INSET + 6), "protected client (52 px ring)",
              fill=(140, 205, 255, 230))
    draw.text((ox + 4, oy + root_h - 16), "root / outset guide: L0 R68 T24 B0",
              fill=(230, 150, 150, 210))
    # the banner sits at the BOTTOM so the top outset (where the bamboo roll
    # legitimately hangs above the root) stays visible for review
    draw.rectangle([0, canvas_h - 20, canvas_w, canvas_h], fill=(0, 0, 0, 225))
    draw.text((6, canvas_h - 15), "OFFLINE PREVIEW - NOT RUNTIME - authored by tools/build-rainlit-02.py",
              fill=(255, 214, 130, 255))
    canvas.save(PREVIEW_PNG)

    cols, cell_w, cell_h = 5, 380, 300
    rows = (len(ORDER) + cols - 1) // cols
    header = 22
    sheet = Image.new("RGBA", (cols * cell_w, header + rows * cell_h), (24, 26, 30, 255))
    sdraw = ImageDraw.Draw(sheet)
    for i, name in enumerate(ORDER):
        cx, cy = (i % cols) * cell_w, header + (i // cols) * cell_h
        for by in range(0, cell_h - 24, 16):
            for bx in range(0, cell_w, 16):
                if (bx // 16 + by // 16) % 2 == 0:
                    sdraw.rectangle([cx + bx, cy + 24 + by, cx + bx + 15, cy + 24 + by + 15],
                                    fill=(46, 48, 54, 255))
        cell = to_image(cells[name])
        scale = min((cell_w - 24) / cell.width, (cell_h - 60) / cell.height, 1.0)
        shown = cell.resize((max(1, int(cell.width * scale)), max(1, int(cell.height * scale))),
                            Image.LANCZOS)
        sheet.alpha_composite(shown, (cx + 12 + (cell_w - 24 - shown.width) // 2,
                                      cy + 30 + (cell_h - 60 - shown.height) // 2))
        sdraw.rectangle([cx, cy, cx + cell_w - 1, cy + cell_h - 1], outline=(70, 74, 82, 255))
        sdraw.text((cx + 8, cy + 6), f"{name}  {cell.width}x{cell.height}px",
                   fill=(240, 226, 200, 255))
    sdraw.rectangle([0, 0, sheet.width, header], fill=(0, 0, 0, 225))
    sdraw.text((6, 5), "OFFLINE COMPONENT SHEET - NOT RUNTIME - authored by tools/build-rainlit-02.py",
               fill=(255, 214, 130, 255))
    sheet.save(COMPONENTS_PNG)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def run() -> int:
    wood_rgb = np.asarray(Image.open(SOURCE_DIR / "wood-gpt-image-2.webp")
                          .convert("RGB")).astype(np.float32)
    corners_rgba = load_rgba(SOURCE_DIR / "corners-gpt-image-2.webp")
    crane_rgba = load_rgba(SOURCE_DIR / "crane-gpt-image-2.webp")
    lamp_rgba = load_rgba(SOURCE_DIR / "lamp-gpt-image-2.webp")

    wood = measure_wood(wood_rgb)
    pieces, corner_metrics = measure_corners(corners_rgba)
    crane = measure_crane(crane_rgba)
    lamp = measure_lamp(lamp_rgba)

    cells: dict[str, np.ndarray] = {}
    for side in ("top", "bottom"):
        cells[f"{side}-rail"] = build_horizontal_rail(wood_rgb, wood, side)
    for side in ("left", "right"):
        cells[f"{side}-rail"] = build_vertical_rail(wood, wood_rgb, side)
    corner_cells = build_corner_cells(pieces, corner_metrics)
    cells.update(corner_cells)

    target_h, target_v = corner_arm_profiles(corner_cells)
    targets = {"top": target_h, "bottom": target_h[::-1],
               "left": target_v, "right": target_v[::-1]}
    profile_gain = {}
    for side in ("top", "bottom", "left", "right"):
        name = f"{side}-rail"
        cells[name], gain = match_rail_profile(cells[name], targets[side], side)
        profile_gain[name] = [round(float(v), 3) for v in gain]

    cells["crane"], crane_geo = build_crane_cell(crane_rgba, crane)
    lamp_cells, lamp_info = build_lamp_cells(lamp_rgba, lamp)
    cells.update(lamp_cells)
    cells.update(legacy_cells())

    checks = build_checks(cells, corner_cells, crane, lamp)

    atlas, rects = pack_cells(cells)
    layers_dir = OUT_DIR / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT_DIR / ATLAS_NAME)
    outputs = {ATLAS_NAME: {"sha256": sha256_file(OUT_DIR / ATLAS_NAME),
                            "size": list(atlas.size)}}
    for name in ORDER:
        img = to_image(cells[name])
        path = layers_dir / f"{name}.png"
        img.save(path)
        outputs[f"layers/{name}.png"] = {"sha256": sha256_file(path), "size": list(img.size)}
    manifest = production_manifest()

    art = {
        "atlas": "./assets/rainlit-frames/02/design-faithful/frame-atlas.png",
        "atlasSize": [ATLAS_SIZE, ATLAS_SIZE],
        "corners": {k: rects[f"corner-{k}"] for k in ("tl", "tr", "bl", "br")},
        "cornerSize": {"top": [CORNER_LOGICAL, CORNER_LOGICAL],
                       "bottom": [CORNER_LOGICAL, CORNER_LOGICAL]},
        "rails": {k: rects[f"{k}-rail"] for k in ("top", "bottom", "left", "right")},
        "railPeriod": dict(RAIL_PERIOD),
        "lightPlacement": lamp_info["lightPlacement"],
        "layers": [],
    }
    measured_geo = dict(lamp_info["geometry"])
    measured_geo["crane"] = crane_geo
    for layer_id in LAYER_ORDER:
        geo = dict(measured_geo.get(layer_id, LAYER_FIXED.get(layer_id, {})))
        if not geo:
            raise SystemExit(f"no geometry for layer {layer_id}")
        cell = to_image(cells[layer_id]).size
        entry = {
            "id": layer_id,
            "cell": rects[layer_id],
            "source_cell_size": list(cell),
            "anchor": geo.get("anchor", "br"),
            "offset": [round(float(v), 3) for v in geo["offset"]],
            "size": [round(float(v), 3) for v in geo["size"]],
            "pivot": [round(float(v), 3) for v in geo["pivot"]],
        }
        for src_key, ts_key in (("reveal", "reveal"), ("reveal_mode", "revealMode"),
                                ("translate_y", "translateY"), ("angle", "angle"),
                                ("emission", "emission")):
            if src_key in geo:
                entry[ts_key] = geo[src_key]
        art["layers"].append(entry)

    write_art_ts(art)
    write_overview(cells, art)

    provenance = {
        "pack": "02",
        "variant": "design-faithful",
        "title": "Bamboo roll, paper crane, paper lamp",
        "builder": "tools/build-rainlit-02.py",
        "deterministic": True,
        "supersedes": "the legacy 26 px ring pack in ../source.json, which stays frozen and is not rebuilt",
        "frozen_master": {
            "path": "../master.webp",
            "sha256": "a58cb8ed7f7f26365ee9a9a3e5e13cc95e44bba5ebff783a0b454df6f21ba58e",
            "note": "the owner-approved 02 painterly concept is immutable and untouched by this builder",
        },
        "generation": {
            "provider": "openai-codex",
            "requested_model": "openai-codex/gpt-image-2",
            "actual_model": "gpt-image-2-codex",
            "manifest": "source/generation-manifest.json",
            "source_files": manifest,
            "pixel_units": {
                "source": ("source px exactly as delivered by the generator; actual dimensions are "
                           "used, never the requested ones"),
                "components": f"{COMPONENT_PX} atlas px per logical px (corners, crane, lamp)",
                "rails": "2 atlas px per logical px, the most the generated wood sheet provides",
                "legacy_cells": ("the accepted bamboo/hook/glow cells keep their authored pixels and "
                                 "are drawn at 2 logical px per cell px because the ring doubled"),
            },
            "alpha": ("every generated master carries genuine near-opaque alpha with anti-aliased "
                      "edges; alpha is preserved as authored, never re-keyed from luminance, and all "
                      "resampling runs in premultiplied alpha so the decoder-visible garbage RGB "
                      "under alpha 0 can never bleed into an edge. Where one master is split into "
                      "parts (the lamp's static bracket and moving body) each cell's alpha is the "
                      "master's authored alpha MULTIPLIED by that part's measured coverage, so a "
                      "genuine transparent opening such as the hanging link's inner hole stays "
                      "transparent instead of becoming an opaque patch of decoder RGB"),
            "self_contained": ("the builder reads only the production copies listed here under "
                               "design-faithful/source/ and never reads or re-copies the ignored "
                               "scratch directory"),
        },
        "ring": {
            "inset_logical": INSET,
            "corner_canvas_logical": [CORNER_LOGICAL, CORNER_LOGICAL],
            "corner_arm_logical": [INSET, INSET],
            "rail_period_logical": dict(RAIL_PERIOD),
            "minimum_root": [480, 320],
            "outsets": {"left": 0, "right": 68, "top": 24, "bottom": 0},
        },
        "wood": wood,
        "corners": {
            "pieces": corner_metrics,
            "normalisation": (f"each measured piece maps its inner arm turn to exactly "
                              f"({INSET},{INSET}) logical inside the {CORNER_LOGICAL}x{CORNER_LOGICAL} "
                              "canvas and fills both 52 px arms, with the two segment scales differing "
                              "only by the piece's own arm asymmetry (anisotropy recorded per corner, "
                              "all well inside the bounded 1.2)"),
            "hardware": "the sheet's own joinery and brass stay once per corner; nothing repeats along the rails",
        },
        "crane": {k: v for k, v in crane.items() if not k.startswith("_")},
        "lamp": {k: v for k, v in lamp.items() if not k.startswith("_")},
        "rails": {
            "cross_section_match": ("each rail keeps its own generated grain and is tone-matched "
                                    "across the cross-section to the one-shot corner arm it abuts "
                                    "(smoothed per-row gain clamped to [0.85, 1.18]); the material is "
                                    "never replaced by an opaque plate and no matte hides the join"),
            "cross_section_gain": profile_gain,
            "neutral_cut": (f"each long span trims {RAIL_TRIM} px of endcap bevel from both ends and "
                            "contains no peg, notch, screw or fastener"),
            "wrap": "each rail cell cross-fades its own ends so the neutral material tiles without a visible seam",
        },
        "atlas": {
            "file": ATLAS_NAME,
            "size": [ATLAS_SIZE, ATLAS_SIZE],
            "gutter_px": GUTTER,
            "alpha": "straight RGBA; RGB zeroed exactly where alpha is zero",
            "cells": rects,
        },
        "checks": checks,
        "art_module": str(ART_TS.relative_to(REPO)),
        "art_metadata": art,
        "offline_review_art": [str(PREVIEW_PNG.relative_to(REPO)),
                               str(COMPONENTS_PNG.relative_to(REPO))],
        "outputs": outputs,
        "not_claimed": [
            "no runtime, geometry, hit-testing, alpha-compositing or performance claim",
            "native rendering and the owner's acceptance are not asserted here: the 52 px ring, the "
            "joins and the crane/lamp scale are authored and measured, not visually verified",
            "all-size joins and mitre behaviour are unverified",
        ],
    }
    (OUT_DIR / PROVENANCE_NAME).write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"wrote {OUT_DIR}/{PROVENANCE_NAME}, {ATLAS_NAME}, {len(ORDER)} layer PNGs, "
          f"{ART_TS.relative_to(REPO)} and 2 offline review images")
    return 0


def main() -> int:
    require_sources()
    return run()


if __name__ == "__main__":
    sys.exit(main())

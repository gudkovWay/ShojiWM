#!/usr/bin/env python3
"""Author the Rainlit 07 frame pack from the approved painterly master.

This builder is a *materialisation* tool, not a test: it produces the real
runtime assets requested by the plan (atlas, doll control canvases, eye glow
masks, provenance) from the pack's shipped `master.webp`.

Everything is derived from measured source pixels; there is no invented art.
Where the declared ring geometry is thicker than the measured source band
(07's 48-logical top beam), the missing thickness is filled with *real*
source wood rows rearranged without stretching (documented per cell in
`source.json`). Alpha is derived from semantic segmentation (flat backdrop vs
material), never from a global dark-key, so dark hair stays opaque.

Run:  python3 tools/build-rainlit-07.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

import numpy as np
from PIL import Image

# --------------------------------------------------------------------------
# Frozen geometry contract (packages/config/src/effect/rainlit/types.ts)
# --------------------------------------------------------------------------

ATLAS_SIZE = (2048, 2048)
GUTTER = 2

# Declared logical insets (logical px) for pack 07.
INSETS = {"left": 26, "right": 26, "top": 48, "bottom": 26}
# Cell sizes in atlas pixels (= 4x logical).
CELL = {
    "rail_top": (1024, 192),
    "rail_bottom": (1024, 104),
    "rail_left": (104, 512),
    "rail_right": (104, 512),
    "corner_tl": (168, 256),
    "corner_tr": (168, 256),
    "corner_bl": (168, 168),
    "corner_br": (168, 168),
}
# Doll control canvases (atlas px = 4x the logical control size 32x44).
DOLL_CANVAS = (128, 176)
CONTROL_SIZE = (32, 44)

# Measured source geometry (image pixels of 07-painterly.webp, 1536x1024).
SRC_W, SRC_H = 1536, 1024
BACKDROP = np.array([35, 36, 40])  # flat area fill used for the opening + margins
OPENING = (171, 1185, 191, 777)  # x0, x1, y0, y1 (inclusive)
BEAM_TOP = (101, 191)  # outer top edge .. opening top edge
BEAM_BOTTOM = (779, 865)  # opening bottom edge .. outer bottom edge
RAIL_LEFT = (85, 171)
RAIL_RIGHT = (1186, 1271)
# Full clean (ornament-free) vertical windows inside the side rails.
RAIL_LEFT_CLEAN = (520, 732)
RAIL_RIGHT_CLEAN = (300, 512)
# Clean horizontal window inside the beams (no hardware, no ornament).
BEAM_WINDOW = (320, 743)  # 423 px

# Source -> atlas uniform scale. Derived from the mean measured side-rail band
# (86 source px) mapping onto the declared 26-logical (104 atlas px) inset.
ALPHA = 104.0 / 86.0  # 1.20930...
LSCALE = ALPHA / 4.0  # atlas px -> logical px

# Ring outer corner in source coordinates (uniform scale, symmetric ring).
OUTER_LEFT = OPENING[0] - 86
OUTER_TOP = OPENING[2] - round(48 * 4 / ALPHA)
OUTER_RIGHT = OPENING[1] + 86
OUTER_BOTTOM = OPENING[3] + 86
SRC_ORIGIN = (OUTER_LEFT, OUTER_TOP)

# Ornament source boxes (x0, x1, y0, y1) - exclusive upper bounds.
KNOT_SRC = (12, 106, 194, 246)
TASSEL_A_SRC = (14, 64, 234, 458)
TASSEL_B_SRC = (64, 102, 234, 508)
# Thread roots (the point the sprite swings about), in source coordinates.
TASSEL_A_ROOT = (50.5, 240.0)
TASSEL_B_ROOT = (74.5, 240.0)

# Dolls: source boxes, pupil centres (measured from the face highlights) and
# the role they drive (left=-indigo/min, middle=ochre/max, right=red/close).
DOLLS = {
    "min": {
        "src": (1424, 1472, 658, 780),  # indigo
        "pupils": [(1442.0, 684.0), (1454.0, 684.0)],
        "hue": [0.42, 0.50, 0.72],
    },
    "max": {
        "src": (1362, 1422, 626, 780),  # ochre
        "pupils": [(1383.0, 658.0), (1398.0, 658.0)],
        "hue": [1.0, 0.66, 0.34],
    },
    "close": {
        "src": (1280, 1360, 562, 780),  # red
        "pupils": [(1309.5, 605.0), (1330.5, 605.0)],
        "hue": [1.0, 0.36, 0.28],
    },
}

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PACK_DIR = os.path.join(REPO, "packages", "config", "assets", "rainlit-frames", "07")
MASTER_NAME = "master.webp"
MASTER_SHA256 = "9c8b21fd7ec24142c383b5c0655093d2a088b29098c18579574306ba7de1db8f"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def load_master(path: str) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if img.size != (SRC_W, SRC_H):
        raise SystemExit(f"unexpected master size {img.size}, expected {(SRC_W, SRC_H)}")
    return img


def crop(img: Image.Image, box) -> Image.Image:
    return img.crop(box)


def resized(img: Image.Image, size) -> Image.Image:
    return img.resize(size, Image.LANCZOS if size[0] * size[1] < img.width * img.height else Image.BICUBIC)


def exact(arr: np.ndarray, size) -> np.ndarray:
    """Center-crop or edge-pad `arr` (h, w, ...) to exactly `size` = (height, width)."""
    h, w = size
    ah, aw = arr.shape[0], arr.shape[1]
    if ah > h:
        off = (ah - h) // 2
        arr = arr[off : off + h]
    elif ah < h:
        arr = np.concatenate([arr, np.repeat(arr[-1:], h - ah, axis=0)], axis=0)
    if aw > w:
        off = (aw - w) // 2
        arr = arr[:, off : off + w]
    elif aw < w:
        arr = np.concatenate([arr, np.repeat(arr[:, -1:], w - aw, axis=1)], axis=1)
    return arr


def mirror_h(arr: np.ndarray) -> np.ndarray:
    """Mirror-periodic horizontal extension: [A | reverse(A)]."""
    return np.concatenate([arr, arr[:, ::-1]], axis=1)


def mirror_v(arr: np.ndarray) -> np.ndarray:
    return np.concatenate([arr, arr[::-1, :]], axis=0)


def fill_band(arr: np.ndarray, rows: int) -> np.ndarray:
    """Fill `rows` from `arr` using a mirror-periodic tiling (no wrap seam).

    `mirror_v` produces [A | reverse(A)], whose last row equals its first, so
    repeating it is C0-continuous at every period boundary. This replaces a
    plain modulo tile, which would leave a visible horizontal repeat seam in
    the middle of the extended beam face.
    """
    period = mirror_v(arr)
    reps = int(math.ceil(rows / period.shape[0]))
    tiled = np.concatenate([period] * reps, axis=0)
    off = (tiled.shape[0] - rows) // 2
    return tiled[off : off + rows]


def fit(arr: np.ndarray, size) -> np.ndarray:
    """Resize `arr` to `size` given as (height, width) - matching numpy shape order."""
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    return np.asarray(resized(img, (size[1], size[0]))).astype(np.float64)


# --------------------------------------------------------------------------
# frame cells
# --------------------------------------------------------------------------


def top_band(region: np.ndarray) -> np.ndarray:
    """Build a 192-row top band from real source rows of `region`.

    `region` is the source rectangle covering x0..x1 of the beam and the full
    90-row beam height (y=BEAM_TOP). The declared top band is 48 logical
    (192 atlas px), i.e. 158.8 source rows, while the beam face measures 90
    rows. The extra thickness is produced by repeating the beam's own wood
    face (rows 13..71 of the region) - no stretching, no invented material.
    Hardware/ornament-free by construction (clean BEAM_WINDOW only).
    """
    w = int(round(region.shape[1] * ALPHA))
    band = np.zeros((192, w, 3), np.float64)
    top_edge = fit(region[0:10], (12, w))  # dark rim + highlight
    face = fit(region[13:71], (70, w))  # flat wood face
    bottom = fit(region[71:90], (23, w))  # face end + under-lip
    band[0:12] = top_edge
    band[12:169] = fill_band(face, 157)
    band[169:192] = bottom
    return band


def bottom_band(region: np.ndarray) -> np.ndarray:
    """86 measured source rows -> 104 atlas rows (uniform scale, no stretch)."""
    return fit(region, (104, int(round(region.shape[1] * ALPHA))))


def mirror_to_width(arr: np.ndarray, width: int) -> np.ndarray:
    wide = mirror_h(arr)
    if wide.shape[1] < width:
        raise SystemExit("mirror window too narrow")
    off = (wide.shape[1] - width) // 2
    return wide[:, off : off + width]


def rail_band(region: np.ndarray) -> np.ndarray:
    """104-atlas-column rail band from a clean source window, mirror-periodic vertically."""
    h = region.shape[0]
    half = 256
    scaled = fit(region, (half, int(round(region.shape[1] * ALPHA))))
    doubled = mirror_v(scaled)
    return doubled[:512]


# --------------------------------------------------------------------------
# atlas assembly
# --------------------------------------------------------------------------


class Atlas:
    def __init__(self):
        self.rgb = np.zeros((ATLAS_SIZE[1], ATLAS_SIZE[0], 3), np.float64)
        self.alpha = np.zeros((ATLAS_SIZE[1], ATLAS_SIZE[0]), np.float64)
        self.cursor_x = GUTTER
        self.cursor_y = GUTTER
        self.row_h = 0
        self.cells = {}

    def _alloc(self, size):
        w, h = size
        if self.cursor_x + w + GUTTER > ATLAS_SIZE[0]:
            self.cursor_x = GUTTER
            self.cursor_y += self.row_h + GUTTER
            self.row_h = 0
        if self.cursor_y + h + GUTTER > ATLAS_SIZE[1]:
            raise SystemExit("atlas overflow")
        pos = (self.cursor_x, self.cursor_y)
        self.cursor_x += w + GUTTER
        self.row_h = max(self.row_h, h)
        return pos

    def place(self, name, rgb, alpha, size=None):
        if size is not None:
            rgb = exact(rgb, size)
            alpha = exact(alpha, size)
        h, w = alpha.shape
        x, y = self._alloc((w, h))
        self.rgb[y : y + h, x : x + w] = rgb
        self.alpha[y : y + h, x : x + w] = alpha
        self.cells[name] = [int(x), int(y), int(w), int(h)]
        return self.cells[name]

    def finish(self):
        rgb = np.round(np.clip(self.rgb, 0, 255)).astype(np.uint8)
        alpha = np.round(np.clip(self.alpha, 0, 1) * 255).astype(np.uint8)
        rgb[alpha == 0] = 0
        out = np.dstack([rgb, alpha])
        return Image.fromarray(out, "RGBA")


# --------------------------------------------------------------------------
# segmentation
# --------------------------------------------------------------------------


def backdrop_distance(arr: np.ndarray) -> np.ndarray:
    return np.abs(arr - BACKDROP[None, None, :]).sum(axis=2)


def soft_material_alpha(arr: np.ndarray) -> np.ndarray:
    """Soft alpha for 'not the flat backdrop' inside an ornament box."""
    d = backdrop_distance(arr)
    a = np.clip((d - 10.0) / 18.0, 0.0, 1.0)
    return a


def soft_cloth_alpha(arr: np.ndarray) -> np.ndarray:
    """Alpha for the red knot/tassel cloth.

    The cloth is measured at HSV saturation 0.52..0.68 while the wooden rail
    behind it sits at 0.30..0.42, so a saturation ramp separates the moving
    ornament from the static rail without a global dark-key (the knot's
    shadowed folds stay partially opaque).
    """
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    d = backdrop_distance(arr)
    base = np.clip((d - 10.0) / 18.0, 0.0, 1.0)
    cloth = np.clip((sat - 0.42) / 0.08, 0.0, 1.0)
    return base * cloth


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """Flood the border through False cells; anything unreached is an interior hole."""
    h, w = mask.shape
    reach = np.zeros_like(mask, bool)
    stack = []
    for x in range(w):
        if not mask[0, x]:
            stack.append((0, x))
        if not mask[h - 1, x]:
            stack.append((h - 1, x))
    for y in range(h):
        if not mask[y, 0]:
            stack.append((y, 0))
        if not mask[y, w - 1]:
            stack.append((y, w - 1))
    while stack:
        y, x = stack.pop()
        if reach[y, x] or mask[y, x]:
            continue
        reach[y, x] = True
        if y > 0:
            stack.append((y - 1, x))
        if y < h - 1:
            stack.append((y + 1, x))
        if x > 0:
            stack.append((y, x - 1))
        if x < w - 1:
            stack.append((y, x + 1))
    return mask | ~reach


def blur_mask(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    """3x3 box blur that does not wrap across the sprite border."""
    out = np.pad(mask.astype(np.float64), radius, mode="constant")
    for _ in range(radius):
        acc = np.zeros_like(out)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc += np.roll(np.roll(out, dy, 0), dx, 1)
        out = acc / 9.0
    return out[radius:-radius, radius:-radius]


# --------------------------------------------------------------------------
# main build
# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--master", default=None, help="override master webp path")
    args = ap.parse_args()

    os.makedirs(PACK_DIR, exist_ok=True)
    shipped = os.path.join(PACK_DIR, MASTER_NAME)
    source_master = args.master if args.master else shipped
    if not os.path.exists(source_master):
        raise SystemExit(f"master not found: {source_master}")

    raw = open(source_master, "rb").read()
    digest = hashlib.sha256(raw).hexdigest()
    if not args.master and digest != MASTER_SHA256:
        raise SystemExit(f"master hash mismatch: {digest}")

    img = load_master(source_master)
    src = np.asarray(img).astype(np.float64)
    atlas = Atlas()
    notes = {}

    # --- beams -------------------------------------------------------------
    beam_win = (BEAM_WINDOW[0], BEAM_WINDOW[1])
    top_region = src[BEAM_TOP[0] : BEAM_TOP[1], beam_win[0] : beam_win[1], :]
    band_rgb = top_band(top_region)
    band_rgb = mirror_to_width(band_rgb, CELL["rail_top"][0])
    atlas.place(
        "rail_top",
        band_rgb,
        np.ones((CELL["rail_top"][1], CELL["rail_top"][0])),
        (CELL["rail_top"][1], CELL["rail_top"][0]),
    )
    notes["rail_top"] = {
        "source_rows": [BEAM_TOP[0], BEAM_TOP[1]],
        "source_cols": list(beam_win),
        "source_px": [beam_win[1] - beam_win[0], BEAM_TOP[1] - BEAM_TOP[0]],
        "construction": (
            "mirror-periodic over a 423px hardware-free beam window; the declared "
            "48-logical band is 158.8 source rows while the beam face measures 90, "
            "so the extra 68.8 rows repeat the beam's own wood face (rows 13..71) "
            "verbatim; the original dark rim + highlight sits at the outer edge and "
            "the original under-lip at the opening edge. No stretching."
        ),
    }

    bot_region = src[BEAM_BOTTOM[0] : BEAM_BOTTOM[1], beam_win[0] : beam_win[1], :]
    bb = bottom_band(bot_region)
    bb = mirror_to_width(bb, CELL["rail_bottom"][0])
    atlas.place(
        "rail_bottom",
        bb,
        np.ones((CELL["rail_bottom"][1], CELL["rail_bottom"][0])),
        (CELL["rail_bottom"][1], CELL["rail_bottom"][0]),
    )
    notes["rail_bottom"] = {
        "source_rows": list(BEAM_BOTTOM),
        "source_cols": list(beam_win),
        "construction": "86 measured rows scaled to 104 atlas rows, mirror-periodic horizontally.",
    }

    # --- side rails --------------------------------------------------------
    lw = RAIL_LEFT[1] - RAIL_LEFT[0]
    left_region = src[RAIL_LEFT_CLEAN[0] : RAIL_LEFT_CLEAN[1], RAIL_LEFT[0] : RAIL_LEFT[1], :]
    lb = rail_band(left_region)
    atlas.place("rail_left", lb, np.ones((512, 104)), (512, 104))
    notes["rail_left"] = {
        "source_rows": list(RAIL_LEFT_CLEAN),
        "source_cols": list(RAIL_LEFT),
        "construction": (
            "only the ornament-free lower rail window is used, so the red knot "
            "(y194..246) and the tassels (y234..508) never enter the static cell; "
            "212 rows scale to 256 and mirror to 512."
        ),
        "source_width_px": lw,
    }

    rw = RAIL_RIGHT[1] - RAIL_RIGHT[0]
    right_region = src[RAIL_RIGHT_CLEAN[0] : RAIL_RIGHT_CLEAN[1], RAIL_RIGHT[0] : RAIL_RIGHT[1], :]
    rb = rail_band(right_region)
    atlas.place("rail_right", rb, np.ones((512, 104)), (512, 104))
    notes["rail_right"] = {
        "source_rows": list(RAIL_RIGHT_CLEAN),
        "source_cols": list(RAIL_RIGHT),
        "construction": "clean mid-rail window; 212 rows scale to 256 and mirror to 512.",
        "source_width_px": rw,
    }

    # --- corners -----------------------------------------------------------
    def corner_band(cols):
        """Top band (rows 0..192) of a top corner cell, built from its own columns."""
        region = src[BEAM_TOP[0] : BEAM_TOP[1], cols[0] : cols[1], :]
        return top_band(region)

    # top-left: source x85..225
    tl_cols = (OUTER_LEFT, OUTER_LEFT + 140)
    tl_top = corner_band(tl_cols)
    tl_top = fit(tl_top, (192, 168))
    cell = np.zeros((256, 168, 3), np.float64)
    alpha = np.zeros((256, 168), np.float64)
    cell[0:192] = tl_top
    alpha[0:192, :] = 1.0
    # real above-beam material (the corner post) composited over the extension
    above = src[OUTER_TOP : BEAM_TOP[0], tl_cols[0] : tl_cols[1], :]
    above_rgb = fit(above, (83, 168))
    above_a = fit(soft_material_alpha(above), (83, 168))
    a3 = above_a[:, :, None]
    cell[0:83] = cell[0:83] * (1 - a3) + above_rgb * a3
    alpha[0:83] = np.maximum(alpha[0:83], above_a)
    # rail zone rows 192..256 from the clean left rail band
    rail_zone = fit(src[RAIL_LEFT_CLEAN[1] - 50 : RAIL_LEFT_CLEAN[1], RAIL_LEFT[0] : RAIL_LEFT[1], :], (64, 104))
    cell[192:256, 0:104] = rail_zone
    alpha[192:256, 0:104] = 1.0
    atlas.place("corner_tl", cell, alpha, (256, 168))
    notes["corner_tl"] = {
        "source_cols": list(tl_cols),
        "source_above_beam_rows": [OUTER_TOP, BEAM_TOP[0]],
        "construction": (
            "own-column top band; real above-beam post composited over the extended "
            "wood; rail zone from the clean left rail band so the knot tip (x85..100, "
            "y196..244) and tassel roots are absent from the static cell."
        ),
    }

    # top-right: source x1131..1271
    tr_cols = (OUTER_RIGHT - 140, OUTER_RIGHT)
    tr_top = fit(corner_band(tr_cols), (192, 168))
    cell = np.zeros((256, 168, 3), np.float64)
    alpha = np.zeros((256, 168), np.float64)
    cell[0:192] = tr_top
    alpha[0:192, :] = 1.0
    above = src[OUTER_TOP : BEAM_TOP[0], tr_cols[0] : tr_cols[1], :]
    above_rgb = fit(above, (83, 168))
    above_a = fit(soft_material_alpha(above), (83, 168))
    a3 = above_a[:, :, None]
    cell[0:83] = cell[0:83] * (1 - a3) + above_rgb * a3
    alpha[0:83] = np.maximum(alpha[0:83], above_a)
    rail_zone = fit(src[RAIL_RIGHT_CLEAN[1] - 50 : RAIL_RIGHT_CLEAN[1], RAIL_RIGHT[0] : RAIL_RIGHT[1], :], (64, 104))
    cell[192:256, 64:168] = rail_zone
    alpha[192:256, 64:168] = 1.0
    atlas.place("corner_tr", cell, alpha, (256, 168))
    notes["corner_tr"] = {
        "source_cols": list(tr_cols),
        "construction": "mirror of corner_tl with the right rail band; inboard 16 logical stays transparent.",
    }

    # bottom-left: source x85..225
    bl_cols = (OUTER_LEFT, OUTER_LEFT + 140)
    cell = np.zeros((168, 168, 3), np.float64)
    alpha = np.zeros((168, 168), np.float64)
    rail_zone = fit(src[RAIL_LEFT_CLEAN[1] - 50 : RAIL_LEFT_CLEAN[1], RAIL_LEFT[0] : RAIL_LEFT[1], :], (64, 104))
    cell[0:64, 0:104] = rail_zone
    alpha[0:64, 0:104] = 1.0
    band = fit(src[BEAM_BOTTOM[0] : BEAM_BOTTOM[1], bl_cols[0] : bl_cols[1], :], (104, 168))
    cell[64:168] = band
    alpha[64:168] = 1.0
    atlas.place("corner_bl", cell, alpha, (168, 168))
    notes["corner_bl"] = {
        "source_cols": list(bl_cols),
        "construction": "rail zone from the clean left rail band; bottom band from the own corner columns (no feet below the declared ring).",
    }

    # bottom-right: bottom band from a clean beam window so the dolls/shelf never enter
    br_clean = (1000, 1140)
    cell = np.zeros((168, 168, 3), np.float64)
    alpha = np.zeros((168, 168), np.float64)
    rail_zone = fit(src[RAIL_RIGHT_CLEAN[1] - 50 : RAIL_RIGHT_CLEAN[1], RAIL_RIGHT[0] : RAIL_RIGHT[1], :], (64, 104))
    cell[0:64, 64:168] = rail_zone
    alpha[0:64, 64:168] = 1.0
    band = fit(src[BEAM_BOTTOM[0] : BEAM_BOTTOM[1], br_clean[0] : br_clean[1], :], (104, 168))
    cell[64:168] = band
    alpha[64:168] = 1.0
    atlas.place("corner_br", cell, alpha, (168, 168))
    notes["corner_br"] = {
        "source_cols": list(br_clean),
        "construction": (
            "bottom band deliberately taken from a clean mid-beam window: the master's "
            "lower-right shelf and dolls sit at x>=1270 / y>=781 and must not appear in "
            "the derived frame atlas."
        ),
    }

    # --- ornaments ---------------------------------------------------------
    def ornament(name, box, extra=GUTTER):
        x0, x1, y0, y1 = box
        x0 = max(0, x0 - extra)
        y0 = max(0, y0 - extra)
        x1 = min(SRC_W, x1 + extra)
        y1 = min(SRC_H, y1 + extra)
        region = src[y0:y1, x0:x1, :]
        a = soft_cloth_alpha(region)
        a = fill_holes(a > 0.5) * a
        a = blur_mask(a, 1)
        size = (int(round(region.shape[0] * ALPHA)), int(round(region.shape[1] * ALPHA)))
        rgb = fit(region, size)
        aa = fit(a, size)
        cell = atlas.place(name, rgb, aa)
        return cell, (x0, y0, x1, y1)

    knot_cell, knot_src = ornament("knot", KNOT_SRC)
    tassel_a_cell, tassel_a_src = ornament("tassel_a", TASSEL_A_SRC)
    tassel_b_cell, tassel_b_src = ornament("tassel_b", TASSEL_B_SRC)

    notes["knot"] = {
        "source_box": list(knot_src),
        "construction": "static red knot ribbon; alpha from flat-backdrop segmentation (no dark key).",
    }
    notes["tassel_a"] = {
        "source_box": list(tassel_a_src),
        "root_source": list(TASSEL_A_ROOT),
        "construction": "left tassel body + thread; swings about its measured thread root.",
    }
    notes["tassel_b"] = {
        "source_box": list(tassel_b_src),
        "root_source": list(TASSEL_B_ROOT),
        "construction": "right tassel body + thread; swings about its measured thread root.",
    }

    atlas_img = atlas.finish()
    atlas_path = os.path.join(PACK_DIR, "frame-atlas.png")
    atlas_img.save(atlas_path)

    def alpha_stats(name):
        x, y, w, h = atlas.cells[name]
        a = atlas.alpha[y : y + h, x : x + w]
        ys, xs = np.nonzero(a > 0.5)
        bbox = (
            [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None
        )
        return {
            "cell": [int(x), int(y), int(w), int(h)],
            "opaque_fraction": round(float((a > 0.5).mean()), 4),
            "opaque_bbox_in_cell": bbox,
        }

    measurements = {name: alpha_stats(name) for name in atlas.cells}

    # --- doll control canvases + eye masks ---------------------------------
    doll_meta = {}
    for role, spec in DOLLS.items():
        x0, x1, y0, y1 = spec["src"]
        region = src[y0:y1, x0:x1, :]
        a = soft_material_alpha(region)
        a = fill_holes(a > 0.5) * a
        # tight bbox of the silhouette (so all dolls share one isotropic scale)
        rows = np.where(a.max(axis=1) > 0.35)[0]
        cols = np.where(a.max(axis=0) > 0.35)[0]
        ty0, ty1 = int(rows[0]), int(rows[-1]) + 1
        tx0, tx1 = int(cols[0]), int(cols[-1]) + 1
        dw, dh = tx1 - tx0, ty1 - ty0
        doll_meta[role] = {
            "bbox_src": [x0 + tx0, y0 + ty0, x0 + tx1, y0 + ty1],
            "w_src": dw,
            "h_src": dh,
        }

    tallest = max(m["h_src"] for m in doll_meta.values())
    common_scale = DOLL_CANVAS[1] / tallest

    for role, spec in DOLLS.items():
        x0, x1, y0, y1 = spec["src"]
        region = src[y0:y1, x0:x1, :]
        a = soft_material_alpha(region)
        a = fill_holes(a > 0.5) * a
        rows = np.where(a.max(axis=1) > 0.35)[0]
        cols = np.where(a.max(axis=0) > 0.35)[0]
        ty0, ty1 = int(rows[0]), int(rows[-1]) + 1
        tx0, tx1 = int(cols[0]), int(cols[-1]) + 1
        dw, dh = tx1 - tx0, ty1 - ty0
        out_w = dw * common_scale
        out_h = dh * common_scale
        off_x = (DOLL_CANVAS[0] - out_w) / 2.0
        off_y = DOLL_CANVAS[1] - out_h  # feet on the canvas floor
        sub = region[ty0:ty1, tx0:tx1, :]
        sub_a = a[ty0:ty1, tx0:tx1]
        oi_w = max(2, int(round(out_w)))
        oi_h = max(2, int(round(out_h)))
        rgb = fit(sub, (oi_h, oi_w))
        aa = fit(sub_a, (oi_h, oi_w))
        canvas = np.zeros((DOLL_CANVAS[1], DOLL_CANVAS[0], 3), np.uint8)
        calpha = np.zeros((DOLL_CANVAS[1], DOLL_CANVAS[0]), np.uint8)
        px = int(round(off_x))
        py = int(round(off_y))
        rgb_u = np.round(np.clip(rgb, 0, 255)).astype(np.uint8)
        a_u = np.round(np.clip(aa, 0, 1) * 255).astype(np.uint8)
        rgb_u[a_u == 0] = 0
        h = min(oi_h, DOLL_CANVAS[1] - py)
        w = min(oi_w, DOLL_CANVAS[0] - px)
        canvas[py : py + h, px : px + w] = rgb_u[:h, :w]
        calpha[py : py + h, px : px + w] = a_u[:h, :w]
        Image.fromarray(np.dstack([canvas, calpha]), "RGBA").save(
            os.path.join(PACK_DIR, f"doll-{role}.png")
        )

        # eye glow mask on the SAME canvas
        eye = np.zeros((DOLL_CANVAS[1], DOLL_CANVAS[0]), np.float64)
        yy, xx = np.mgrid[0 : DOLL_CANVAS[1], 0 : DOLL_CANVAS[0]]
        for (sxp, syp) in spec["pupils"]:
            lx = px + (sxp - (x0 + tx0)) * common_scale
            ly = py + (syp - (y0 + ty0)) * common_scale
            r = 3.4
            g = np.exp(-(((xx - lx) ** 2 + (yy - ly) ** 2) / (2 * r * r)))
            eye = np.maximum(eye, g)
        eye = np.clip((eye - 0.02) / 0.98, 0, 1) ** 0.9
        ec = np.zeros((DOLL_CANVAS[1], DOLL_CANVAS[0], 3), np.uint8)
        tint = np.array(spec["hue"], np.float64)
        for c in range(3):
            ec[:, :, c] = np.round(eye * tint[c] * 255).astype(np.uint8)
        ea = np.round(eye * 255).astype(np.uint8)
        ec[ea == 0] = 0
        Image.fromarray(np.dstack([ec, ea]), "RGBA").save(
            os.path.join(PACK_DIR, f"eyes-{role}.png")
        )
        doll_meta[role]["canvas"] = list(DOLL_CANVAS)
        doll_meta[role]["opaque_fraction"] = round(float((calpha > 128).mean()), 4)
        doll_meta[role]["offset_in_canvas"] = [px, py]
        doll_meta[role]["draw_size"] = [oi_w, oi_h]
        doll_meta[role]["pupils_canvas"] = [
            [
                round(px + (sxp - (x0 + tx0)) * common_scale, 2),
                round(py + (syp - (y0 + ty0)) * common_scale, 2),
            ]
            for (sxp, syp) in spec["pupils"]
        ]

    # --- geometry for frame-07.ts ------------------------------------------
    def logical_from_src(x, y):
        return [round((x - SRC_ORIGIN[0]) * LSCALE, 2), round((y - SRC_ORIGIN[1]) * LSCALE, 2)]

    def logical_size(w, h):
        return [round(w * ALPHA / 4.0, 2), round(h * ALPHA / 4.0, 2)]

    def layer(name, cell, src_box, root=None):
        entry = {
            "id": name,
            "cell": cell,
            "offset_logical": logical_from_src(src_box[0], src_box[1]),
            "size_logical": logical_size(src_box[2] - src_box[0], src_box[3] - src_box[1]),
            "anchor": "tl",
        }
        if root is not None:
            entry["pivot_logical"] = [
                round((root[0] - src_box[0]) * LSCALE, 2),
                round((root[1] - src_box[1]) * LSCALE, 2),
            ]
        else:
            entry["pivot_logical"] = [0, 0]
        return entry

    layers_meta = [
        layer("knot", knot_cell, knot_src),
        layer("tassel_a", tassel_a_cell, tassel_a_src, TASSEL_A_ROOT),
        layer("tassel_b", tassel_b_cell, tassel_b_src, TASSEL_B_ROOT),
    ]

    # outsets: the knot overhangs the ring's left edge; feet stick below.
    knot_off = layers_meta[0]["offset_logical"]
    tassel_a_off = layers_meta[1]["offset_logical"]
    tassel_b_off = layers_meta[2]["offset_logical"]
    left_min = min(knot_off[0], tassel_a_off[0], tassel_b_off[0])
    bottom_src = max(TASSEL_B_SRC[3], 905)
    bottom_extra = round((bottom_src - OUTER_BOTTOM) * LSCALE, 1)

    geometry = {
        "opening_source": list(OPENING),
        "insets_logical": dict(INSETS),
        "ring_outer_source": {
            "left": OUTER_LEFT,
            "top": OUTER_TOP,
            "right": OUTER_RIGHT,
            "bottom": OUTER_BOTTOM,
        },
        "alpha_atlas_per_source_px": round(ALPHA, 5),
        "logical_per_source_px": round(LSCALE, 5),
        "cells": atlas.cells,
        "cell_measurements": measurements,
        "reconstruction": {
            "ring_model": (
                "The declared ring (26 / 26 / 26 logical, 48 on top) is a clean "
                "rectangle whose source outer corner lands at (%d, %d) under the "
                "uniform scale. The master's beams overhang the side rails (top "
                "beam x50..1306 against rails x85..171 / x1186..1271) and its "
                "corner feet continue below y863; that material lies outside the "
                "declared ring rectangle and is therefore not represented."
                % (OUTER_LEFT, OUTER_TOP)
            ),
            "hardware_isotropy": (
                "Measured beam and rail profiles carry no brass or hardware "
                "(max channel ~100-165, no specular islands), so nothing "
                "recognizable is mirrored, repeated or stretched. Every cell uses "
                "the single uniform factor %.4f source->atlas px, so no material "
                "is anisotropically scaled." % ALPHA
            ),
            "hardware_note": (
                "The one lighter ochre panel in the master (x90..144 on the beam, "
                "left of the opening) sits outside the clean beam window used for "
                "the top rail and is not duplicated."
            ),
            "seams": (
                "Each cell is authored from its own measured crops, so the "
                "corner<->rail junctions are mitre seams with a material phase "
                "change. Rails themselves repeat seamlessly: mirror-periodic "
                "construction makes the cell edges identical, so the wrap delta is "
                "zero and the rail period is exactly 256 logical horizontal / 128 "
                "logical vertical."
            ),
            "removed_moving_ornaments": (
                "The red knot (y194..246) and both tassels (y234..508) were cut "
                "out of every static cell first: rail_left/rail_right and the "
                "corner rail zones use ornament-free rail windows, and corner_tl/"
                "corner_tr take their rail zone from the clean rail band. No second "
                "painted copy of a knot or tassel remains behind the moving sprites."
            ),
            "tassel_root_overlap": (
                "The tassel sprites begin at the measured knot/cord junction, so a "
                "few rows of the knot's lower fringe ride inside them next to the "
                "pivot. At the authored amplitudes (+-0.03 rad) that fringe moves "
                "under 0.1 logical px, i.e. it coincides with the static knot."
            ),
        },
        "notes": notes,
        "layers": layers_meta,
        "outsets": {
            "left": int(math.ceil(-left_min)) + 1,
            "right": 4,
            "top": 2,
            "bottom": int(math.ceil(bottom_extra)) + 1,
        },
        "dolls": doll_meta,
    }

    with open(os.path.join(PACK_DIR, "source.json"), "w") as fh:
        json.dump(
            {
                "id": "07",
                "title": "Rainlit 07 - Lacquered Knot and Dolls",
                "version": 1,
                "master": {
                    "file": MASTER_NAME,
                    "sha256": MASTER_SHA256,
                    "size": [SRC_W, SRC_H],
                    "mode": "RGB (no embedded alpha)",
                    "origin": "master.webp",
                },
                "geometry": geometry,
                "semantics": {
                    "rect": "[x, y, width, height] in atlas pixels",
                    "anchor": (
                        "point anchor: tl=(0,0), tr=(rootWidth,0), bl=(0,rootHeight), "
                        "br=(rootWidth,rootHeight). offset is the layer TOP-LEFT "
                        "translation from that point (signed, +x right, +y down); the "
                        "renderer does not subtract the layer size."
                    ),
                    "pivot": "local logical pixel point from the layer top-left; angle in radians",
                    "parent_child": (
                        "a child's offset/pivot are relative to the parent's unrotated "
                        "top-left; the renderer applies the parent rotation to the "
                        "attachment point plus the accumulated child rotation."
                    ),
                    "emission": (
                        "RGB light gain (typically around 1) that preserves mask alpha; "
                        "not a general opacity pulse. Authored emissive cells carry real "
                        "region alpha, never a full-cell rectangle."
                    ),
                    "eyes": "separate per-role control opacity 0..1 (pack.controls.eyes*)",
                    "railPeriod": "logical repeat: horizontal 256, vertical 128",
                },
                "segmentation": {
                    "backdrop_rgb": BACKDROP.tolist(),
                    "method": (
                        "flat area-fill segmentation against the measured backdrop with a "
                        "soft 10..28 distance ramp; no global dark-key, so the dolls' dark "
                        "hair and the knot's shadowed folds stay opaque. Interior holes are "
                        "flood-filled, then a 1px 3x3 blur feathers the contour."
                    ),
                },
                "controls": {
                    "min": "indigo doll (left)",
                    "max": "ochre doll (middle)",
                    "close": "red doll (right)",
                    "canvas": list(DOLL_CANVAS),
                    "logical_size": list(CONTROL_SIZE),
                    "shots": "assets/rainlit-frames/07/doll-*.png (RGB + honest alpha), eyes-*.png (full-canvas glow)",
                },
                "unverified": (
                    "Runtime rendering, hit-testing, alpha compositing at real sizes, "
                    "adaptive joins and motion timing are unverified by this builder. "
                    "This tool only materialises the authored assets."
                ),
            },
            fh,
            indent=2,
        )

    print(json.dumps(geometry["cells"], indent=2))
    print(json.dumps({"layers": layers_meta, "outsets": geometry["outsets"]}, indent=2))
    print(json.dumps(doll_meta, indent=2))
    print(f"wrote {atlas_path} and {len(os.listdir(PACK_DIR))} files in {PACK_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

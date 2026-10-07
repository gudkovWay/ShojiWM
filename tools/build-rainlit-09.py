#!/usr/bin/env python3
"""Author the rainlit frame pack 09 (rain charms + folded-paper garlands).

Reproducible materialisation of `packages/config/assets/rainlit-frames/09/`
from the pack's shipped `master.webp`.

This is an AUTHORING tool, not a test. It reads the frozen master, derives a
semantic alpha from the master's flat backdrop, cuts the neutral structural
transverse profiles, the four one-shot corners, the fixed bamboo blind and the
three cloth charms / three paper cranes (each cell carrying its own continuous
connector), and packs a 2048x2048 straight-RGBA atlas plus honest provenance.

Geometry is expressed in source pixels and converted to logical pixels with a
per-axis scale so that the declared 26px native inset equals the master's own
rail thickness. 4 atlas px per logical px is the frozen atlas scale.

Run:  python3 tools/build-rainlit-09.py
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PACK_DIR = os.path.join(REPO, "packages", "config", "assets", "rainlit-frames", "09")
MASTER_SHIPPED = os.path.join(PACK_DIR, "master.webp")

ATLAS_PX = 2048
ATLAS_SCALE = 4.0  # atlas pixels per logical pixel (frozen)

# --- measured master geometry (source pixels) -----------------------------
ORIGIN_X, ORIGIN_Y = 141.0, 119.0          # master frame outer top-left
RING_SRC_X, RING_SRC_Y = 80.0, 83.0        # left / top rail thickness in px
SX = RING_SRC_X / 26.0                     # source px per logical px, x axis
SY = RING_SRC_Y / 26.0                     # source px per logical px, y axis
OPENING_SRC = (221, 202, 1318, 796)        # left, top, right, bottom
FRAME_W = int(round((1397 - ORIGIN_X) / SX))  # 408
FRAME_H = int(round((886 - ORIGIN_Y) / SY))   # 240

# --- structural (rail) source windows, chosen to contain no ornament ------
TOP_RAIL_SRC = (600, 119, 1380, 202)
BOTTOM_RAIL_SRC = (600, 796, 1300, 886)
LEFT_RAIL_SRC = (141, 202, 221, 796)
RIGHT_RAIL_SRC = (1318, 202, 1397, 796)

# --- atlas layout: one cell per drawn surface ------------------------------
# Row 0..728 holds only the repeating rails and the one-shot corners. Every
# ornament cell is packed on its own row below the rail block (y=736) with a
# 10px gutter, so no ornament cell overlaps a rail and no two cells overlap.
# (id, x, y, w, h, king)
LAYOUT = [
    ("rail_top", 0, 0, 1024, 104, "rail"),
    ("rail_bottom", 0, 108, 1024, 104, "rail"),
    ("rail_left", 0, 216, 104, 512, "rail"),
    ("rail_right", 108, 216, 104, 512, "rail"),
    ("corner_tl", 216, 216, 168, 168, "corner"),
    ("corner_tr", 388, 216, 168, 168, "corner"),
    ("corner_bl", 560, 216, 168, 168, "corner"),
    ("corner_br", 732, 216, 168, 168, "corner"),
    ("bamboo", 0, 736, 562, 152, "layer"),
    ("mount_left", 572, 736, 96, 48, "layer"),
    ("mount_right", 678, 736, 71, 53, "layer"),
    ("fabric_1", 759, 736, 139, 256, "layer"),
    ("fabric_2", 908, 736, 139, 215, "layer"),
    ("fabric_3", 1057, 736, 139, 226, "layer"),
    ("crane_1", 1206, 736, 151, 205, "layer"),
    ("crane_2", 1367, 736, 151, 150, "layer"),
    ("crane_3", 1528, 736, 151, 153, "layer"),
]

# --- layer source boxes + chain attach points (source pixels) --------------
# box = (x0, y0, x1, y1); pivot = attachment point inside the box.
LAYERS = {
    "bamboo": {"box": (150, 85, 582, 206), "pivot": None},
    "mount_left": {"box": (64, 120, 138, 168), "pivot": None},
    "mount_right": {"box": (1398, 118, 1452, 160), "pivot": None},
    "fabric_1": {"box": (30, 168, 137, 372), "pivot": (88, 168)},
    "fabric_2": {"box": (30, 368, 137, 540), "pivot": (88, 368)},
    "fabric_3": {"box": (30, 536, 137, 716), "pivot": (85, 536)},
    "crane_1": {"box": (1400, 152, 1516, 316), "pivot": (1436, 152)},
    "crane_2": {"box": (1400, 312, 1516, 432), "pivot": (1448, 312)},
    "crane_3": {"box": (1400, 430, 1516, 552), "pivot": (1449, 430)},
}

PARENT = {
    "fabric_2": "fabric_1",
    "fabric_3": "fabric_2",
    "crane_2": "crane_1",
    "crane_3": "crane_2",
}

# Root anchor per layer (children inherit the parent-local frame, not an
# anchor). The two right-hand roots are anchored to the source outer right
# edge, so the runtime's tr anchor keeps them attached to the real window
# width instead of a frozen 408px design width.
FRAME_RIGHT_SRC = 1397.0
ANCHOR = {
    "mount_right": "tr",
    "crane_1": "tr",
}

CELL_BY_ID = {c[0]: c for c in LAYOUT}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_arr(arr: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(arr).tobytes()).hexdigest()


# --- connected components (runs + union-find), no scipy --------------------
def label_components(binary: np.ndarray):
    H, W = binary.shape
    parent: dict[int, int] = {}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    labels_per_row = []
    prev = []
    nxt = 0
    for y in range(H):
        row = binary[y]
        d = np.diff(row.astype(np.int8))
        starts = (np.where(d == 1)[0] + 1).tolist()
        ends = (np.where(d == -1)[0] + 1).tolist()
        if row[0]:
            starts.insert(0, 0)
        if row[-1]:
            ends.append(W)
        cur = []
        for s, e in zip(starts, ends):
            overlap = [pl for (ps, pe, pl) in prev if ps < e and s < pe]
            if overlap:
                lab = min(overlap)
                for o in overlap:
                    union(lab, o)
            else:
                lab = nxt
                parent[lab] = lab
                nxt += 1
            cur.append((s, e, lab))
        labels_per_row.append(cur)
        prev = cur

    out = np.full((H, W), -1, dtype=np.int32)
    for y, cur in enumerate(labels_per_row):
        for s, e, lab in cur:
            out[y, s:e] = find(lab)
    return out


def erode(mask: np.ndarray, iters: int) -> np.ndarray:
    m = mask.copy()
    for _ in range(iters):
        e = np.zeros_like(m)
        e[1:, 1:] = m[1:, 1:] & m[:-1, 1:] & m[1:, :-1] & m[:-1, :-1]
        m = e
    return m


def semantic_alpha(rgb: np.ndarray, bg: np.ndarray, opening_yx: tuple[int, int]):
    """Alpha from backdrop connectivity, not from a global luminance key.

    Pixels close to the flat backdrop are transparent only when they belong to
    the outside border component or to the protected opening component.  Dark
    painted parts enclosed by an object (fabric folds, painted faces, the
    shadowed underside of the folded paper) stay opaque.
    """
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    near = dist < 10.0
    lab = label_components(near)

    flat = lab[lab >= 0]
    counts = np.bincount(flat, minlength=int(lab.max()) + 1)
    sums = np.bincount(flat, weights=dist[lab >= 0], minlength=int(lab.max()) + 1)
    means = sums / np.maximum(counts, 1)

    # A near-backdrop pocket is genuine transparency when its own mean colour is
    # essentially the flat backdrop; painted darks (fabric folds, the shadowed
    # underside of the blind) sit near the tolerance edge and stay opaque.
    bg_ids = np.where((means < 5.0) & (counts >= 24))[0]
    opening_label = int(lab[opening_yx[0], opening_yx[1]])
    if opening_label >= 0 and opening_label not in bg_ids:
        bg_ids = np.append(bg_ids, opening_label)
    back = near & np.isin(lab, bg_ids)

    solid = ~back
    core = erode(solid, 2)
    alpha = np.zeros(rgb.shape[:2], dtype=np.float32)
    alpha[core] = 1.0
    edge = solid & ~core
    ramp = np.clip((dist[edge] - 3.0) / 17.0, 0.0, 1.0)
    alpha[edge] = ramp
    # Feather the hard binary contour one subpixel so painted edges stay soft.
    aimg = Image.fromarray((np.clip(alpha, 0, 1) * 255.0 + 0.5).astype(np.uint8), "L")
    aimg = aimg.filter(ImageFilter.GaussianBlur(0.7))
    return np.asarray(aimg).astype(np.float32) / 255.0


def resize_rgba(rgb: np.ndarray, alpha: np.ndarray, w: int, h: int):
    pm = np.dstack([rgb * alpha[..., None], alpha])
    img = Image.fromarray((np.clip(pm, 0, 1) * 255.0 + 0.5).astype(np.uint8), "RGBA")
    img = img.resize((w, h), Image.LANCZOS)
    out = np.asarray(img).astype(np.float32) / 255.0
    a = np.clip(out[..., 3], 0.0, 1.0)
    c = np.where(a[..., None] > 1e-6, out[..., :3] / np.maximum(a[..., None], 1e-6), 0.0)
    return np.clip(c, 0.0, 1.0), a


def make_periodic_x(rgb: np.ndarray, a: np.ndarray, k: int = 56):
    r, g = rgb.copy(), a.copy()
    ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)[None, :, None]
    rgb[:, -k:, :] = rgb[:, -k:, :] * (1.0 - ramp) + rgb[:, :k, :] * ramp
    a[:, -k:] = a[:, -k:] * (1.0 - ramp[:, :, 0]) + a[:, :k] * ramp[:, :, 0]
    return rgb, a


def make_periodic_y(rgb: np.ndarray, a: np.ndarray, k: int = 56):
    ramp = np.linspace(0.0, 1.0, k, dtype=np.float32)[:, None, None]
    rgb[-k:, :, :] = rgb[-k:, :, :] * (1.0 - ramp) + rgb[:k, :, :] * ramp
    a[-k:, :] = a[-k:, :] * (1.0 - ramp[:, :, 0]) + a[:k, :] * ramp[:, :, 0]
    return rgb, a


def logical_x(px: float) -> float:
    return (px - ORIGIN_X) / SX


def logical_y(px: float) -> float:
    return (px - ORIGIN_Y) / SY


def r3(v: float) -> float:
    return round(float(v), 3)


def main() -> int:
    master_path = MASTER_SHIPPED
    if not os.path.exists(master_path):
        print(f"master not found: {master_path}", file=sys.stderr)
        return 2
    master = Image.open(master_path).convert("RGB")
    rgb = np.asarray(master).astype(np.float32)
    H, W, _ = rgb.shape
    if (W, H) != (1536, 1024):
        print(f"unexpected master size {W}x{H}", file=sys.stderr)
        return 2

    corners = np.concatenate(
        [rgb[0:8, 0:8].reshape(-1, 3), rgb[0:8, -8:].reshape(-1, 3),
         rgb[-8:, 0:8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3)]
    )
    bg = np.median(corners, axis=0)
    opening_yx = (500, 700)
    alpha = semantic_alpha(rgb, bg, opening_yx)
    # resize_rgba premultiplies and clamps to 0..1, so it needs float RGB in
    # 0..1: segmentation above stays in byte space, then the colour handed to
    # the resampler is normalized. Without this every opaque channel saturates
    # to 255 and the shipped rails/charms/cranes come out white.
    rgb = rgb / 255.0

    atlas = np.zeros((ATLAS_PX, ATLAS_PX, 4), dtype=np.float32)

    def put(cell_id: str, r: np.ndarray, a: np.ndarray) -> None:
        _, x, y, w, h, _ = CELL_BY_ID[cell_id]
        if r.shape[0] != h or r.shape[1] != w:
            raise ValueError(f"{cell_id}: content {r.shape[:2]} != cell {(h, w)}")
        atlas[y:y + h, x:x + w, :3] = r
        atlas[y:y + h, x:x + w, 3] = a

    # --- neutral structural rails (repeating, no ornament copies) ----------
    tr = resize_rgba(*slice_src(rgb, alpha, TOP_RAIL_SRC), 1024, 104)
    tr = make_periodic_x(*tr)
    put("rail_top", *tr)

    br = resize_rgba(*slice_src(rgb, alpha, BOTTOM_RAIL_SRC), 1024, 104)
    br = make_periodic_x(*br)
    put("rail_bottom", *br)

    lr = resize_rgba(*slice_src(rgb, alpha, LEFT_RAIL_SRC), 104, 512)
    lr = make_periodic_y(*lr)
    put("rail_left", *lr)

    rr = resize_rgba(*slice_src(rgb, alpha, RIGHT_RAIL_SRC), 104, 512)
    rr = make_periodic_y(*rr)
    put("rail_right", *rr)

    # --- four one-shot corners ---------------------------------------------
    cw, ch = 42.0 * SX, 42.0 * SY
    corner_src = {
        "corner_tl": (ORIGIN_X, ORIGIN_Y, ORIGIN_X + cw, ORIGIN_Y + ch),
        "corner_tr": (1397 - cw, ORIGIN_Y, 1397.0, ORIGIN_Y + ch),
        "corner_bl": (ORIGIN_X, 886 - ch, ORIGIN_X + cw, 886.0),
        "corner_br": (1397 - cw, 886 - ch, 1397.0, 886.0),
    }
    for cid, box in corner_src.items():
        put(cid, *resize_rgba(*slice_src(rgb, alpha, box), 168, 168))

    # --- fixed ornaments and moving chain segments -------------------------
    for lid, spec in LAYERS.items():
        _, _, _, cwid, chei, _ = CELL_BY_ID[lid]
        put(lid, *resize_rgba(*slice_src(rgb, alpha, spec["box"]), cwid, chei))

    # --- finalise atlas / provenance --------------------------------------
    atlas[atlas[..., 3] < 1.0 / 255.0] = 0.0
    rgb8 = (np.clip(atlas[..., :3], 0, 1) * 255.0 + 0.5).astype(np.uint8)
    a8 = (np.clip(atlas[..., 3], 0, 1) * 255.0 + 0.5).astype(np.uint8)
    atlas_img = Image.fromarray(np.dstack([rgb8, a8]), "RGBA")
    os.makedirs(PACK_DIR, exist_ok=True)
    atlas_path = os.path.join(PACK_DIR, "frame-atlas.png")
    atlas_img.save(atlas_path)

    layers_json = build_layers_json()
    source = {
        "pack": "09",
        "title": "Rain Charms & Paper Garlands",
        "version": 1,
        "generation": {
            "provider": "openai-codex",
            "model": "gpt-image-2-codex",
            "catalog": "openai-codex/gpt-image-2",
            "phase": "painterly",
        },
        "source": {
            "master": "master.webp",
            "master_sha256": sha256_file(MASTER_SHIPPED),
            "master_size": [1536, 1024],
            "approved_master": "master.webp",
            "approved_master_sha256": sha256_file(MASTER_SHIPPED),
            "alpha_authority": (
                "measured: no embedded alpha in the RGB master; alpha derived from "
                "backdrop connectivity (background/opening components of the flat "
                "backdrop colour are transparent, enclosed painted darks stay opaque). "
                "No global dark-key."
            ),
            "backdrop_rgb": [r3(bg[0]), r3(bg[1]), r3(bg[2])],
            "alpha_source_sha256": sha256_arr((alpha * 255).astype(np.uint8)),
            "alpha_range": [
                r3(float(alpha.min())),
                r3(float(alpha.max())),
            ],
        },
        "outputs": {
            "frame_atlas": "frame-atlas.png",
            "frame_atlas_sha256": sha256_file(atlas_path),
            "frame_atlas_size": [ATLAS_PX, ATLAS_PX],
            "frame_atlas_alpha": "straight RGBA; RGB zeroed exactly where alpha is zero",
            "master_copy": "master.webp",
            "master_copy_sha256": sha256_file(MASTER_SHIPPED),
        },
        "geometry": {
            "master_origin_px": [ORIGIN_X, ORIGIN_Y],
            "source_px_per_logical": {"x": r3(SX), "y": r3(SY)},
            "atlas_px_per_logical": ATLAS_SCALE,
            "opening_source_px": list(OPENING_SRC),
            "frame_logical": [FRAME_W, FRAME_H],
            "insets_logical": {"left": 26, "right": 26, "top": 26, "bottom": 26},
            "minimum_root_logical": [240, 240],
            "outsets_logical": {"left": 48, "right": 52, "top": 14, "bottom": 4},
            "sweep_budget_note": (
                "the left cloth chain reaches y ~= 187 logical at rest (fabric heads "
                "15.349 + 62.651 + 52.627, fabric-3 body 56.386) and swings to x ~= "
                "-44 at the 1x gust peak; the right paper chain swings to x ~= "
                "rootWidth + 48. The declared minimum root (240x240) contains the full "
                "vertical sweep when the ornament scale is 1, and the outsets (left 48, "
                "right 52) cover the full horizontal swing of both chains. Core scales "
                "ornament sizes/pivots/offsets by s = min(1, W/minW, H/minH), so the "
                "declared 240x240 support is truthful and smaller sizes are bounded "
                "rather than cropped."
            ),
            "root_anchor_note": (
                "left-hand roots anchor to tl; mount_right and crane_1 anchor to tr "
                "with offsets measured from the source outer right edge (logical 408.2), "
                "so they track the actual window width; cranes 2/3 keep parent-local "
                "offsets."
            ),
            "note": (
                "per-axis scale maps the master's own 80px left / 83px top rail to the "
                "declared 26px native inset; the right/bottom source rails are 79/90px "
                "so the drawn ring is a uniform 26 and the rail cells resample the real "
                "transverse profile."
            ),
        },
        "layer_transform_semantics": {
            "anchor": "point: tl=(0,0), tr=(rootWidth,0), bl=(0,rootHeight), br=(rootWidth,rootHeight)",
            "offset": "layer top-left translation from the anchor point, signed +x right / +y down",
            "pivot": "local logical point from the layer's own top-left; angle in radians",
            "parent": "child offset/pivot are relative to the parent's unrotated top-left; the renderer applies the parent rotation to the attachment point plus the accumulated child rotation",
            "rail_period_logical": {"horizontal": 256, "vertical": 128},
            "emission_channel": "RGB light gain preserving the mask alpha (paper face / slits), not opacity",
        },
        "rails": {
            "top": list(TOP_RAIL_SRC),
            "bottom": list(BOTTOM_RAIL_SRC),
            "left": list(LEFT_RAIL_SRC),
            "right": list(RIGHT_RAIL_SRC),
            "endpoint_method": (
                "each rail is a real source transverse profile resampled to the common "
                "cell; the tail is cross-faded into the head over 56 px so the repeat is "
                "seam-free. Rails are cut from ornament-free source spans, so no charm, "
                "crane or bamboo copy is baked into a repeating cell."
            ),
        },
        "corners": {
            "size": 168,
            "source_windows": {k: [r3(v) for v in b] for k, b in corner_src.items()},
            "note": (
                "four one-shot source-derived corner regions; never repeated. The "
                "top-left window also contains the fixed bamboo blind, which its own "
                "fixed layer redraws at the same source alignment on top, so no moving "
                "ornament is duplicated and no ornament is baked into a repeating rail"
            ),
        },
        "resampling": "premultiplied LANCZOS; straight RGB restored on write",
        "cells": {c[0]: {"atlas": [c[1], c[2], c[3], c[4]]} for c in LAYOUT},
        "layers": layers_json,
        "omitted_source_objects": [
            "the concept's lower-right/bottom exterior feet stay inside the corner cells; "
            "no ornament was replaced by a painted liner or padding",
        ],
        "not_claimed": (
            "runtime placement, hit-testing, alpha compositing, adaptive joins and "
            "all-size behaviour are unverified; this file is provenance plus authored "
            "geometry, not a renderer proof"
        ),
        "builder": "tools/build-rainlit-09.py",
    }
    with open(os.path.join(PACK_DIR, "source.json"), "w") as fh:
        json.dump(source, fh, indent=2)
        fh.write("\n")

    print("built", atlas_path)
    print("cells:", json.dumps({c[0]: [c[1], c[2], c[3], c[4]] for c in LAYOUT}))
    print("layers:", json.dumps(layers_json, indent=2))
    return 0


def slice_src(rgb, alpha, box):
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
    return rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]


def build_layers_json():
    out = {}
    for lid, spec in LAYERS.items():
        x0, y0, x1, y1 = spec["box"]
        parent = PARENT.get(lid)
        anchor = ANCHOR.get(lid, "tl")
        if parent is None:
            ox, oy = logical_x(x0), logical_y(y0)
            if anchor == "tr":
                # measured from the source outer right edge (declared root right)
                ox -= logical_x(FRAME_RIGHT_SRC)
        else:
            px0, py0 = LAYERS[parent]["box"][:2]
            ox, oy = (x0 - px0) / SX, (y0 - py0) / SY
        entry = {
            "anchor": anchor,
            "source_box": [x0, y0, x1, y1],
            "offset": [r3(ox), r3(oy)],
            "size": [r3((x1 - x0) / SX), r3((y1 - y0) / SY)],
        }
        if spec["pivot"] is not None:
            pvx, pvy = spec["pivot"]
            entry["pivot"] = [r3((pvx - x0) / SX), r3((pvy - y0) / SY)]
        if parent:
            entry["parent"] = parent
        out[lid] = entry
    return out


if __name__ == "__main__":
    sys.exit(main())

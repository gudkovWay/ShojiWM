#!/usr/bin/env python3
"""Reproducible authoring of the rainlit frame pack 06 (bronze / celadon / lamp).

Product deliverable for `packages/config/assets/rainlit-frames/06/`:

    frame-atlas.png   the real RGBA 2048x2048 atlas consumed by the native frame
                      renderer through `FramePack.atlas`
    master.webp       frozen byte copy of the approved painterly master
    source.json       measured cut map, alpha authority, cell table, provenance

This is an *authoring* tool, not a test: it reads the approved 1536x1024 RGB
master (no embedded alpha), measures the frame geometry from the pixels,
derives honest alpha by segmentation, repairs the rounded inner opening to the
square material-supported contour the native 26 px ring needs, extracts the
paper pendant + thread and the celadon lamp as independent cells, and packs
them into one atlas with transparent gutters.

Master identity (frozen):
    06-painterly.webp
    sha256 e0b3d26b0f68cb9cf96158d884a5568a87487f2c5f9bb5649671f7a610cf7cec

Geometry, cell rectangles and logical sizes are printed by `--report` and must
match `packages/config/src/effect/rainlit/frame-06.ts` (FRAME_06). Runtime
rendering, seams, hit-testing and visual acceptance remain unverified.

Only Pillow + NumPy are used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
PACK_DIR = REPO / "packages/config/assets/rainlit-frames/06"
MASTER_SHA256 = "e0b3d26b0f68cb9cf96158d884a5568a87487f2c5f9bb5649671f7a610cf7cec"
MASTER_SIZE = (1536, 1024)

ATLAS_PX = 2048
ATLAS_SCALE = 4          # atlas pixels per logical pixel
GUTTER = 2               # >= 2 transparent atlas pixels between cells
RING_LOGICAL = 26        # native material ring on every side (top 26 for 06)
CORNER_LOGICAL = 42      # one-shot corner cap canvas in logical px

RAIL_TOP_PX = (1024, 104)          # 256 x 26 logical
RAIL_SIDE_PX = (104, 512)          # 26 x 128 logical
CORNER_PX = 168                    # 42 x 42 logical

# Ornament logical scale: source master pixels per logical pixel. The four
# measured ring bands are 49/49/43/43 source px for 26 logical px
# (1.885/1.885/1.654/1.654); ornaments use their mean so their own art is
# rescaled isotropically (no invented distortion of the sculpture).
ORN_SRC_PER_LOGICAL = 1.78

# ---------------------------------------------------------------------------
# atlas cell table (atlas x, y, w, h). No two cells overlap; >= 2 px gutter.
# ---------------------------------------------------------------------------
CELLS = {
    "rail_top":    (0, 0, *RAIL_TOP_PX),
    "rail_bottom": (0, 108, *RAIL_TOP_PX),
    "rail_left":   (0, 216, *RAIL_SIDE_PX),
    "rail_right":  (108, 216, *RAIL_SIDE_PX),
    "corner_tl":   (0, 732, CORNER_PX, CORNER_PX),
    "corner_tr":   (172, 732, CORNER_PX, CORNER_PX),
    "corner_bl":   (0, 904, CORNER_PX, CORNER_PX),
    "corner_br":   (172, 904, CORNER_PX, CORNER_PX),
    "pendant_hook": (344, 732, 92, 204),
    "pendant":      (344, 940, 132, 500),
    "lamp":         (480, 732, 368, 624),
    "lamp_slits":   (852, 732, 368, 624),
    "lamp_sheen":   (1224, 732, 368, 624),
}

# Source crops in master pixels. Rails/corners are measured; ornament crops
# were located from the measured silhouette components recorded in source.json.
RAIL_TOP_SPAN = (230, 1180)
RAIL_BOTTOM_SPAN = (250, 1200)
RAIL_LEFT_SPAN = (220, 760)
RAIL_RIGHT_SPAN = (281, 670)

ORN_HOOK_SRC = (82, 114, 122, 205)
ORN_PENDANT_SRC = (60, 145, 118, 368)
ORN_LAMP_SRC = (1362, 648, 1526, 926)   # right of the measured rail outer edge (1361)

ORNAMENT_THRESH = 45
FILAMENT_THRESH = 40     # thin cord / bracket pixels
MIN_COMPONENT = 12


# ---------------------------------------------------------------------------
# small image helpers
# ---------------------------------------------------------------------------
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_master() -> tuple[np.ndarray, str]:
    """Return the shipped canonical master as float RGB and its hash."""
    PACK_DIR.mkdir(parents=True, exist_ok=True)
    shipped = PACK_DIR / "master.webp"
    if not shipped.exists():
        sys.exit(f"master not found: {shipped}")
    digest = sha256(shipped)
    if digest != MASTER_SHA256:
        sys.exit(f"master hash mismatch for {shipped}: {digest}")
    img = Image.open(shipped).convert("RGB")
    if img.size != MASTER_SIZE:
        sys.exit(f"unexpected master size {img.size}, want {MASTER_SIZE}")
    return np.asarray(img).astype(np.float32), digest


def lum(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def warmth(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] - rgb[..., 2]


def _shift(mask: np.ndarray, dy: int, dx: int) -> np.ndarray:
    out = np.zeros_like(mask)
    h, w = mask.shape
    ys0, ys1 = max(0, dy), min(h, h + dy)
    xs0, xs1 = max(0, dx), min(w, w + dx)
    out[ys0:ys1, xs0:xs1] = mask[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
    return out


def dilate(mask: np.ndarray, k: int = 1) -> np.ndarray:
    m = mask.copy()
    for _ in range(k):
        acc = m.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc = acc | _shift(m, dy, dx)
        m = acc
    return m


def erode(mask: np.ndarray, k: int = 1) -> np.ndarray:
    return ~dilate(~mask, k)


def components(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """Connected components (4-connectivity): (area, x0, y0, x1, y1)."""
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    out: list[tuple[int, int, int, int, int]] = []
    cur = 0
    for i in range(h):
        row = mask[i]
        for j in range(w):
            if row[j] and lab[i, j] == 0:
                cur += 1
                q = deque([(i, j)])
                lab[i, j] = cur
                n = 0
                x0 = x1 = j
                y0 = y1 = i
                while q:
                    y, x = q.popleft()
                    n += 1
                    x0 = min(x0, x); x1 = max(x1, x)
                    y0 = min(y0, y); y1 = max(y1, y)
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and lab[ny, nx] == 0:
                            lab[ny, nx] = cur
                            q.append((ny, nx))
                out.append((n, x0, y0, x1, y1))
    out.sort(key=lambda t: -t[0])
    return out


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """Mark fully enclosed background pockets (dark grooves) as material.

    Dark regions touching the crop border are the opening/background and stay
    empty; only enclosed pockets are promoted, so real material shadows are
    never keyed out and the opening is never filled.
    """
    dark = ~mask
    lab = np.zeros(mask.shape, np.int32)
    h, w = mask.shape
    cur = 0
    border_touch = []
    for i in range(h):
        for j in range(w):
            if dark[i, j] and lab[i, j] == 0:
                cur += 1
                q = deque([(i, j)])
                lab[i, j] = cur
                touches = False
                n = 0
                while q:
                    y, x = q.popleft()
                    n += 1
                    if y == 0 or x == 0 or y == h - 1 or x == w - 1:
                        touches = True
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and dark[ny, nx] and lab[ny, nx] == 0:
                            lab[ny, nx] = cur
                            q.append((ny, nx))
                border_touch.append((cur, touches, n))
    filled = mask.copy()
    for cid, touches, _n in border_touch:
        if not touches:
            filled = filled | (lab == cid)
    return filled


def drop_specks(mask: np.ndarray, minimum: int = MIN_COMPONENT) -> np.ndarray:
    keep = np.zeros(mask.shape, bool)
    for area, x0, y0, x1, y1 in components(mask):
        if area >= minimum:
            keep |= (mask & _bbox_mask(mask.shape, x0, y0, x1, y1))
    return keep


def _bbox_mask(shape, x0, y0, x1, y1) -> np.ndarray:
    m = np.zeros(shape, bool)
    m[y0:y1 + 1, x0:x1 + 1] = True
    return m


def inpaint(rgb: np.ndarray, known: np.ndarray, iters: int = 400) -> np.ndarray:
    """Propagate known colours into unknown pixels (edge-extension fill)."""
    col = rgb.astype(np.float32).copy()
    k = known.copy()
    for _ in range(iters):
        if k.all():
            break
        acc = np.zeros_like(col)
        cnt = np.zeros(k.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                sk = _shift(k, dy, dx)
                sc = np.stack([_shift(col[..., c], dy, dx) for c in range(3)], -1)
                acc += sc * sk[..., None]
                cnt += sk
        newly = (~k) & (cnt > 0)
        if not newly.any():
            break
        col[newly] = acc[newly] / cnt[newly][..., None]
        k = k | newly
    return col


def resize_rgba(rgb: np.ndarray, alpha: np.ndarray, size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Alpha-correct resize (premultiplied) to avoid colour fringing."""
    a = np.clip(alpha, 0.0, 1.0)
    pm = rgb * a[..., None]
    pm_img = Image.fromarray(np.clip(pm, 0, 255).astype(np.uint8), "RGB").resize(size, Image.LANCZOS)
    a_img = Image.fromarray((a * 255).astype(np.uint8), "L").resize(size, Image.LANCZOS)
    p = np.asarray(pm_img).astype(np.float32)
    aa = np.asarray(a_img).astype(np.float32) / 255.0
    out = np.zeros_like(p)
    nz = aa > 1e-4
    out[nz] = p[nz] / aa[nz][..., None]
    return np.clip(out, 0, 255), np.clip(aa, 0, 1)


def endpoint_blend(cell: np.ndarray, axis: int, width: int = 48) -> np.ndarray:
    """Cross-fade a cell tail into its head so the rail tiles seamlessly."""
    out = cell.copy()
    n = out.shape[axis]
    if width <= 0 or width * 2 >= n:
        return out
    head = np.take(out, range(width), axis=axis)
    tail_idx = list(range(n - width, n))
    tail = np.take(out, tail_idx, axis=axis)
    shape = [1] * out.ndim
    shape[axis] = width
    w = np.linspace(0.0, 1.0, width).reshape(shape)
    blended = tail * (1.0 - w) + head * w
    sl = [slice(None)] * out.ndim
    sl[axis] = slice(n - width, n)
    out[tuple(sl)] = blended
    return out


# ---------------------------------------------------------------------------
# geometry measurement
# ---------------------------------------------------------------------------
def measure_geometry(rgb: np.ndarray) -> dict:
    h, w, _ = rgb.shape
    l = lum(rgb)
    cx, cy = w / 2.0, h / 2.0
    pts = []
    for k in range(0, 2880):
        th = 2.0 * np.pi * k / 2880.0
        dx, dy = np.cos(th), np.sin(th)
        for r in range(2, 1000):
            x, y = int(round(cx + dx * r)), int(round(cy + dy * r))
            if not (0 <= x < w and 0 <= y < h):
                break
            if l[y, x] >= 58:
                pts.append((th, cx + dx * r, cy + dy * r))
                break
    p = np.array([[t, x, y] for t, x, y in pts])

    cos_t, sin_t = np.cos(p[:, 0]), np.sin(p[:, 0])
    geom = {
        # nearly-horizontal rays measure the vertical edges, nearly-vertical
        # rays measure the horizontal edges; the median rejects the rounded
        # corner rays, which never satisfy the near-axis band.
        "inner_left": float(np.median(p[(cos_t < -0.99) & (np.abs(sin_t) < 0.02)][:, 1])),
        "inner_right": float(np.median(p[(cos_t > 0.99) & (np.abs(sin_t) < 0.02)][:, 1])),
        "inner_top": float(np.median(p[(sin_t < -0.99) & (np.abs(cos_t) < 0.02)][:, 2])),
        "inner_bottom": float(np.median(p[(sin_t > 0.99) & (np.abs(cos_t) < 0.02)][:, 2])),
    }

    def first_bright(vals, lo, hi, thresh=55):
        for i in range(lo, hi):
            if vals[i] >= thresh:
                return i
        return None

    y_mid = int(cy)
    x_mid = 700
    geom["outer_left"] = float(first_bright(l[y_mid], 0, 400))
    geom["outer_right"] = float(w - 1 - first_bright(l[y_mid][::-1], 0, 400))
    geom["outer_top"] = float(first_bright(l[:, x_mid], 0, 400))
    geom["outer_bottom"] = float(h - 1 - first_bright(l[:, x_mid][::-1], 0, 400))

    geom["band_top"] = geom["inner_top"] - geom["outer_top"]
    geom["band_bottom"] = geom["outer_bottom"] - geom["inner_bottom"]
    geom["band_left"] = geom["inner_left"] - geom["outer_left"]
    geom["band_right"] = geom["outer_right"] - geom["inner_right"]
    geom["opening"] = [geom["inner_left"], geom["inner_top"], geom["inner_right"], geom["inner_bottom"]]
    return geom


# ---------------------------------------------------------------------------
# cells
# ---------------------------------------------------------------------------
def rail_cell(rgb: np.ndarray, band, span, horizontal: bool, out_size) -> tuple[np.ndarray, np.ndarray]:
    if horizontal:
        y0, y1 = band
        x0, x1 = span
        crop = rgb[y0:y1, x0:x1]
    else:
        x0, x1 = band
        y0, y1 = span
        crop = rgb[y0:y1, x0:x1]
    alpha = np.ones(crop.shape[:2], np.float32)
    out_rgb, out_a = resize_rgba(crop, alpha, out_size)
    # Finding 19: the repeat runs along the rail's long side — a horizontal
    # rail is height×width×RGB and tiles along axis 1, a vertical rail along
    # axis 0. Blending across the thin cross-section mixed the outer and
    # inner profiles and left the long-axis endpoints mismatched.
    axis = 1 if horizontal else 0
    out_rgb = endpoint_blend(out_rgb, axis)
    return out_rgb, out_a


def corner_cell(rgb: np.ndarray, geom: dict, corner: str) -> tuple[np.ndarray, np.ndarray]:
    """One-shot corner: measured crop, alpha forced to the native square L."""
    lx0 = geom["outer_left"]; ly0 = geom["outer_top"]
    rx0 = geom["outer_right"]; ry0 = geom["outer_bottom"]
    ix0 = geom["inner_left"]; iy0 = geom["inner_top"]
    ix1 = geom["inner_right"]; iy1 = geom["inner_bottom"]
    sx = abs(ix0 - lx0) / RING_LOGICAL        # source px per logical, left side
    sy = abs(iy0 - ly0) / RING_LOGICAL        # source px per logical, top side
    srx = abs(rx0 - ix1) / RING_LOGICAL
    sry = abs(ry0 - iy1) / RING_LOGICAL
    horiz = CORNER_LOGICAL * sx
    vert = CORNER_LOGICAL * sy
    if corner == "tl":
        x0, x1 = int(round(lx0)), int(round(lx0 + horiz))
        y0, y1 = int(round(ly0)), int(round(ly0 + vert))
        arm_x, arm_y = True, True          # material on left (x<=104) and top (y<=104)
    elif corner == "tr":
        x0, x1 = int(round(rx0 - CORNER_LOGICAL * srx)), int(round(rx0))
        y0, y1 = int(round(ly0)), int(round(ly0 + vert))
        arm_x, arm_y = False, True
    elif corner == "bl":
        x0, x1 = int(round(lx0)), int(round(lx0 + horiz))
        y0, y1 = int(round(ry0 - CORNER_LOGICAL * sry)), int(round(ry0))
        arm_x, arm_y = True, False
    else:  # br
        x0, x1 = int(round(rx0 - CORNER_LOGICAL * srx)), int(round(rx0))
        y0, y1 = int(round(ry0 - CORNER_LOGICAL * sry)), int(round(ry0))
        arm_x, arm_y = False, False
    crop = rgb[y0:y1, x0:x1]
    src_l = lum(crop)
    material = src_l >= 48
    material = dilate(erode(material, 1), 1)     # close antialiased rims
    material = fill_holes(material)

    # resize crop to CORNER_PX then build the L mask at cell resolution
    repaired = inpaint(crop, material, iters=600)
    # Finding 6: the freshly reconstructed colour must survive the resize.
    # resize_rgba premultiplies by the mask it is given and zeroes RGB where
    # the resized alpha is zero, so passing the original material mask here
    # discarded the inpainted fillet colour and the later forced-opaque L
    # mask turned those pixels into a black fake band. Resize the repaired
    # RGB with fully opaque coverage, then apply the square opening mask
    # afterwards: the emitted alpha is exactly the L mask, so no rectangular
    # backing or dark liner is produced — every opaque pixel carries real
    # inpainted ceramic/bronze from the master.
    cell_rgb, _ = resize_rgba(repaired, np.ones(crop.shape[:2], np.float32), (CORNER_PX, CORNER_PX))
    yy, xx = np.mgrid[0:CORNER_PX, 0:CORNER_PX]
    inner_px = RING_LOGICAL * ATLAS_SCALE          # 104
    outer_px = CORNER_PX - inner_px                # 64
    L = np.zeros((CORNER_PX, CORNER_PX), bool)
    L |= (xx <= inner_px) if arm_x else (xx >= outer_px)
    L |= (yy <= inner_px) if arm_y else (yy >= outer_px)
    # apply the square opening mask after the resize; RGB is zeroed exactly
    # where alpha is zero so nothing outside the ring leaks colour.
    out_rgb = np.where(L[..., None], cell_rgb, 0.0)
    return out_rgb, L.astype(np.float32)


def ornament_mask(crop: np.ndarray, thresh: float = ORNAMENT_THRESH) -> np.ndarray:
    src_l = lum(crop)
    warm = warmth(crop)
    mask = (src_l >= thresh) | (warm >= 26)
    mask = dilate(erode(mask, 1), 1)
    mask = fill_holes(mask)
    return drop_specks(mask, MIN_COMPONENT)


def ornament_cell(rgb: np.ndarray, src_rect, out_size, thresh=ORNAMENT_THRESH):
    x0, y0, x1, y1 = src_rect
    crop = rgb[y0:y1, x0:x1]
    mask = ornament_mask(crop, thresh)
    return resize_rgba(crop, mask.astype(np.float32), out_size)


def slit_mask(rgb: np.ndarray, src_rect) -> tuple[np.ndarray, list]:
    """The real lit apertures of the ceramic lamp.

    Amber-lit pixels are separated by the lamp's own celadon ribs; no hole
    filling is applied (that would erase the ribs), and components that touch
    the crop border are structural mount material, not apertures.
    """
    x0, y0, x1, y1 = src_rect
    crop = rgb[y0:y1, x0:x1]
    l = lum(crop)
    w = warmth(crop)
    # The painterly lamp face is three vertical lit apertures separated by two
    # celadon ribs. A strict amber threshold is required to keep the ribs; a
    # loose one merges all three into one blob (measured: 3 components at
    # warmth>=70 / lum>=130, 1..2 otherwise).
    amber = (w >= 70) & (l >= 130)
    h, wd = amber.shape
    comps = [c for c in components(amber) if c[0] >= 150]
    rel = np.zeros(amber.shape, np.float32)
    table = []
    peak = max((l[c[2]:c[4] + 1, c[1]:c[3] + 1].mean() for c in comps), default=1.0)

    def near_border(cx0, cy0, cx1, cy1):
        return cx0 <= 4 or cy0 <= 4 or cx1 >= wd - 5 or cy1 >= h - 5

    for area, cx0, cy0, cx1, cy1 in comps:
        structural = near_border(cx0, cy0, cx1, cy1)
        sub = np.zeros(amber.shape, bool)
        sub[cy0:cy1 + 1, cx0:cx1 + 1] = amber[cy0:cy1 + 1, cx0:cx1 + 1]
        local = l[cy0:cy1 + 1, cx0:cx1 + 1]
        # relative brightness of this aperture, 0.55..1.0
        gain = 0.55 + 0.45 * float(np.clip(local.mean() / max(peak, 1e-3), 0.0, 1.0))
        if structural:
            sub[:] = False  # mount material at the crop edge, not an aperture
        rel[sub] = np.maximum(rel[sub], gain)
        table.append({
            "component": [int(cx0), int(cy0), int(cx1), int(cy1)],
            "source_area_px": int(area),
            "touches_crop_border": bool(structural),
            "relative_gain": None if structural else round(gain, 3),
        })
    return rel, table


def sheen_mask(crop: np.ndarray, slits: np.ndarray, lamp_mask: np.ndarray,
               radius: float = 150.0) -> np.ndarray:
    """Weak warm reflection that already exists on the celadon / bronze near
    the lit apertures. Bounded by distance to the apertures and by the lamp
    silhouette, so it is a real local region, never a full rectangle."""
    l = lum(crop)
    w = warmth(crop)
    ys, xs = np.where(slits > 0)
    if len(xs) == 0:
        return np.zeros(slits.shape, np.float32)
    cx, cy = float(xs.mean()), float(ys.mean())
    yy, xx = np.mgrid[0:crop.shape[0], 0:crop.shape[1]]
    dist = np.hypot(xx - cx, yy - cy)
    prox = np.clip(1.0 - dist / radius, 0.0, 1.0) ** 1.5
    base = (~(slits > 0)) & (w >= 10) & (l >= 55) & (l <= 180) & lamp_mask
    base = dilate(erode(base, 1), 1)
    strength = np.clip((w - 8.0) / 40.0, 0.0, 1.0) * np.clip((l - 55.0) / 60.0, 0.0, 1.0)
    return (base * strength * prox * 0.5).astype(np.float32)


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def build(report_only: bool = False) -> dict:
    rgb, master_hash = load_master()
    geom = measure_geometry(rgb)

    atlas = np.zeros((ATLAS_PX, ATLAS_PX, 4), np.float32)
    placed = {}

    def place(name, cell_rgb, cell_a):
        x, y, cw, ch = CELLS[name]
        assert cell_rgb.shape[:2] == (ch, cw), (name, cell_rgb.shape, (cw, ch))
        atlas[y:y + ch, x:x + cw, :3] = cell_rgb
        atlas[y:y + ch, x:x + cw, 3] = cell_a * 255.0
        placed[name] = {
            "rect": [int(x), int(y), int(cw), int(ch)],
            "logical_size": [cw // ATLAS_SCALE, ch // ATLAS_SCALE],
        }

    band = {
        "top": (int(round(geom["outer_top"])), int(round(geom["inner_top"]))),
        "bottom": (int(round(geom["inner_bottom"])), int(round(geom["outer_bottom"]))),
        "left": (int(round(geom["outer_left"])), int(round(geom["inner_left"]))),
        "right": (int(round(geom["inner_right"])), int(round(geom["outer_right"]))),
    }
    r_t = r_b = RAIL_TOP_PX
    r_l = RAIL_SIDE_PX

    place("rail_top", *rail_cell(rgb, band["top"], RAIL_TOP_SPAN, True, (r_t[0], r_t[1])))
    place("rail_bottom", *rail_cell(rgb, band["bottom"], RAIL_BOTTOM_SPAN, True, (r_t[0], r_t[1])))
    place("rail_left", *rail_cell(rgb, band["left"], RAIL_LEFT_SPAN, False, (r_l[0], r_l[1])))
    place("rail_right", *rail_cell(rgb, band["right"], RAIL_RIGHT_SPAN, False, (r_l[0], r_l[1])))
    for cname in ("tl", "tr", "bl", "br"):
        place(f"corner_{cname}", *corner_cell(rgb, geom, cname))

    hook = ornament_cell(rgb, ORN_HOOK_SRC, (92, 204))
    pendant = ornament_cell(rgb, ORN_PENDANT_SRC, (132, 500))
    lamp_crop = rgb[ORN_LAMP_SRC[1]:ORN_LAMP_SRC[3], ORN_LAMP_SRC[0]:ORN_LAMP_SRC[2]]
    lamp_mask = ornament_mask(lamp_crop)
    lamp_rgb, lamp_a = resize_rgba(lamp_crop, lamp_mask.astype(np.float32), (368, 624))
    slits, slit_table = slit_mask(rgb, ORN_LAMP_SRC)
    slits_rgb, slits_a = resize_rgba(lamp_crop, slits, (368, 624))
    sheen = sheen_mask(lamp_crop, slits, lamp_mask)
    sheen_rgb, sheen_a = resize_rgba(lamp_crop, sheen, (368, 624))
    place("pendant_hook", hook[0], hook[1])
    place("pendant", pendant[0], pendant[1])
    place("lamp", lamp_rgb, lamp_a)
    place("lamp_slits", slits_rgb, slits_a)
    place("lamp_sheen", sheen_rgb, sheen_a)

    # zero RGB exactly where alpha is zero
    a = atlas[..., 3:4]
    atlas[..., :3] = np.where(a > 0.0, atlas[..., :3], 0.0)

    if not report_only:
        out = PACK_DIR / "frame-atlas.png"
        Image.fromarray(np.clip(atlas, 0, 255).astype(np.uint8), "RGBA").save(out)
        atlas_hash = sha256(out)
    else:
        atlas_hash = None

    # logical placement of the movable/static ornaments
    def src_to_logical(v, origin):
        return (v - origin) / ORN_SRC_PER_LOGICAL

    fl, ft = geom["outer_left"], geom["outer_top"]
    fr, fb = geom["outer_right"], geom["outer_bottom"]
    hook_off = [round(src_to_logical(ORN_HOOK_SRC[0], fl)), round(src_to_logical(ORN_HOOK_SRC[1], ft))]
    pend_off = [round(src_to_logical(ORN_PENDANT_SRC[0], fl)), round(src_to_logical(ORN_PENDANT_SRC[1], ft))]
    cord_top = (82, 151)
    pend_pivot = [round(src_to_logical(cord_top[0], ORN_PENDANT_SRC[0])),
                  round(src_to_logical(cord_top[1], ORN_PENDANT_SRC[1]))]
    lamp_off = [round(src_to_logical(ORN_LAMP_SRC[0], fr)), round(src_to_logical(ORN_LAMP_SRC[1], fb))]
    lamp_w, lamp_h = CELLS["lamp"][2] // ATLAS_SCALE, CELLS["lamp"][3] // ATLAS_SCALE
    outsets = {
        "left": int(np.ceil(max(0.0, -min(hook_off[0], pend_off[0]))) + 4),
        "right": int(np.ceil(lamp_off[0] + lamp_w)) + 1,
        "top": int(np.ceil(max(0.0, -min(hook_off[1], pend_off[1], 0))) + 1),
        "bottom": int(np.ceil(lamp_off[1] + lamp_h)) + 1,
    }

    result = {
        "geometry": {k: (round(v, 2) if isinstance(v, float) else v) for k, v in geom.items()},
        "band": band,
        "atlas_hash": atlas_hash,
        "master_copy_sha256": master_hash,
        "placed": placed,
        "slit_table": slit_table,
        "hook_offset": hook_off,
        "pendant_offset": pend_off,
        "pendant_pivot": pend_pivot,
        "lamp_offset": lamp_off,
        "outsets": outsets,
    }

    if not report_only:
        write_source_json(geom, placed, slit_table, hook_off, pend_off, pend_pivot, lamp_off, outsets, atlas_hash, master_hash)
    return result


def write_source_json(geom, placed, slit_table, hook_off, pend_off, pend_pivot, lamp_off, outsets, atlas_hash, master_hash):
    doc = {
        "pack": "06",
        "title": "Rainlit bronze, celadon and ceramic lamp",
        "design": {
            "master": "master.webp",
            "generator": {
                "provider": "openai-codex",
                "model": "gpt-image-2-codex",
                "catalog": "openai-codex/gpt-image-2",
                "quality": "low",
                "record": ".superpowers/assets/rainlit-frame-concepts/painterly-generation-record.json",
            },
            "authority": "design refined from the retained 06 bronze/ceramic concept per .superpowers/assets/rainlit-frame-concepts/selection.md",
        },
        "source": {
            "master": "master.webp",
            "master_sha256": master_hash,
            "master_size": list(MASTER_SIZE),
            "master_mode": "RGB",
            "alpha_authority": "none embedded; honest alpha is derived here by semantic segmentation (material vs opening/background) and, for the corners, replaced by the square native L-mask",
            "note": "the approved master is RGB without an alpha channel; the transparent client opening is authored here, not extracted",
        },
        "measured_geometry_px": {
            "note": "measured from the master by radial inner-edge detection and directional scans; NOT certified masks",
            "outer": [round(geom["outer_left"], 1), round(geom["outer_top"], 1),
                      round(geom["outer_right"], 1), round(geom["outer_bottom"], 1)],
            "inner_square": [round(geom["inner_left"], 1), round(geom["inner_top"], 1),
                             round(geom["inner_right"], 1), round(geom["inner_bottom"], 1)],
            "band_thickness": {
                "top": round(geom["band_top"], 1), "bottom": round(geom["band_bottom"], 1),
                "left": round(geom["band_left"], 1), "right": round(geom["band_right"], 1),
            },
            "inner_corner_rounding": {
                "note": "the source painterly master rounds the inner opening at the corners; the inner contour measured by radial rays pulls away from the square corner especially at top-right and bottom-right",
                "corner_repair": "the square native L-mask (26 logical arm) is forced; the rounded fillet and any dark pocket inside the material are filled by edge-extension inpainting from real adjacent material, never by a dark liner or padding",
            },
        },
        "atlas": {
            "cell": "frame-atlas.png",
            "sha256": atlas_hash,
            "size": [ATLAS_PX, ATLAS_PX],
            "scale_px_per_logical": ATLAS_SCALE,
            "gutter_px": GUTTER,
            "alpha": "straight RGBA; RGB zeroed exactly where alpha is zero; transparent gutters",
        },
        "cells": {k: v for k, v in placed.items()},
        "logical_contract": {
            "insets": {"left": RING_LOGICAL, "right": RING_LOGICAL, "top": RING_LOGICAL, "bottom": RING_LOGICAL},
            "outsets": outsets,
            "corner_size": {"top": [42, 42], "bottom": [42, 42]},
            "rail_period": {"horizontal": 256, "vertical": 128},
            "minimum_root": [240, 160],
            "atlas_path": "./assets/rainlit-frames/06/frame-atlas.png",
            "anchor_semantics": "anchor is a frame-corner point; tl=(0,0), tr=(rootWidth,0), bl=(0,rootHeight), br=(rootWidth,rootHeight); offset translates the layer top-left from that point (+x right, +y down, no automatic size subtraction); pivot is a local logical point from the layer top-left; angle is radians",
            "emission_semantics": "the emission channel is an RGB light gain around 1.0 that preserves the overlay mask alpha; overlay cells carry the real region alpha of the lit apertures / material sheen, never a full rectangle",
            "unused_atlas_space": "ignored by the renderer; only the referenced rail/corner/layer cells are drawn",
        },
        "layers": {
            "pendant_hook": {"role": "fixed patinated bracket that the paper pendant hangs from", "offset": hook_off, "logical_size": [23, 51], "static": True},
            "pendant": {"role": "left paper pendant with its cord, pivots about the cord attachment", "offset": pend_off, "logical_size": [33, 125], "pivot": pend_pivot, "angle_channel": "pendant"},
            "lamp": {"role": "celadon ceramic lamp on its existing mount, fixed; the sculpture neither swings nor breathes", "offset": lamp_off, "logical_size": [92, 156], "static": True},
            "lamp_slits": {"role": "emissive overlay: the three real lit apertures of the lamp", "offset": lamp_off, "logical_size": [92, 156], "emission_channel": "slit"},
            "lamp_sheen": {"role": "weak local warm reflection on the celadon and nearby bronze", "offset": lamp_off, "logical_size": [92, 156], "emission_channel": "sheen"},
        },
        "lamp_apertures": {
            "note": "measured amber-lit apertures of the ceramic lamp; each carries its own relative gain so one lamp drives three apertures of different brightness rather than three unrelated lights",
            "crop_origin_px": [ORN_LAMP_SRC[0], ORN_LAMP_SRC[1]],
            "measurement": "warmth(R-B)>=70 and luminance>=130 within the lamp crop; at that threshold the two celadon ribs keep the three apertures separate (a looser threshold merges them into one blob)",
            "components": slit_table,
        },
        "provenance": {
            "builder": "tools/build-rainlit-06.py",
            "source_crops_px": {
                "rail_top_span": list(RAIL_TOP_SPAN), "rail_bottom_span": list(RAIL_BOTTOM_SPAN),
                "rail_left_span": list(RAIL_LEFT_SPAN), "rail_right_span": list(RAIL_RIGHT_SPAN),
                "pendant_hook": list(ORN_HOOK_SRC), "pendant": list(ORN_PENDANT_SRC), "lamp": list(ORN_LAMP_SRC),
            },
            "resampling": "each cell is resized from its measured source span; rails are cross-faded at their longitudinal endpoints so the repeating tile is seamless; ornament art is scaled isotropically at " + str(ORN_SRC_PER_LOGICAL) + " source px per logical px",
            "originals_preserved": "the approved master is retained unchanged as the sibling master.webp and read byte-identically from there",
        },
        "not_claimed": [
            "no embedded alpha existed in the master; derived alpha is a segmentation result and visual correctness is unverified",
            "native render, joins, seams, alpha, hit-testing, adaptive sizing and reduced-motion are unverified",
            "the lamp aperture count and per-aperture gains are measurements of the painterly master, not a claim about any real lamp",
        ],
        "unverified": True,
    }
    (PACK_DIR / "source.json").write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--report", action="store_true", help="measure and print the cut map without writing assets")
    args = ap.parse_args()
    result = build(report_only=args.report)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

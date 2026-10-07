#!/usr/bin/env python3
"""Author the native 120 s "bamboo girl" scene atlas for rainlit pack 02.

Inputs (canonical product copies, shipped under `scene/source/`)
----------------------------------------------------------------
`packages/config/assets/rainlit-frames/02/scene/source/walk-master.webp` and
`packages/config/assets/rainlit-frames/02/scene/source/actions-master.webp`, both
1536x1024 straight-RGBA WebP sheets laid out as 4 columns x 2 rows of
384x512 cells (the model was asked for a 4x2 grid; the production atlas
re-packs the same 16 poses as 4x4).

Both sheets already carry REAL per-pixel alpha: the character silhouette is
the only opaque content and every cell border ring is empty (max 1/255
compression haze, asserted below).  The authoring stage's noisy hidden RGB
under fully transparent pixels is NOT visible material and is preserved
verbatim rather than luminance-keyed, so the near-black hair, the dark navy
kimono and the antialiased hair fringes keep their authored coverage.

Method
------
The builder is deliberately conservative: it never resamples, never keys
luminance, never regenerates artwork.  For every authored frame it

1. crops the authored 384x512 cell from its sheet,
2. measures the frame from the actual alpha channel -- the ground-contact
   baseline (lowest visible row) and the torso centreline (alpha-weighted
   centroid of the band 45%..75% of the frame height),
3. applies ONE whole-sprite integer translation so that every frame shares
   a common ground baseline (y = BASELINE_TARGET) and a common torso
   centreline (x = CELL_W / 2).  Translation only -- no per-frame scale,
   no crop, no warp -- so a rig cannot drift or pop at a row/column seam
   and no finger, hair tip or hem is ever cut,
4. pastes the translated cell into its 4x4 atlas slot with raw pixel copy
   (straight alpha, no blending).

Atlas layout (row-major, index = row*4 + col):
    0..3   walk poses 0..3
    4..7   walk poses 4..7
    8..11  action poses 0..3   (index 11 = the press pose, source action 3)
    12..15 action poses 4..7

The pressed index finger contact is MEASURED on the normalized press cell
(index 11): the leftmost pixel whose alpha reaches ALPHA_VISIBLE, with y
taken as the median of that column's visible pixels.  No anchor, offset or
cell origin is assumed; the value is what the cleaned cell actually shows.

Outputs
-------
product (pack 02, authored assets only):
  packages/config/assets/rainlit-frames/02/scene/character-atlas.png
  packages/config/assets/rainlit-frames/02/scene/source.json      (provenance)
  packages/config/src/effect/rainlit/scene-02-assets.ts           (metadata)

research / review only (never shipped):
  .superpowers/assets/rainlit02-bamboo-girl/scene-02-build.json
  .superpowers/assets/rainlit02-bamboo-girl/scene-02-preview-grey.png
  .superpowers/assets/rainlit02-bamboo-girl/scene-02-preview-checker.png
  .superpowers/assets/rainlit02-bamboo-girl/scene-02-walk.gif
  .superpowers/assets/rainlit02-bamboo-girl/scene-02-action.gif

Run:  python3 tools/build-rainlit-02-scene.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
PACK_DIR = REPO / "packages/config/assets/rainlit-frames/02"
SCENE_DIR = PACK_DIR / "scene"
ATLAS_NAME = "character-atlas.png"
TS_PATH = REPO / "packages/config/src/effect/rainlit/scene-02-assets.ts"
#: canonical shipped character sheets
SOURCE_DIR = SCENE_DIR / "source"
#: authoring review artefacts (previews, GIFs, build record); never shipped
ASSET_DIR = REPO / ".superpowers/assets/rainlit02-bamboo-girl"
BUILD_JSON = ASSET_DIR / "scene-02-build.json"

SHEETS = (
    ("walk", SOURCE_DIR / "walk-master.webp"),
    ("action", SOURCE_DIR / "actions-master.webp"),
)

SHEET_COLS, SHEET_ROWS = 4, 2
CELL_W, CELL_H = 384, 512
ATLAS_COLS, ATLAS_ROWS = 4, 4
ATLAS_SIZE = (CELL_W * ATLAS_COLS, CELL_H * ATLAS_ROWS)

# Atlas index of the authored press pose (source action frame 3).
PRESS_INDEX = 11

# A pixel is "visible" from ~6% coverage up: below that the authoring stage
# only left compression haze, which must not move the measured geometry.
ALPHA_VISIBLE = 16
# Cell border ring above this would mean real artwork bleeding across the
# sheet grid, i.e. a frame that cannot be cut out cleanly.
ALPHA_EDGE = 8

# Torso rows used for the horizontal anchor, as fractions of frame height.
TORSO_BAND = (0.45, 0.75)

# Common normalization targets, in SOURCE pixels inside one 384x512 cell.
CENTERLINE_TARGET = CELL_W // 2
# Baseline target = lowest visible row seen anywhere in the two sheets, so no
# frame has to move up and every frame keeps its full authored sole.
# Measured below and asserted; the frozen value is exported to TypeScript.

# Review-only preview settings.
PREVIEW_GREY = (178, 178, 178)
CHECKER_LIGHT, CHECKER_DARK = (214, 214, 214), (150, 150, 150)
CHECKER_SQUARE = 24
GIF_DURATION_MS = 140


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_sheet(path: Path) -> tuple[np.ndarray, str]:
    """Return (RGBA uint8 array, sha256) of one authored pose sheet."""
    if not path.is_file():
        raise SystemExit(f"missing source sheet: {path}")
    with Image.open(path) as img:
        digest = sha256_file(path)
        rgba = img.convert("RGBA")
        expected = (SHEET_COLS * CELL_W, SHEET_ROWS * CELL_H)
        if rgba.size != expected:
            raise SystemExit(f"{path.name}: expected {expected}, got {rgba.size}")
        return np.asarray(rgba).copy(), digest


def cell_of(sheet: np.ndarray, col: int, row: int) -> np.ndarray:
    return sheet[row * CELL_H : (row + 1) * CELL_H, col * CELL_W : (col + 1) * CELL_W]


def border_ring_max(cell: np.ndarray) -> int:
    alpha = cell[..., 3]
    ring = np.concatenate(
        [alpha[0:2].ravel(), alpha[-2:].ravel(), alpha[:, 0:2].ravel(), alpha[:, -2:].ravel()]
    )
    return int(ring.max())


def measure_frame(cell: np.ndarray) -> dict:
    """Measure one authored cell from its actual alpha channel."""
    alpha = cell[..., 3]
    mask = alpha > ALPHA_VISIBLE
    ys, xs = np.nonzero(mask)
    if not ys.size:
        raise SystemExit("authored cell carries no visible pixels")
    top, bottom = int(ys.min()), int(ys.max())
    height = bottom - top + 1
    y0 = top + int(round(TORSO_BAND[0] * height))
    y1 = top + int(round(TORSO_BAND[1] * height))
    weights = alpha[y0:y1].astype(np.float64)
    columns = weights.sum(axis=0)
    total = columns.sum()
    if total <= 0:
        raise SystemExit("torso band carries no coverage")
    torso_centerline = float((columns * np.arange(CELL_W)).sum() / total)
    return {
        "top": top,
        "bottom": bottom,
        "left": int(xs.min()),
        "right": int(xs.max()),
        "height": height,
        "torso_centerline": round(torso_centerline, 2),
    }


def translate_cell(cell: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """Whole-sprite integer translation with a strict no-clipping guard."""
    alpha = cell[..., 3]
    ys, xs = np.nonzero(alpha > ALPHA_VISIBLE)
    if xs.min() + dx < 0 or xs.max() + dx > CELL_W - 1:
        raise SystemExit(f"horizontal translation {dx} would clip authored pixels")
    if ys.min() + dy < 0 or ys.max() + dy > CELL_H - 1:
        raise SystemExit(f"vertical translation {dy} would clip authored pixels")
    out = np.zeros_like(cell)
    src_y0, src_y1 = max(0, -dy), min(CELL_H, CELL_H - dy)
    src_x0, src_x1 = max(0, -dx), min(CELL_W, CELL_W - dx)
    out[src_y0 + dy : src_y1 + dy, src_x0 + dx : src_x1 + dx] = cell[src_y0:src_y1, src_x0:src_x1]
    return out


def measure_press_contact(cell: np.ndarray) -> tuple[tuple[int, int], list[int]]:
    """Leftmost visible pixel of the normalized press cell, and its column."""
    alpha = cell[..., 3]
    ys, xs = np.nonzero(alpha > ALPHA_VISIBLE)
    contact_x = int(xs.min())
    column = np.nonzero(alpha[:, contact_x] > ALPHA_VISIBLE)[0]
    contact_y = int(np.median(column))
    return (contact_x, contact_y), [int(v) for v in column]


def build_atlas(frames: list[np.ndarray]) -> Image.Image:
    atlas = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    for index, cell in enumerate(frames):
        col, row = index % ATLAS_COLS, index // ATLAS_COLS
        # raw paste: straight-alpha pixel copy, no blending, no resampling
        atlas.paste(Image.fromarray(cell, "RGBA"), (col * CELL_W, row * CELL_H))
    return atlas


def write_metadata_module(atlas_size, cell_size, contact, baseline, source_height) -> None:
    text = f'''/**
 * Frozen atlas metadata for the native 120 s bamboo-girl scene of rainlit
 * frame pack 02.  Shared by the authored motion (`scene-02.ts`), the frame
 * pack (`frame-02.ts`) and the renderer scene stage; nothing here constructs
 * signals, loads assets or compiles effects.
 *
 * GENERATED by tools/build-rainlit-02-scene.py -- do not edit by hand.
 *
 * Coordinate semantics (frozen by the parent batch):
 * - `SCENE_02_ATLAS` is an asset path relative to the config package root,
 *   the same base as every other pack `atlas` path.
 * - Atlas/cell/contact/baseline/sourceHeight values are SOURCE pixels of the
 *   authored 4x4 sheet.  The runtime converts them once by `girlScale`.
 * - Row-major index 0..7 are walk poses, 8..15 are action poses; index 11 is
 *   the press pose.  Every frame is normalized by whole-sprite translation
 *   only (no per-frame rescale): the common ground baseline is
 *   `SCENE_02_BASELINE` and the torso centreline sits at half a cell width.
 */

/** Config-relative path of the 4x4 scene character atlas. */
export const SCENE_02_ATLAS = "./assets/rainlit-frames/02/scene/character-atlas.png";

/** Atlas size in source pixels: 4 columns x 4 rows of `SCENE_02_CELL_SIZE`. */
export const SCENE_02_ATLAS_SIZE = [{atlas_size[0]}, {atlas_size[1]}] as const;

/** One authored frame cell in source pixels. */
export const SCENE_02_CELL_SIZE = [{cell_size[0]}, {cell_size[1]}] as const;

/**
 * Leftmost visible pressed-finger contact of atlas index 11 (the press pose),
 * measured on the normalized cell: x is the first column whose authored alpha
 * reaches visible coverage, y the median visible row of that column.
 */
export const SCENE_02_PRESS_CONTACT = [{contact[0]}, {contact[1]}] as const;

/**
 * Common ground-contact baseline in source pixels, measured from the top of a
 * cell after normalization.  Every frame shares it, so feet never float.
 */
export const SCENE_02_BASELINE = {baseline};

/** Authored cell height in source pixels (`SCENE_02_CELL_SIZE[1]`). */
export const SCENE_02_SOURCE_HEIGHT = {source_height};
'''
    TS_PATH.parent.mkdir(parents=True, exist_ok=True)
    TS_PATH.write_text(text)


def checkerboard(size: tuple[int, int]) -> Image.Image:
    w, h = size
    board = np.zeros((h, w, 3), np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    light = ((yy // CHECKER_SQUARE) + (xx // CHECKER_SQUARE)) % 2 == 0
    board[:] = CHECKER_DARK
    board[light] = CHECKER_LIGHT
    return Image.fromarray(board, "RGB")


def grid_and_labels(sheet: Image.Image, labels: bool) -> Image.Image:
    out = sheet.copy()
    draw = ImageDraw.Draw(out)
    font = ImageFont.load_default(size=20)
    for col in range(1, ATLAS_COLS):
        draw.line([(col * CELL_W, 0), (col * CELL_W, out.height)], fill=(255, 96, 64), width=1)
    for row in range(1, ATLAS_ROWS):
        draw.line([(0, row * CELL_H), (out.width, row * CELL_H)], fill=(255, 96, 64), width=1)
    if labels:
        for index in range(ATLAS_COLS * ATLAS_ROWS):
            col, row = index % ATLAS_COLS, index // ATLAS_COLS
            draw.text((col * CELL_W + 8, row * CELL_H + 8), str(index), fill=(255, 96, 64), font=font)
    return out


def write_previews(atlas: Image.Image) -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    flat = atlas.convert("RGBA")
    grey = Image.new("RGBA", atlas.size, PREVIEW_GREY + (255,))
    grey.alpha_composite(flat)
    grey.convert("RGB").save(ASSET_DIR / "scene-02-preview-grey.png")
    grid_and_labels(grey.convert("RGB"), True).save(ASSET_DIR / "scene-02-preview-grey-labelled.png")
    checker = checkerboard(atlas.size).convert("RGBA")
    checker.alpha_composite(flat)
    checker.convert("RGB").save(ASSET_DIR / "scene-02-preview-checker.png")

    for name, first, last in (("walk", 0, 7), ("action", 8, 15)):
        frames = []
        for index in range(first, last + 1):
            cell = atlas.crop(
                ((index % ATLAS_COLS) * CELL_W, (index // ATLAS_COLS) * CELL_H,
                 (index % ATLAS_COLS) * CELL_W + CELL_W, (index // ATLAS_COLS) * CELL_H + CELL_H)
            )
            plate = Image.new("RGBA", cell.size, PREVIEW_GREY + (255,))
            plate.alpha_composite(cell)
            frames.append(plate.convert("P", palette=Image.ADAPTIVE))
        frames[0].save(
            ASSET_DIR / f"scene-02-{name}.gif",
            save_all=True,
            append_images=frames[1:],
            duration=GIF_DURATION_MS,
            loop=0,
            optimize=False,
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--diagnose", action="store_true",
                    help="print measured per-frame geometry and exit without writing")
    args = ap.parse_args()

    sheets: dict[str, np.ndarray] = {}
    sheet_hashes: dict[str, str] = {}
    for name, path in SHEETS:
        sheets[name], sheet_hashes[name] = load_sheet(path)

    source_cells: list[dict] = []
    for name, _ in SHEETS:
        for index in range(SHEET_COLS * SHEET_ROWS):
            col, row = index % SHEET_COLS, index // SHEET_COLS
            cell = cell_of(sheets[name], col, row)
            ring = border_ring_max(cell)
            if ring >= ALPHA_EDGE:
                raise SystemExit(f"{name} cell {index}: alpha {ring} on the cell border (frame bleed)")
            measure = measure_frame(cell)
            source_cells.append({"sheet": name, "sheet_index": index, "col": col, "row": row,
                                 "cell": cell, "measure": measure, "ring_max": ring})

    if len(source_cells) != ATLAS_COLS * ATLAS_ROWS:
        raise SystemExit("source sheet count does not fill the 4x4 atlas")

    baseline_target = max(item["measure"]["bottom"] for item in source_cells)
    if baseline_target > CELL_H - 1:
        raise SystemExit("measured baseline falls outside the cell")

    atlas_cells: list[np.ndarray] = []
    frame_records: list[dict] = []
    for atlas_index, item in enumerate(source_cells):
        measure = item["measure"]
        dx = int(round(CENTERLINE_TARGET - measure["torso_centerline"]))
        dy = int(baseline_target - measure["bottom"])
        normalized = translate_cell(item["cell"], dx, dy)
        atlas_cells.append(normalized)
        frame_records.append({
            "atlas_index": atlas_index,
            "sheet": item["sheet"],
            "sheet_cell": [item["col"], item["row"]],
            "source_bbox": [measure["left"], measure["top"], measure["right"], measure["bottom"]],
            "source_baseline": measure["bottom"],
            "source_torso_centerline": measure["torso_centerline"],
            "source_height_px": measure["height"],
            "border_ring_max_alpha": item["ring_max"],
            "translation": [dx, dy],
            "normalized_bbox": [measure["left"] + dx, measure["top"] + dy,
                                measure["right"] + dx, measure["bottom"] + dy],
        })

    contact, contact_column = measure_press_contact(atlas_cells[PRESS_INDEX])
    baseline = baseline_target
    source_height = CELL_H

    if args.diagnose:
        for record in frame_records:
            print(json.dumps(record))
        print(f"press contact {list(contact)} column rows {contact_column}")
        print(f"baseline {baseline} source_height {source_height} atlas {ATLAS_SIZE}")
        return 0

    SCENE_DIR.mkdir(parents=True, exist_ok=True)
    atlas = build_atlas(atlas_cells)
    atlas_path = SCENE_DIR / ATLAS_NAME
    atlas.save(atlas_path)

    write_metadata_module(ATLAS_SIZE, (CELL_W, CELL_H), contact, baseline, source_height)
    write_previews(atlas)

    provenance = {
        "pack": "02",
        "title": "Native 120 s bamboo-girl scene character atlas",
        "builder": "tools/build-rainlit-02-scene.py",
        "deterministic": True,
        "coordinate_semantics": {
            "note": "frozen by the parent batch: identical for the runtime scene stage",
            "units": "SOURCE pixels of the authored 384x512 cell unless stated otherwise",
            "atlas_index": "row-major: 0..7 walk, 8..15 action; 11 is the press pose",
            "paths": "asset references are relative to packages/config",
            "runtime_conversion": "the runtime scales source pixels once by girlScale; "
                                  "girlX is the root-logical CELL LEFT and the runtime subtracts the "
                                  "root inset once",
            "baseline": "shared ground-contact row measured from the cell top after normalization",
        },
        "source": {
            "sheets": [
                {"name": name, "path": f"assets/rainlit-frames/02/scene/source/{Path(path).name}",
                 "sha256": sheet_hashes[name], "size": [SHEET_COLS * CELL_W, SHEET_ROWS * CELL_H],
                 "mode": "RGBA, straight alpha, authored"}
                for name, path in SHEETS
            ],
            "alpha_authority": "the authored sheets carry real per-pixel alpha; the builder copies "
                               "it verbatim and never luminance-keys the dark hair/kimono",
            "not_visible": "hidden RGB under fully transparent pixels is compression residue, not "
                           "visible material",
            "research_only": [
                "character-master.webp / model-request.json (identity master, opaque magenta backing)",
            ],
        },
        "normalization": {
            "method": "one whole-sprite INTEGER translation per frame from measured alpha; no "
                      "per-frame rescale, resample, crop or warp",
            "visible_threshold_alpha": ALPHA_VISIBLE,
            "border_ring_max_alpha": ALPHA_EDGE,
            "baseline_target": baseline,
            "centerline_target": CENTERLINE_TARGET,
            "centerline_band_fraction": list(TORSO_BAND),
            "frames": frame_records,
        },
        "press_contact": {
            "atlas_index": PRESS_INDEX,
            "method": "leftmost pixel with alpha >= threshold in the NORMALIZED press cell; "
                      "y is the median visible row of that column (measured, not assumed)",
            "contact": list(contact),
            "contact_column_visible_rows": contact_column,
        },
        "atlas": {
            "file": ATLAS_NAME,
            "size": list(ATLAS_SIZE),
            "cell_size": [CELL_W, CELL_H],
            "grid": [ATLAS_COLS, ATLAS_ROWS],
            "mode": "RGBA",
            "sha256": sha256_file(atlas_path),
        },
        "exports": {
            "module": "packages/config/src/effect/rainlit/scene-02-assets.ts",
            "SCENE_02_ATLAS": "./assets/rainlit-frames/02/scene/character-atlas.png",
            "SCENE_02_ATLAS_SIZE": list(ATLAS_SIZE),
            "SCENE_02_CELL_SIZE": [CELL_W, CELL_H],
            "SCENE_02_PRESS_CONTACT": list(contact),
            "SCENE_02_BASELINE": baseline,
            "SCENE_02_SOURCE_HEIGHT": source_height,
        },
        "outputs": {
            ATLAS_NAME: {"sha256": sha256_file(atlas_path), "size": list(ATLAS_SIZE)},
            "source.json": {"file": "source.json", "note": "this provenance record"},
            "metadata_module": {"path": "packages/config/src/effect/rainlit/scene-02-assets.ts"},
        },
        "not_claimed": [
            "this atlas is asset assembly only: it does not prove renderer integration, native "
            "frame alignment, animation quality or owner acceptance",
            "character identity comparison against the wallpaper reference is assistant-observed "
            "at the research stage, not re-derived here",
        ],
    }
    (SCENE_DIR / "source.json").write_text(json.dumps(provenance, indent=2) + "\n")

    build_record = {
        "builder": "tools/build-rainlit-02-scene.py",
        "inputs": {name: {"path": str(path.relative_to(REPO)), "sha256": sheet_hashes[name]}
                   for name, path in SHEETS},
        "requests": ["model-request.json", "walk-request.json", "actions-request.json",
                     "guidance-frozen.txt"],
        "normalization": provenance["normalization"],
        "press_contact": provenance["press_contact"],
        "atlas": provenance["atlas"],
        "exports": provenance["exports"],
        "comparison": {
            "pixel_fidelity": "each atlas cell is a byte-identical copy of its normalized source "
                              "cell (raw paste, straight alpha, no blend and no resample)",
            "brief_vs_authored": [
                "the walk sheet was asked for head top ~55 px and slipper baseline ~465 px per "
                "cell; the authored sheet came back larger and lower, which the shared-baseline "
                "normalization absorbs without rescaling",
                "the action sheet was asked for the same 410 px body height; authored rows sit "
                "within a few px of each other, so the shared baseline is one translation",
            ],
            "foreign_character_check": "not machine-verifiable here; the builder adds no artwork "
                                       "and the parent compared the model against the reference "
                                       "at the research stage",
        },
    }
    BUILD_JSON.write_text(json.dumps(build_record, indent=2) + "\n")

    print(f"atlas {atlas_path.relative_to(REPO)} {ATLAS_SIZE[0]}x{ATLAS_SIZE[1]} "
          f"sha256 {provenance['atlas']['sha256']}")
    print(f"baseline {baseline} source_height {source_height} "
          f"press_contact {list(contact)} (column rows {contact_column})")
    for record in frame_records:
        print(f"  index {record['atlas_index']:2d} {record['sheet']:6s}"
              f"{record['sheet_cell']} translate {record['translation']} "
              f"baseline {record['source_baseline']} bbox {record['normalized_bbox']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

/**
 * Finite two-dimensional tiling geometry.
 *
 * A workspace keeps a binary split tree: leaves are tiled windows and splits
 * partition a rectangle between their two subtrees. This module is pure
 * numeric bookkeeping with no runtime imports, so the manager can own one tree
 * per workspace and turn it into concrete compositor rects.
 *
 * Split axes alternate on insertion — a new split takes the opposite axis of
 * the split it is inserted into, and the tree's first split is horizontal
 * (axis `x`). That mirrors Hyprland's dwindle intent: each window added next
 * subdivides the rectangle it lands in, so the layout stays bounded and never
 * overflows the usable area.
 */

export type WindowDirection = "left" | "right" | "up" | "down";

/** An edge of a leaf's rectangle; the same four directions as focus. */
export type TileEdge = WindowDirection;

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TileLayoutNode =
  | { kind: "leaf"; windowId: string }
  | {
      kind: "split";
      axis: "x" | "y";
      ratio: number;
      first: TileLayoutNode;
      second: TileLayoutNode;
    };

type LeafNode = Extract<TileLayoutNode, { kind: "leaf" }>;
type SplitNode = Extract<TileLayoutNode, { kind: "split" }>;
type SplitSide = "first" | "second";

interface SplitStep {
  split: SplitNode;
  side: SplitSide;
}

/** Fractions a user-driven split boundary is allowed to take. */
const MIN_SPLIT_RATIO = 0.1;
const MAX_SPLIT_RATIO = 0.9;
/** Ratio a freshly created split starts from (even halves). */
const DEFAULT_SPLIT_RATIO = 0.5;
/**
 * Smallest span two siblings may have to share. The inter-leaf gap is capped
 * against the axis length using this, so a split on a tiny or shrunken
 * rectangle still leaves at least one pixel on each side instead of collapsing
 * a leaf to zero width/height.
 */
const MIN_SIDE_LENGTH_PX = 2;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidWindowId(windowId: unknown): windowId is string {
  return typeof windowId === "string" && windowId.length > 0;
}

function isValidRect(rect: TileRect | null | undefined): rect is TileRect {
  return (
    rect != null &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * Gap applied along one axis, capped so both sides of the split keep at least
 * one pixel. Without the cap a gap larger than the rectangle would subtract
 * past zero and hand one leaf a negative span.
 */
function axisGap(length: number, gap: number): number {
  return Math.min(gap, Math.max(0, length - MIN_SIDE_LENGTH_PX));
}

/**
 * Partition `rect` into its two child rects. The gap only separates the two
 * halves on the split axis; the perpendicular axis is untouched.
 */
function splitChildRects(
  rect: TileRect,
  axis: "x" | "y",
  ratio: number,
  gap: number,
): { first: TileRect; second: TileRect } {
  const length = axis === "x" ? rect.width : rect.height;
  const effectiveGap = axisGap(length, gap);
  const inner = length - effectiveGap;
  const firstLength = inner * ratio;
  const secondLength = inner - firstLength;

  if (axis === "x") {
    return {
      first: { x: rect.x, y: rect.y, width: firstLength, height: rect.height },
      second: {
        x: rect.x + firstLength + effectiveGap,
        y: rect.y,
        width: secondLength,
        height: rect.height,
      },
    };
  }

  return {
    first: { x: rect.x, y: rect.y, width: rect.width, height: firstLength },
    second: {
      x: rect.x,
      y: rect.y + firstLength + effectiveGap,
      width: rect.width,
      height: secondLength,
    },
  };
}

function cloneNode(node: TileLayoutNode): TileLayoutNode {
  if (node.kind === "leaf") {
    return { kind: "leaf", windowId: node.windowId };
  }
  return {
    kind: "split",
    axis: node.axis,
    ratio: node.ratio,
    first: cloneNode(node.first),
    second: cloneNode(node.second),
  };
}

/**
 * Structural validation for a restored tree. Already seen ids catch duplicate
 * leaves, and `visiting` catches self-referential or aliased nodes that would
 * otherwise recurse forever or duplicate windows.
 *
 * Ratios only ever come from insert/resize (which stay in 0.1..0.9) or from a
 * trusted persisted snapshot; anything at or beyond the ends would give a
 * child zero or negative span, so it is rejected rather than repaired.
 */
function validateNode(
  node: unknown,
  windowIds: Set<string>,
  visiting: WeakSet<object>,
): boolean {
  if (node === null || typeof node !== "object" || !("kind" in node)) {
    return false;
  }

  if (node.kind === "leaf") {
    if (!("windowId" in node) || !isValidWindowId(node.windowId)) {
      return false;
    }
    if (windowIds.has(node.windowId)) {
      return false;
    }
    windowIds.add(node.windowId);
    return true;
  }

  if (node.kind === "split") {
    if (
      !("axis" in node) ||
      !("ratio" in node) ||
      !("first" in node) ||
      !("second" in node)
    ) {
      return false;
    }
    if (node.axis !== "x" && node.axis !== "y") {
      return false;
    }
    if (!(isFiniteNumber(node.ratio) && node.ratio > 0 && node.ratio < 1)) {
      return false;
    }
    if (visiting.has(node)) {
      return false;
    }
    visiting.add(node);
    const valid =
      validateNode(node.first, windowIds, visiting) &&
      validateNode(node.second, windowIds, visiting);
    visiting.delete(node);
    return valid;
  }

  return false;
}

/** Length of the overlap of two one-dimensional spans; 0 when disjoint. */
function overlapLength(
  firstStart: number,
  firstLength: number,
  secondStart: number,
  secondLength: number,
): number {
  return (
    Math.min(firstStart + firstLength, secondStart + secondLength) -
    Math.max(firstStart, secondStart)
  );
}

export class TileLayout {
  private root: TileLayoutNode | null = null;

  /**
   * Insert a new leaf after `anchorId`, or after the last leaf when the anchor
   * is missing or unknown. Duplicate and empty ids are ignored: the tree must
   * keep one leaf per window so `rects` stays a faithful id→rect map.
   */
  public insert(windowId: string, anchorId?: string): void {
    if (!isValidWindowId(windowId) || this.has(windowId)) {
      return;
    }

    const leaf: LeafNode = { kind: "leaf", windowId };
    const root = this.root;
    if (root === null) {
      this.root = leaf;
      return;
    }

    const anchor =
      (anchorId !== undefined ? this.findLeaf(root, anchorId) : null) ??
      this.lastLeaf(root);

    const parentAxis = this.parentAxis(anchor);
    const axis: "x" | "y" =
      parentAxis === null ? "x" : parentAxis === "x" ? "y" : "x";

    const split: SplitNode = {
      kind: "split",
      axis,
      ratio: DEFAULT_SPLIT_RATIO,
      // The anchor keeps its half; the new window takes the far side so it
      // reads as inserted "after" the anchor.
      first: anchor,
      second: leaf,
    };

    this.root = this.replaceLeaf(root, anchor, split);
  }

  /** Remove a leaf, collapsing its parent into the surviving sibling. */
  public remove(windowId: string): void {
    const path = this.findPath(this.root, windowId);
    if (path === null) {
      return;
    }

    if (path.length === 0) {
      this.root = null;
      return;
    }

    const lastStep = path[path.length - 1];
    const sibling =
      lastStep.side === "first" ? lastStep.split.second : lastStep.split.first;
    const parentStep = path.length >= 2 ? path[path.length - 2] : null;

    if (parentStep === null) {
      this.root = sibling;
      return;
    }

    if (parentStep.side === "first") {
      parentStep.split.first = sibling;
    } else {
      parentStep.split.second = sibling;
    }
  }

  public has(windowId: string): boolean {
    return this.findLeaf(this.root, windowId) !== null;
  }

  /**
   * Exchange the window ids of two existing leaves without touching the tree
   * shape or any ratios. Returns false when either id is absent.
   */
  public swap(firstId: string, secondId: string): boolean {
    if (firstId === secondId) {
      return this.has(firstId);
    }

    const first = this.findLeaf(this.root, firstId);
    const second = this.findLeaf(this.root, secondId);
    if (first === null || second === null) {
      return false;
    }

    first.windowId = secondId;
    second.windowId = firstId;
    return true;
  }

  /**
   * Flip the split axis of the leaf's parent, swapping left/right and up/down
   * division of that half. A root leaf has no parent to toggle, so it reports
   * false.
   */
  public toggleSplit(windowId: string): boolean {
    const path = this.findPath(this.root, windowId);
    if (path === null || path.length === 0) {
      return false;
    }

    const parent = path[path.length - 1].split;
    parent.axis = parent.axis === "x" ? "y" : "x";
    return true;
  }

  /**
   * Compute every leaf rect inside `bounds`. Leaves tile the bounds exactly:
   * sibling gap is the only separation, capped per axis so tiny bounds still
   * yield finite positive rects contained in the input. Invalid bounds or an
   * empty tree produce an empty map.
   */
  public rects(bounds: TileRect, gap: number): Map<string, TileRect> {
    const result = new Map<string, TileRect>();
    if (!isValidRect(bounds) || this.root === null) {
      return result;
    }

    // A gap may be omitted or nonsensical; anything non-positive means none.
    const effectiveGap = isFiniteNumber(gap) && gap > 0 ? gap : 0;
    this.collectLeafRects(this.root, bounds, effectiveGap, result);
    return result;
  }

  /**
   * Move the split boundary nearest to `edge` so it follows `coordinate`
   * (logical px on that axis). The deepest ancestor that both matches the
   * edge's axis and holds this leaf on the matching side wins; that ancestor's
   * real rect — including the gaps of every split above it — is recomputed
   * before the ratio is derived and clamped.
   *
   * Returns false for an unknown leaf, an outer edge (no matching ancestor),
   * or invalid input; a false result never mutates the tree.
   */
  public resize(
    windowId: string,
    edge: TileEdge,
    coordinate: number,
    bounds: TileRect,
    gap: number,
  ): boolean {
    if (
      edge !== "left" &&
      edge !== "right" &&
      edge !== "up" &&
      edge !== "down"
    ) {
      return false;
    }

    const path = this.findPath(this.root, windowId);
    if (
      path === null ||
      path.length === 0 ||
      !isValidRect(bounds) ||
      !isFiniteNumber(coordinate)
    ) {
      return false;
    }

    const axis: "x" | "y" = edge === "left" || edge === "right" ? "x" : "y";
    // A leaf dragging its right/down edge is the first (left/top) subtree;
    // dragging its left/up edge it is the second subtree. The two gap-
    // adjusted formulas below follow from that side.
    const side: SplitSide =
      edge === "right" || edge === "down" ? "first" : "second";
    const requestedGap = isFiniteNumber(gap) && gap > 0 ? gap : 0;

    for (let index = path.length - 1; index >= 0; index--) {
      const step = path[index];
      if (step.split.axis !== axis || step.side !== side) {
        continue;
      }

      let rect = bounds;
      for (let ancestorIndex = 0; ancestorIndex < index; ancestorIndex++) {
        const ancestorStep = path[ancestorIndex];
        rect = splitChildRects(
          rect,
          ancestorStep.split.axis,
          ancestorStep.split.ratio,
          requestedGap,
        )[ancestorStep.side];
      }

      const start = axis === "x" ? rect.x : rect.y;
      const length = axis === "x" ? rect.width : rect.height;
      const effectiveGap = axisGap(length, requestedGap);
      const inner = length - effectiveGap;
      if (inner <= 0) {
        return false;
      }

      const rawRatio =
        side === "first"
          ? (coordinate - start) / inner
          : (coordinate - start - effectiveGap) / inner;
      step.split.ratio = Math.min(
        Math.max(rawRatio, MIN_SPLIT_RATIO),
        MAX_SPLIT_RATIO,
      );
      return true;
    }

    return false;
  }

  /** Deep copy of the tree for persistence, or null for an empty layout. */
  public snapshot(): TileLayoutNode | null {
    return this.root === null ? null : cloneNode(this.root);
  }

  /**
   * Replace the tree with a deep copy of a persisted snapshot. Invalid input —
   * wrong node forms, unknown axes, non-finite or out-of-range ratios,
   * duplicate or empty window ids, self-referential nodes — is discarded
   * conservatively: the layout becomes empty rather than half-applied.
   * Only trusted local state is restored here; this is not network input
   * validation.
   */
  public restore(node: TileLayoutNode | null): void {
    if (node === null) {
      this.root = null;
      return;
    }

    const windowIds = new Set<string>();
    const visiting = new WeakSet<object>();
    this.root = validateNode(node, windowIds, visiting) ? cloneNode(node) : null;
  }

  private findLeaf(
    node: TileLayoutNode | null,
    windowId: string,
  ): LeafNode | null {
    if (node === null) {
      return null;
    }
    if (node.kind === "leaf") {
      return node.windowId === windowId ? node : null;
    }
    return (
      this.findLeaf(node.first, windowId) ??
      this.findLeaf(node.second, windowId)
    );
  }

  /**
   * Steps from the root down to the leaf, each recording the split and which
   * of its sides the leaf lives in. Empty for a root leaf, null when absent.
   */
  private findPath(
    node: TileLayoutNode | null,
    windowId: string,
  ): SplitStep[] | null {
    if (node === null) {
      return null;
    }
    if (node.kind === "leaf") {
      return node.windowId === windowId ? [] : null;
    }

    const firstPath = this.findPath(node.first, windowId);
    if (firstPath !== null) {
      return [{ split: node, side: "first" }, ...firstPath];
    }

    const secondPath = this.findPath(node.second, windowId);
    if (secondPath !== null) {
      return [{ split: node, side: "second" }, ...secondPath];
    }

    return null;
  }

  /** Last leaf in in-order traversal: the deepest rightmost window. */
  private lastLeaf(node: TileLayoutNode): LeafNode {
    let current = node;
    while (current.kind === "split") {
      current = current.second;
    }
    return current;
  }

  private parentAxis(leaf: LeafNode): "x" | "y" | null {
    const path = this.findPath(this.root, leaf.windowId);
    if (path === null || path.length === 0) {
      return null;
    }
    return path[path.length - 1].split.axis;
  }

  private replaceLeaf(
    node: TileLayoutNode,
    target: LeafNode,
    replacement: TileLayoutNode,
  ): TileLayoutNode {
    if (node === target) {
      return replacement;
    }
    if (node.kind === "leaf") {
      return node;
    }
    node.first = this.replaceLeaf(node.first, target, replacement);
    node.second = this.replaceLeaf(node.second, target, replacement);
    return node;
  }

  private collectLeafRects(
    node: TileLayoutNode,
    rect: TileRect,
    gap: number,
    out: Map<string, TileRect>,
  ): void {
    if (node.kind === "leaf") {
      out.set(node.windowId, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      return;
    }

    const { first, second } = splitChildRects(
      rect,
      node.axis,
      node.ratio,
      gap,
    );
    this.collectLeafRects(node.first, first, gap, out);
    this.collectLeafRects(node.second, second, gap, out);
  }
}

/**
 * Nearest candidate whose center lies in the positive `direction`
 * half-plane relative to the source center. Candidates are ranked by
 * orthogonal overlap first (a window truly beside the source beats a diagonal
 * one), then by center distance along the primary axis, then along the
 * orthogonal axis; equal candidates keep array order.
 *
 * The caller filters out the source window itself — this only compares rects.
 */
export function directionalNeighbor<T extends { id: string; rect: TileRect }>(
  source: TileRect,
  candidates: readonly T[],
  direction: WindowDirection,
): T | undefined {
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";

  const sourcePrimaryCenter = horizontal
    ? source.x + source.width / 2
    : source.y + source.height / 2;
  const sourceOrthogonalCenter = horizontal
    ? source.y + source.height / 2
    : source.x + source.width / 2;

  let best: T | undefined;
  let bestOverlap = false;
  let bestPrimaryDistance = 0;
  let bestOrthogonalDistance = 0;

  for (const candidate of candidates) {
    const rect = candidate.rect;
    if (
      rect == null ||
      !isFiniteNumber(rect.x) ||
      !isFiniteNumber(rect.y) ||
      !isFiniteNumber(rect.width) ||
      !isFiniteNumber(rect.height)
    ) {
      continue;
    }

    const primaryCenter = horizontal
      ? rect.x + rect.width / 2
      : rect.y + rect.height / 2;
    const orthogonalCenter = horizontal
      ? rect.y + rect.height / 2
      : rect.x + rect.width / 2;
    const primaryDelta = forward
      ? primaryCenter - sourcePrimaryCenter
      : sourcePrimaryCenter - primaryCenter;
    if (primaryDelta <= 0) {
      continue;
    }

    const overlap = horizontal
      ? overlapLength(source.y, source.height, rect.y, rect.height)
      : overlapLength(source.x, source.width, rect.x, rect.width);
    const hasOverlap = overlap > 0;
    const primaryDistance = Math.abs(primaryCenter - sourcePrimaryCenter);
    const orthogonalDistance = Math.abs(
      orthogonalCenter - sourceOrthogonalCenter,
    );

    const isBetter =
      best === undefined
        ? true
        : hasOverlap !== bestOverlap
          ? hasOverlap
          : primaryDistance !== bestPrimaryDistance
            ? primaryDistance < bestPrimaryDistance
            : orthogonalDistance !== bestOrthogonalDistance
              ? orthogonalDistance < bestOrthogonalDistance
              : false;

    if (isBetter) {
      best = candidate;
      bestOverlap = hasOverlap;
      bestPrimaryDistance = primaryDistance;
      bestOrthogonalDistance = orthogonalDistance;
    }
  }

  return best;
}

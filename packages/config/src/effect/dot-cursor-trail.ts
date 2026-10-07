import {
  COMPOSITOR,
  compileOverlayEffect,
  loadShader,
  shaderInput,
  signal,
  uniformArray,
  type OutputInfo,
  type OverlayHandle,
  type ShaderUniformVec4,
  type Signal,
} from "shoji_wm";

/**
 * Native Dot-Dark cursor trail.
 *
 * A short, tapered, connected gray stroke follows the pointer through the
 * existing output-overlay bridge. The native cursor is never touched: no warp,
 * grab, cursor theme change or duplicate head is produced, and the effect draws
 * below the hardware cursor (`placement: "top"`).
 *
 * Design invariants:
 *
 * - Each output run owns its own uniform signal. The descriptor is bound to
 *   that run's signal, so an overlay still being created for a previous output
 *   can never observe another output's frames: ending a run publishes the empty
 *   frame to its own signal before disposal.
 * - One fixed-size uniform array (`u_trail`, 11 vec4 slots) carries the
 *   resampled path, its bounding box and the live head. Publishing it once per
 *   timer tick is the only thing that invalidates the overlay; the array length
 *   never changes, so the shader binding is structural and never rebuilt.
 * - `invalidate` is static manual (`dirtyWhen: false`): the automatic
 *   source-damage path never redraws, and nothing re-renders between the 16ms
 *   publications. A publication bumps the native descriptor revision and wakes
 *   the instance, so there is no continuous invalidation and no idle work.
 * - The pointer listener only stores the latest position/time/output. All
 *   resampling, coordinate conversion and publication happen on the 16ms timer,
 *   and the timer exists only while there is motion or a decaying trail.
 * - History is a preallocated ring of at most 32 coalesced samples covering the
 *   180ms memory window, so high-rate pointer events cannot grow it.
 * - Runs are disposed at rest and on output crossing; a generation token closes
 *   handles whose run went stale while creation was in flight. There is no
 *   retry timer: a creation failure logs once, stops the run and suspends the
 *   installer until the next lifecycle enable or reload, while a stale
 *   creation failure never touches the live run.
 */

const TRAIL_POINTS = 8;
const TRAIL_SLOTS = 3 + TRAIL_POINTS;

/** Preallocated ring of coalesced pointer samples. */
const HISTORY_CAPACITY = 32;
/** One publication per timer tick; also the coalescing cadence for input. */
const TICK_MS = 16;
/** How long a captured sample still feeds the trail. */
const HISTORY_MS = 180;
/** Age fraction of `HISTORY_MS` where the fade toward zero begins. */
const AGE_FADE_START = 0.6;
/** Longest trail, in logical output pixels. */
const MAX_TRAIL_PX = 100;
/** Shortest trail that is worth drawing at all; near-stationary input is absent. */
const MIN_TRAIL_PX = 5;
/** Trail length at which the opacity ramp reaches its maximum. */
const FULL_OPACITY_LENGTH_PX = 30;
/** Half the ~6 logical px head width. */
const HEAD_RADIUS_PX = 3;
const TAIL_RADIUS_PX = 1;
const MAX_OPACITY = 0.65;
/** A single-tick jump farther than this is a teleport: no bridging stroke. */
const TELEPORT_PX = 160;

const TRAIL_SHADER = loadShader("./src/effect/dot-cursor-trail.frag");

type FrameVec4 = [number, number, number, number];

function makeFrame(): FrameVec4[] {
  const frame: FrameVec4[] = [];
  for (let i = 0; i < TRAIL_SLOTS; i++) {
    frame.push([0, 0, 0, 0]);
  }
  return frame;
}

// Frame 0 is the immutable "no trail" frame published when a run ends. Frames 1
// and 2 alternate as per-tick scratch so a publication is never mutated before
// the native side has resolved it; only the current run publishes them.
const frames: FrameVec4[][] = [makeFrame(), makeFrame(), makeFrame()];
const EMPTY_FRAME = 0;
let writeFrame = 1;

interface Sample {
  x: number;
  y: number;
  t: number;
  output: string;
}

const samples: Sample[] = [];
for (let i = 0; i < HISTORY_CAPACITY; i++) {
  samples.push({ x: 0, y: 0, t: 0, output: "" });
}
let historyStart = 0;
let historyCount = 0;

// Scratch path used while resampling; head-first, indexed 0..pathLength-1.
const pathX: number[] = new Array(HISTORY_CAPACITY).fill(0);
const pathY: number[] = new Array(HISTORY_CAPACITY).fill(0);
const pathT: number[] = new Array(HISTORY_CAPACITY).fill(0);
const pathCum: number[] = new Array(HISTORY_CAPACITY).fill(0);

interface TrailRun {
  output: string;
  generation: number;
  handle: OverlayHandle | null;
  /** This run's own publication channel; never shared with another output. */
  signal: Signal<readonly ShaderUniformVec4[]>;
}

let run: TrailRun | null = null;
let runGeneration = 0;
let timer: number | undefined;
let pending = false;
let pendingX = 0;
let pendingY = 0;
let pendingT = 0;
let pendingOutput = "";
let installed = false;
let enabled = true;
/** Set by a creation failure; cleared only by lifecycle enable / config reload. */
let suspended = false;

/** Clamped Hermite smoothstep over [0, 1]; the formula is inlined here so the
 * two opacity ramps share one name. */
function smoothstep01(value: number): number {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

function clearHistory(): void {
  historyStart = 0;
  historyCount = 0;
}

function pushSample(x: number, y: number, t: number, output: string): void {
  const index = (historyStart + historyCount) % HISTORY_CAPACITY;
  if (historyCount === HISTORY_CAPACITY) {
    historyStart = (historyStart + 1) % HISTORY_CAPACITY;
  } else {
    historyCount++;
  }
  const sample = samples[index];
  sample.x = x;
  sample.y = y;
  sample.t = t;
  sample.output = output;
}

function pruneHistory(now: number): void {
  while (historyCount > 0) {
    const oldest = samples[historyStart];
    if (now - oldest.t <= HISTORY_MS) {
      return;
    }
    historyStart = (historyStart + 1) % HISTORY_CAPACITY;
    historyCount--;
  }
}

function ensureTimer(): void {
  if (timer === undefined) {
    timer = setTimeout(onTick, TICK_MS);
  }
}

function stopTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

/**
 * End the current run: publish the empty frame on its own signal first, so an
 * overlay whose creation is still in flight can never render this run's frames
 * after the run is gone, then release the handle.
 */
function endRun(): void {
  if (!run) {
    return;
  }
  const current = run;
  run = null;
  runGeneration++;
  current.signal.value = frames[EMPTY_FRAME];
  if (current.handle) {
    current.handle.dispose();
  }
}

function reset(): void {
  stopTimer();
  pending = false;
  clearHistory();
  endRun();
}

/**
 * Resample the recent history into the write frame.
 *
 * Walks the ring from the newest sample backward, stopping at the arc-length
 * cap, then samples eight points evenly along that arc. Radius and opacity
 * taper with arc fraction; opacity additionally fades with sample age so a
 * stopped pointer shrinks the trail to nothing instead of cutting it off.
 *
 * @returns the published point count, or 0 when no trail should be drawn.
 */
function buildTrail(info: OutputInfo, now: number): number {
  const resolution = info.resolution;
  const scale = info.scale > 0 ? info.scale : 1;
  const logicalWidth = resolution ? resolution.width / scale : 0;
  const logicalHeight = resolution ? resolution.height / scale : 0;
  const originX = info.position.x;
  const originY = info.position.y;

  const newest = samples[(historyStart + historyCount - 1) % HISTORY_CAPACITY];
  let lastX = newest.x - originX;
  let lastY = newest.y - originY;

  pathX[0] = lastX;
  pathY[0] = lastY;
  pathT[0] = newest.t;
  pathCum[0] = 0;
  let pathLength = 1;

  let arc = 0;
  for (let i = historyCount - 2; i >= 0; i--) {
    const sample = samples[(historyStart + i) % HISTORY_CAPACITY];
    const x = sample.x - originX;
    const y = sample.y - originY;
    const dx = x - lastX;
    const dy = y - lastY;
    const step = Math.sqrt(dx * dx + dy * dy);
    if (step <= 0.0001) {
      continue;
    }
    arc += step;
    lastX = x;
    lastY = y;
    pathX[pathLength] = x;
    pathY[pathLength] = y;
    pathT[pathLength] = sample.t;
    pathCum[pathLength] = arc;
    pathLength++;
    if (arc >= MAX_TRAIL_PX) {
      break;
    }
  }

  if (pathLength < 2 || arc < MIN_TRAIL_PX) {
    return 0;
  }

  const span = Math.min(arc, MAX_TRAIL_PX);
  const spacing = span / (TRAIL_POINTS - 1);
  const lengthRamp = smoothstep01(span / FULL_OPACITY_LENGTH_PX);

  const frame = frames[writeFrame];
  const headX = pathX[0];
  const headY = pathY[0];
  let minX = headX;
  let maxX = headX;
  let minY = headY;
  let maxY = headY;

  for (let j = 0; j < TRAIL_POINTS; j++) {
    const target = j * spacing;
    let k = 1;
    while (k < pathLength - 1 && pathCum[k] < target) {
      k++;
    }
    const c0 = pathCum[k - 1];
    const c1 = pathCum[k];
    const local = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
    const x = pathX[k - 1] + (pathX[k] - pathX[k - 1]) * local;
    const y = pathY[k - 1] + (pathY[k] - pathY[k - 1]) * local;
    const sampleTime = pathT[k - 1] + (pathT[k] - pathT[k - 1]) * local;

    const fraction = j / (TRAIL_POINTS - 1);
    const radius = HEAD_RADIUS_PX - (HEAD_RADIUS_PX - TAIL_RADIUS_PX) * fraction;
    const age = Math.max(0, now - sampleTime);
    const ageFade = 1 - smoothstep01(
      (age - HISTORY_MS * AGE_FADE_START) / (HISTORY_MS * (1 - AGE_FADE_START)),
    );
    const tailFade = 1 - 0.85 * fraction;
    const opacity = MAX_OPACITY * lengthRamp * tailFade * ageFade;

    const point = frame[3 + j];
    point[0] = x;
    point[1] = y;
    point[2] = radius;
    point[3] = opacity;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const margin = HEAD_RADIUS_PX + 1.5;
  const meta = frame[0];
  meta[0] = logicalWidth;
  meta[1] = logicalHeight;
  meta[2] = scale;
  meta[3] = TRAIL_POINTS;

  const bounds = frame[1];
  bounds[0] = minX - margin;
  bounds[1] = minY - margin;
  bounds[2] = maxX + margin;
  bounds[3] = maxY + margin;

  const head = frame[2];
  head[0] = headX;
  head[1] = headY;
  head[2] = HEAD_RADIUS_PX;
  head[3] = 0;

  return TRAIL_POINTS;
}

function flushPending(): void {
  pending = false;
  if (historyCount > 0) {
    const last = samples[(historyStart + historyCount - 1) % HISTORY_CAPACITY];
    const dx = pendingX - last.x;
    const dy = pendingY - last.y;
    const moved = Math.sqrt(dx * dx + dy * dy);
    if (last.output !== pendingOutput || moved > TELEPORT_PX) {
      // Output crossing or teleport: never bridge the gap, just restart.
      clearHistory();
      endRun();
    } else if (last.x === pendingX && last.y === pendingY) {
      return;
    }
  }
  pushSample(pendingX, pendingY, pendingT, pendingOutput);
}

async function createRun(current: TrailRun): Promise<void> {
  const { output, generation } = current;
  try {
    const handle = await COMPOSITOR.effect.overlay(output, {
      placement: "top",
      persistent: true,
      effect: compileOverlayEffect({
        input: shaderInput(TRAIL_SHADER, {
          uniforms: { u_trail: uniformArray.vec4(current.signal) },
        }),
        alpha: "preserve",
        invalidate: { kind: "manual", dirtyWhen: false },
        pipeline: [],
      }),
    });
    if (run !== current || run.generation !== generation) {
      // The run ended (or moved on) while the overlay was being created.
      handle.dispose();
      return;
    }
    current.handle = handle;
    void handle.closed.then(
      () => onRunClosed(generation, output),
      () => onRunClosed(generation, output),
    );
  } catch (error) {
    console.error("dot-cursor-trail: overlay creation failed", error);
    if (run !== current) {
      // A stale creation must not disturb the live run.
      return;
    }
    run = null;
    runGeneration++;
    current.signal.value = frames[EMPTY_FRAME];
    stopTimer();
    pending = false;
    clearHistory();
    suspended = true;
  }
}

/**
 * Return the run drawing `output`, creating it (with its own signal seeded with
 * the current frame) when none exists. A run for another output is ended first,
 * so there is never more than one run and never two overlays for one output.
 */
function ensureRun(output: string, frame: readonly ShaderUniformVec4[]): TrailRun {
  if (run && run.output === output) {
    return run;
  }
  if (run) {
    endRun();
  }
  const generation = ++runGeneration;
  const next: TrailRun = {
    output,
    generation,
    handle: null,
    signal: signal<readonly ShaderUniformVec4[]>(frame),
  };
  run = next;
  void createRun(next);
  return next;
}

function onRunClosed(generation: number, output: string): void {
  if (!run || run.generation !== generation || run.output !== output) {
    return;
  }
  // The compositor closed the slot (output removal, scale/transform change,
  // lock or reload). Stop local work; fresh pointer motion may start again.
  const closing = run;
  run = null;
  runGeneration++;
  closing.signal.value = frames[EMPTY_FRAME];
  stopTimer();
  pending = false;
  clearHistory();
}

function onTick(): void {
  timer = undefined;
  if (!enabled || suspended) {
    return;
  }
  const now = Date.now();

  if (pending) {
    flushPending();
  }
  pruneHistory(now);

  if (historyCount === 0) {
    endRun();
    return;
  }

  const newest = samples[(historyStart + historyCount - 1) % HISTORY_CAPACITY];
  const info = COMPOSITOR.output.get(newest.output);
  if (!info || !info.enabled) {
    clearHistory();
    endRun();
    return;
  }

  const count = buildTrail(info, now);
  if (count === 0) {
    // A single sample, a teleport, or sub-threshold jitter: release the run and
    // go fully idle. The next pointer move restarts the timer.
    endRun();
    return;
  }

  const frame = frames[writeFrame];
  writeFrame = writeFrame === 1 ? 2 : 1;
  ensureRun(newest.output, frame).signal.value = frame;
  ensureTimer();
}

function notePointer(x: number, y: number, output: string): void {
  if (pending && x === pendingX && y === pendingY && output === pendingOutput) {
    return;
  }
  pendingX = x;
  pendingY = y;
  pendingOutput = output;
  pendingT = Date.now();
  pending = true;
  ensureTimer();
}

/**
 * Register the Dot-Dark cursor trail on the live compositor.
 *
 * Adds listeners only; existing pointer, output and lifecycle listeners keep
 * working untouched. Call once from the config entry after the cursor theme is
 * configured.
 */
export function installDotCursorTrail(): void {
  if (installed) {
    return;
  }
  installed = true;

  COMPOSITOR.event.onPointerMove((event) => {
    if (!enabled || suspended) {
      return;
    }
    const output = event.outputName;
    if (output === undefined) {
      return;
    }
    notePointer(event.position.x, event.position.y, output);
  });

  COMPOSITOR.event.onOutputChange(() => {
    // Output geometry and slots changed: nothing from the old layout is valid.
    reset();
  });

  COMPOSITOR.onDisable(() => {
    enabled = false;
    reset();
  });

  COMPOSITOR.onEnable(() => {
    suspended = false;
    enabled = true;
  });
}

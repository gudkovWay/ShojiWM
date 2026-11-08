/**
 * A cube transition between two views of an output, e.g. two workspaces.
 *
 * Each face is a render texture of whatever composition nodes you pass:
 * typically the wallpaper plus the windows of one workspace, picked by id so
 * they show even while the window manager keeps them hidden. Top/Overlay
 * layers (bars) stay flat in front of the cube.
 *
 * ```tsx
 * import { COMPOSITOR, DefaultComposition, Layers, Windows } from "shoji_wm";
 * import { createCubeTransition } from "./cube-transition";
 *
 * const cube = createCubeTransition({ duration: 700 });
 * COMPOSITOR.rendering.composition = (output) =>
 *   cube.compose(output) ?? <DefaultComposition />;
 *
 * // When switching workspaces (switch the windows instantly, without the
 * // usual slide, and let the cube animate):
 * cube.start(outputName, {
 *   from: <><Layers layers={["background", "bottom"]} /><Windows windows={fromIds} /></>,
 *   to: <><Layers layers={["background", "bottom"]} /><Windows windows={toIds} /></>,
 *   direction: 1,
 * });
 * ```
 */
import {
  createPoll,
  easeInOut,
  LayerPopups,
  Layers,
  outputLogicalSize,
  Plane,
  renderTexture,
  Scene3D,
  screenCamera,
  signal,
  Solid,
  transform3d,
  type CompositionRenderable,
  type OutputInfo,
  type PollHandle,
} from "shoji_wm";

export interface CubeTransitionOptions {
  /** Milliseconds (default 700). */
  duration?: number;
  /** How far the camera pulls back mid-turn, relative to the output height (default 0.35). */
  zoomOut?: number;
  /** Behind the cube (default near black). */
  background?: string;
}

export interface CubeTransitionRequest {
  from: CompositionRenderable;
  to: CompositionRenderable;
  /** 1: the next face comes in from the right; -1: from the left. */
  direction: 1 | -1;
}

interface ActiveTransition extends CubeTransitionRequest {
  output: string;
  startMs: number | null;
  poll: PollHandle;
}

export function createCubeTransition(options: CubeTransitionOptions = {}) {
  const duration = options.duration ?? 700;
  const zoomOut = options.zoomOut ?? 0.35;
  const [active, setActive] = signal<ActiveTransition | null>(null);
  const [progress, setProgress] = signal(0);

  function finish(transition: ActiveTransition) {
    transition.poll.cancel();
    if (active.peek() === transition) {
      setActive(null);
    }
  }

  return {
    /** Whether a transition is running. */
    active: () => active() !== null,

    start(output: string, request: CubeTransitionRequest) {
      const previous = active.peek();
      if (previous) finish(previous);
      const transition: ActiveTransition = {
        ...request,
        output,
        startMs: null,
        poll: undefined as unknown as PollHandle,
      };
      transition.poll = createPoll(
        16,
        (handle) => {
          transition.startMs ??= handle.nowMs;
          const linear = Math.min(1, (handle.nowMs - transition.startMs) / duration);
          setProgress(easeInOut(linear));
          if (linear >= 1) finish(transition);
        },
        { output },
      );
      setProgress(0);
      setActive(transition);
    },

    /** The cube for `output` while it turns, otherwise `null`. */
    compose(output: OutputInfo): CompositionRenderable | null {
      const transition = active();
      if (!transition || transition.output !== output.name) return null;
      const { width, height } = outputLogicalSize(output);
      const t = progress();
      const half = width / 2;
      const turn = 90 * transition.direction;
      // The cube's centre sits half a face behind the screen, so face `from`
      // fills the output exactly at the start and face `to` at the end.
      const cube = transform3d().translate(0, 0, -half).rotateY(-turn * t);
      const from = renderTexture({ key: "cube-from", content: transition.from });
      const to = renderTexture({ key: "cube-to", content: transition.to });
      return (
        <>
          <Solid color={options.background ?? "#0b0b10"} />
          <Scene3D
            camera={screenCamera(output, {
              distance: Math.sin(t * Math.PI) * height * zoomOut,
            })}
          >
            <Plane texture={from} width={width} height={height} transform={cube.translate(0, 0, half)} />
            <Plane
              texture={to}
              width={width}
              height={height}
              transform={cube.rotateY(turn).translate(0, 0, half)}
            />
          </Scene3D>
          <Layers layers={["top", "overlay"]} />
          <LayerPopups />
        </>
      );
    },
  };
}

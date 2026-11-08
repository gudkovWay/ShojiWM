---
sidebar_position: 11.5
---

# Frame Timing & Polls

ShojiWM keeps time **per output**. Each output's clock is the presentation time
of its own frames: the vblank a frame lands on, not the moment it happened to be
rendered.

Work bound to an output runs on that output's frames, exactly once per frame and
stamped with that frame's presentation time. This applies to polls created with
`createPoll` and to the animations of the windows and layers on that output. A
step is therefore the same on every run, whether frames are prepared one frame
ahead or two (see [frame pacing](./outputs.md#frame-pacing-triple-buffering)),
and on a 60 Hz and a 144 Hz monitor side by side each runs at its own rate.

## `createPoll`

```ts
import { createPoll } from "shoji_wm";

const handle = createPoll(16, (handle) => {
  step(handle.nowMs); // presentation time of this run's frame, in ms
}, { output: "DP-1" });

handle.cancel();
```

`createPoll(intervalMs, callback, options)` runs `callback` every `intervalMs`
on the frames of `options.output`.

- **It runs at most once per frame.** A run is due when the frame's time has
  reached the previous run plus `intervalMs`. An interval shorter than one
  refresh period (`16` on a 60 Hz output, `1` for "every frame") runs every
  frame.
- **Intervals are whole milliseconds**, rounded down. A per-frame poll at 60 Hz
  is `16`: 16.67 would sometimes come due just after a frame's timestamp and
  skip it.
- **`handle.nowMs`** is the time of the current run. Use the difference between
  runs as your step instead of assuming the interval.
- **The poll keeps running until `handle.cancel()`** (calling it inside the
  callback makes a one-shot timer).

### Options

| Option | Type | Meaning |
| --- | --- | --- |
| `output` | `string \| ReadonlySignal<string \| undefined> \| () => string \| undefined` | **Required.** The output whose frames drive the poll. A signal or function is read on every tick, so the poll follows it (`window.output` follows the window across monitors). |
| `dirty` | `"runtime"` (default) \| `"none"` | `"runtime"` re-evaluates the config after every run. `"none"` updates only what the callback marks dirty itself (for example by writing signals that a composition reads), which is cheaper for per-frame polls. |

`output` is required. A poll without an output would step on whichever monitor
happened to render next, and its step would vary from run to run.

### Outputs that render no frames

When the output is switched off, disconnected, or `output` resolves to
`undefined`, the poll keeps running on wall-clock timers. When the output
renders again, the poll moves back to its frames.

## Following a window: `window.output` and `window.createPoll`

`window.output` is a signal holding the output a window belongs to: the one
containing its center, else one it overlaps, else the nearest. A window's
[animations](./animations.md) run on this output's clock.

`window.createPoll` is `createPoll` bound to it:

```ts
COMPOSITOR.event.onOpen((window) => {
  let last: number | null = null;
  window.createPoll(1, (handle) => {
    const dt = last === null ? 0 : handle.nowMs - last;
    last = handle.nowMs;
    if (!advanceRipple(window, dt)) {
      handle.cancel();
    }
  }, { dirty: "none" });
});
```

When the window moves to another monitor, the poll moves with it. Its step at
that moment may be irregular once, because the two monitors' vblanks are not in
phase.

## Inside components: `useOutput`

Components do not receive the window, but timers inside them should still follow
it. `useOutput()` returns the output of the window being rendered, as an
`output` you can pass on:

```tsx
import { createPoll, useEffect, useOutput, useState } from "shoji_wm";

const useRestingHover = (hovered: boolean) => {
  const [rested, setRested] = useState(false);
  const output = useOutput();
  useEffect(() => {
    if (!hovered) {
      setRested(false);
      return;
    }
    const timer = createPoll(500, (handle) => {
      handle.cancel();
      setRested(true);
    }, { output });
    return () => timer.cancel();
  }, [hovered]);
  return rested;
};
```

`<Popup trigger="hover">` does this for its `openDelay` / `closeDelay` already.

## Every output: `createPollForEachOutput`

For something drawn on every monitor, such as a wallpaper effect, run one poll
per output, each on that output's clock:

```ts
import { createPollForEachOutput } from "shoji_wm";

const handle = createPollForEachOutput(1, (handle, outputName) => {
  setWallpaperTime(outputName, handle.nowMs / 1000);
});

handle.cancel(); // stops every output's poll
```

When an output is connected later, it gets its own poll, and when an output goes
away, its poll is cancelled. Do not share one piece of state between the
callbacks of different outputs: their `nowMs` values come from different clocks
and interleave. Keep state per `outputName`.

## Migrating from the previous API

| Before | Now |
| --- | --- |
| `createPoll(ms, cb)` | `createPoll(ms, cb, { output })`. Pick the output the poll's result is shown on. |
| `createManagedPoll(ms, cb, "none")` | `createPoll(ms, cb, { output, dirty: "none" })` |
| A poll for one window | `window.createPoll(ms, cb)` |
| A timer inside a component | `createPoll(ms, cb, { output: useOutput() })` |
| A poll driving every monitor | `createPollForEachOutput(ms, cb)` |

A poll created without `output` throws an error that names the new signature.

:::note
The Rust SDK (`shojiwm_rs`) keeps time the same way:
`create_poll(interval_ms, output, |handle| ..)` (`handle.now_ms()`),
`window.create_poll`, `create_poll_for_each_output`, and
`Animation::new(..).on_output(window.output())` for an animation on a window's
output. `set_interval` / `set_timeout` are bound to no output: they run on
whichever output renders next.
:::

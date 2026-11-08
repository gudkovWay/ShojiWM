---
sidebar_position: 10.6
---

# Output composition and 3D

`COMPOSITOR.rendering.composition` decides how each output is put together. It is
the output-level counterpart of the [window composition](./window-composition.md):
where that one builds a window's decoration, this one builds the whole screen out of
layer-shell surfaces, windows, offscreen textures and 3D scenes.

This page explains the model. The [reference](./output-composition-reference.md)
lists every node and helper, and the [recipes](./output-composition-recipes.md) show
complete effects (a cube transition, crossfades, zoom, per-window 3D layouts).

## The default stacking

Without a composition function, every output uses:

```tsx
<>
  <Layers layers={["background", "bottom"]} />
  <Windows />
  <Layers layers={["top", "overlay"]} />
  <LayerPopups />
</>
```

which is exactly what `<DefaultComposition />` returns. Children draw **back to
front**: later children are on top. A composition function returns a tree like this
one; it can reorder the pieces, leave some out, render any of them into a texture
with `renderTexture`, and draw textures flat (`<TextureView>`) or in 3D (`<Scene3D>`
with `<Plane>`s).

```tsx
import { COMPOSITOR, DefaultComposition } from "shoji_wm";

COMPOSITOR.rendering.composition = (output) => <DefaultComposition />;
```

The function gets the output's `OutputInfo` and may return a different tree per
output. The session lock screen, the cursor and the config error overlay always stay
on top of whatever it draws.

A common shape is "the default, unless an effect is running":

```tsx
COMPOSITOR.rendering.composition = (output) =>
  myEffect.compose(output) ?? <DefaultComposition />;
```

## When it runs

The function runs when an output appears or changes and again when a signal it read
changes, never per frame on its own. The compositor keeps the last plan it received
and walks it every frame, collecting the same render elements it always did, so
damage tracking, occlusion and direct scanout keep working.

To animate, drive signals from a `createPoll` on the output (see
[Timing](./timing.md)): each change re-evaluates the composition once per frame. Read
the signals inside the composition function, and only the outputs that read them
re-evaluate.

```tsx
const [angle, setAngle] = signal(0);
createPoll(16, (poll) => setAngle(angle.peek() + 1), { output: "DP-1" });

COMPOSITOR.rendering.composition = (output) => {
  const { width, height } = outputLogicalSize(output);
  const desktop = renderTexture({ content: <DefaultComposition /> });
  return (
    <Scene3D camera={screenCamera(output, { distance: 400 })}>
      <Plane texture={desktop} width={width} height={height}
        transform={transform3d().rotateY(angle())} />
    </Scene3D>
  );
};
```

## Textures

`renderTexture({ content })` renders composition nodes offscreen. Use the result in
`<TextureView>` or `<Plane>` as often as you like:

- A texture renders **once per frame** however many nodes use it, and redraws **only
  where its content changed**. A still texture costs nothing.
- Effects work inside textures: blur, `<ShaderEffect>` and window effects are part
  of what the texture shows.
- Textures may use other textures (a texture of a 3D scene of textures is fine), but
  not themselves.
- `key` keeps the GPU texture across re-evaluations. It defaults to call order, which
  is stable as long as the tree's shape is; give a key to textures that appear
  conditionally.
- `width`, `height` and `scale` default to the output's. A smaller texture costs
  less; a larger `scale` gives a sharper zoom.

## Coordinates

- Composition rectangles (`x`, `y`, `width`, `height` on `<TextureView>`, `<Solid>`
  and `<Scene3D>`) are logical pixels from the top-left corner of the composition: the
  output, or the texture being rendered. Omitted values cover the rest of it, and
  everything is clipped to it.
- Inside a texture, layers and windows appear where they are on the output: a texture
  of the output's size shows the output; a smaller one shows its top-left part.
  `<Windows offsetX offsetY>` shifts windows, which is how a texture frames a single
  window (see [per-window textures](./output-composition-recipes.md#per-window-textures)).
- 3D world units are logical pixels; +Y is up and +Z points towards the camera.
  `screenCamera(output)` maps the plane z = 0 onto the output 1:1, so a plane the size
  of the output at the origin covers it exactly and effects can start from the flat
  desktop.

## Windows the plan picks

`<Windows />` without props is the output's own stack: what it shows right now,
closing windows and decoration popups included. `<Windows windows={[...]} />` draws
exactly the given windows (objects or ids) in stacking order, **even when they are
hidden**: the windows of another workspace, a minimized window. A hidden window is
drawn as it would look shown, at its rect without the transform or fade that hides
it.

- Windows shown only through a composition still get frame callbacks, so clients keep
  rendering while hidden. Windows outside the composition's area are skipped and get
  none.
- Input is not affected. It still goes to windows by their real position and
  visibility, whatever the composition draws. A plan that moves windows on screen
  (an exposé, a 3D switcher) takes over input with an
  [input grab](./keybindings-and-pointer.md#input-grab) while it is shown, hit-tests
  its own layout ([`pickPlane`](./output-composition-reference.md#picking)), and
  lets the window manager decide what is visible afterwards.

## Backdrop effects

Backdrop effects (blur, glass, anything using `backdropSource()`) see **what the plan
draws below them**: windows, layers, texture views, 3D scenes and solid fills. A
bar's blur shows a 3D scene turning under it; a window inside a texture blurs whatever
the texture draws under it.

- In the default stacking that is exactly what backdrops always sampled, at the same
  cost.
- `xrayBackdropSource()` sees what lies below the nearest window stack under the
  surface: the wallpaper in the default stacking, everything below when there is no
  window stack.
- Layer popups are never sampled.
- When a texture or 3D scene under a backdrop changes, the backdrop recomputes. That
  is cheap while things are still and costs one blur per frame while they move.

Inside a texture of a single window, nothing lies below the window, so its blur has
nothing to show. Switch such windows to an effect without a backdrop while the
texture is shown (see [per-window textures](./output-composition-recipes.md#per-window-textures)).

## Performance

- The default stacking costs what the compositor always cost: no extra pass, the
  fullscreen fast path and direct scanout included.
- While the root of a composition has no `<Windows />` (the output's own stack), the
  fullscreen fast path and direct scanout are off for that output. Return
  `<DefaultComposition />` when no effect is running.
- Each texture and each 3D scene is an offscreen buffer the size of its area, kept
  while the plan uses it and released when it stops.
- A 3D scene redraws only when its camera, planes or textures change.
- One plan may declare at most 64 textures.

## Backends

TTY and nested (winit) backends both support compositions.

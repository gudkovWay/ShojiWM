---
sidebar_position: 11.5
---

# フレームのタイミングと poll

ShojiWM は時刻を**出力ごと**に持ちます。各出力の時計は、その出力のフレームの
表示時刻です。たまたま描画した瞬間ではなく、そのフレームが載る vblank の時刻です。

出力に結び付いた処理は、その出力のフレームで 1 フレームにちょうど 1 回、そのフレームの
表示時刻で実行されます。`createPoll` で作った poll も、その出力にあるウィンドウや
レイヤーのアニメーションも同じです。そのため刻みは毎回同じになります。フレームを
1 フレーム先に用意していても 2 フレーム先でも変わりません
（[フレームの出し方](./outputs.md#フレームの出し方トリプルバッファ)を参照）。
60Hz と 144Hz のモニターを並べても、それぞれが自分のレートで進みます。

## `createPoll`

```ts
import { createPoll } from "shoji_wm";

const handle = createPoll(16, (handle) => {
  step(handle.nowMs); // この実行が載るフレームの表示時刻（ms）
}, { output: "DP-1" });

handle.cancel();
```

`createPoll(intervalMs, callback, options)` は、`options.output` のフレームで
`intervalMs` ごとに `callback` を実行します。

- **1 フレームに最大 1 回だけ実行されます。** 前回の実行から `intervalMs` 経った時刻に
  フレームの時刻が達すると実行されます。1 リフレッシュより短い間隔（60Hz の出力で `16`、
  「毎フレーム」なら `1`）は毎フレーム実行されます。
- **間隔はミリ秒単位に切り捨てられます。** 60Hz で毎フレーム動かすなら `16` です。
  16.67 だとフレームの時刻の直後に期限が来ることがあり、そのフレームを飛ばします。
- **`handle.nowMs`** は今回の実行の時刻です。間隔を仮定せず、前回との差を刻み幅に
  使ってください。
- **`handle.cancel()` を呼ぶまで実行され続けます。** コールバックの中で呼べば一度きりの
  タイマーになります。

### オプション

| オプション | 型 | 意味 |
| --- | --- | --- |
| `output` | `string \| ReadonlySignal<string \| undefined> \| () => string \| undefined` | **必須。** poll を駆動する出力です。signal や関数は tick ごとに読まれるので、poll はそれに追従します（`window.output` ならウィンドウがモニターを移っても追従します）。 |
| `dirty` | `"runtime"`（既定）\| `"none"` | `"runtime"` は実行のたびに設定全体を再評価します。`"none"` はコールバック自身が dirty にしたもの（コンポジションが読む signal への書き込みなど）だけを更新するので、毎フレームの poll では軽くなります。 |

`output` は必須です。出力を持たない poll は、たまたま次に描画したモニターで進むことに
なり、刻みが実行ごとにばらついてしまいます。

### フレームを出していない出力

出力が電源オフ・切断されている場合や、`output` が `undefined` になった場合、poll は
実時刻のタイマーで動き続けます。出力が再び描画を始めると、その出力のフレームに戻ります。

## ウィンドウに追従する: `window.output` と `window.createPoll`

`window.output` は、ウィンドウが属する出力を持つ signal です。ウィンドウの中心を含む
出力、なければ重なっている出力、それもなければ最寄りの出力になります。ウィンドウの
[アニメーション](./animations.md)もこの出力の時計で進みます。

`window.createPoll` は、これに結び付いた `createPoll` です。

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

ウィンドウが別のモニターへ移ると、poll も一緒に移ります。2 つのモニターの vblank は
位相が揃っていないので、移った瞬間の刻みだけは一度不規則になることがあります。

## コンポーネントの中で: `useOutput`

コンポーネントはウィンドウを受け取りませんが、中のタイマーもウィンドウに追従させる
べきです。`useOutput()` は描画中のウィンドウの出力を、そのまま `output` に渡せる形で
返します。

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

`<Popup trigger="hover">` の `openDelay` / `closeDelay` は、すでにこの方法で動いています。

## 全出力で: `createPollForEachOutput`

壁紙エフェクトのように全モニターに描くものは、出力ごとに poll を 1 つずつ、それぞれの
出力の時計で動かします。

```ts
import { createPollForEachOutput } from "shoji_wm";

const handle = createPollForEachOutput(1, (handle, outputName) => {
  setWallpaperTime(outputName, handle.nowMs / 1000);
});

handle.cancel(); // 全出力の poll を止める
```

後から接続された出力にも poll が作られ、外れた出力の poll は取り消されます。異なる
出力のコールバック同士で 1 つの状態を共有しないでください。`nowMs` は別々の時計から
来て交互に届きます。状態は `outputName` ごとに持ってください。

## 以前の API からの移行

| 以前 | 現在 |
| --- | --- |
| `createPoll(ms, cb)` | `createPoll(ms, cb, { output })`。poll の結果が表示される出力を指定します。 |
| `createManagedPoll(ms, cb, "none")` | `createPoll(ms, cb, { output, dirty: "none" })` |
| 特定のウィンドウ用の poll | `window.createPoll(ms, cb)` |
| コンポーネント内のタイマー | `createPoll(ms, cb, { output: useOutput() })` |
| 全モニターを動かす poll | `createPollForEachOutput(ms, cb)` |

`output` なしで作った poll はエラーになり、エラーメッセージに新しい書き方が示されます。

:::note
Rust SDK（`shojiwm_rs`）も同じ仕組みで時刻を扱います:
`create_poll(interval_ms, output, |handle| ..)`（`handle.now_ms()`）、
`window.create_poll`、`create_poll_for_each_output`、ウィンドウの出力で進む
アニメーションには `Animation::new(..).on_output(window.output())`。
`set_interval` / `set_timeout` は出力に結び付かず、次に描画する出力で進みます。
:::

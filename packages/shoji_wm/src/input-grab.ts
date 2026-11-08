import type { GestureSwipeEvent } from "./events";

/** Modifier keys held during a grabbed event. / グラブ中のイベントで押されていた修飾キー。 */
export interface InputGrabModifiers {
  super: boolean;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
}

export interface InputGrabPoint {
  x: number;
  y: number;
}

export type InputGrabState = "pressed" | "released";

export interface InputGrabKeyEvent {
  /**
   * xkb keysym name, unshifted Latin layout first, spelled like key binding
   * shortcuts: `"Tab"`, `"Return"`, `"Escape"`, `"a"`, `"Super_L"`.
   * xkb の keysym 名（ラテン配列優先、ショートカット表記と同じ）。
   */
  key: string;
  keycode: number;
  state: InputGrabState;
  modifiers: InputGrabModifiers;
  timestamp: number;
}

export interface InputGrabPointerMotionEvent {
  /** Global logical position of the cursor. / カーソルのグローバル論理座標。 */
  position: InputGrabPoint;
  delta: InputGrabPoint;
  outputName?: string;
  modifiers: InputGrabModifiers;
  timestamp: number;
}

export interface InputGrabPointerButtonEvent {
  /** Linux event code (`BTN_LEFT` = 272). */
  button: number;
  buttonName?: "left" | "right" | "middle" | "back" | "forward";
  state: InputGrabState;
  position: InputGrabPoint;
  outputName?: string;
  modifiers: InputGrabModifiers;
  timestamp: number;
}

export interface InputGrabScrollEvent {
  /** Logical pixels; positive is right / down. / 論理ピクセル。正は右・下。 */
  deltaX: number;
  deltaY: number;
  /** Wheel clicks × 120, when the device reports them. / ホイールのクリック数×120。 */
  discreteX?: number;
  discreteY?: number;
  source: "wheel" | "finger" | "continuous" | "wheelTilt";
  position: InputGrabPoint;
  outputName?: string;
  modifiers: InputGrabModifiers;
  timestamp: number;
}

/** Why the compositor ended a grab. / コンポジターがグラブを終了した理由。 */
export type InputGrabCancelReason = "sessionLock" | "error" | "replaced";

export interface InputGrabOptions {
  onKey?(event: InputGrabKeyEvent): void;
  onPointerMotion?(event: InputGrabPointerMotionEvent): void;
  onPointerButton?(event: InputGrabPointerButtonEvent): void;
  onScroll?(event: InputGrabScrollEvent): void;
  onSwipe?(event: GestureSwipeEvent): void;
  /**
   * The grab ended without `release()`: the screen locked, a handler threw,
   * or another grab replaced it.
   * `release()` 以外でグラブが終わった（画面ロック・ハンドラーの例外・別のグラブ）。
   */
  onCancel?(reason: InputGrabCancelReason): void;
}

export interface InputGrab {
  /** Give input back to the clients. / 入力をクライアントに戻します。 */
  release(): void;
  readonly active: boolean;
}

type NativeInputGrab = (id: number, active: boolean) => void;

interface ActiveGrab {
  id: number;
  options: InputGrabOptions;
}

let nextGrabId = 1;
let current: ActiveGrab | null = null;

function native(): NativeInputGrab | undefined {
  return (globalThis as { __SHOJI_INPUT_GRAB__?: NativeInputGrab })
    .__SHOJI_INPUT_GRAB__;
}

/**
 * Take all keyboard, pointer button, scroll and swipe input until
 * `release()`. Pointer motion still moves the cursor and is reported too.
 * `release()` まで、キーボード・ポインタボタン・スクロール・スワイプの入力をすべて
 * 受け取ります。ポインタの移動もカーソルを動かしたうえで届きます。
 */
export function grabInput(options: InputGrabOptions): InputGrab {
  const previous = current;
  const grab: ActiveGrab = { id: nextGrabId++, options };
  current = grab;
  native()?.(grab.id, true);
  if (previous) {
    previous.options.onCancel?.("replaced");
  }
  return {
    release() {
      if (current !== grab) {
        return;
      }
      current = null;
      native()?.(grab.id, false);
    },
    get active() {
      return current === grab;
    },
  };
}

type WireInputGrabEvent =
  | ({ kind: "key" } & InputGrabKeyEvent)
  | ({ kind: "pointerMotion" } & InputGrabPointerMotionEvent)
  | ({ kind: "pointerButton" } & InputGrabPointerButtonEvent)
  | ({ kind: "scroll" } & InputGrabScrollEvent)
  | { kind: "swipe"; event: GestureSwipeEvent }
  | { kind: "cancel"; reason: InputGrabCancelReason };

function withoutNulls<T extends object>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== null && key !== "kind") {
      result[key] = field;
    }
  }
  return result as T;
}

/**
 * Runtime side: deliver a grabbed event. Returns whether a handler ran.
 * ランタイム側: グラブしたイベントを届けます。
 */
export function dispatchInputGrabEvent(
  grabId: number,
  event: WireInputGrabEvent,
): boolean {
  const grab = current;
  if (!grab || grab.id !== grabId) {
    return false;
  }
  const { options } = grab;
  switch (event.kind) {
    case "key":
      options.onKey?.(withoutNulls(event));
      return options.onKey !== undefined;
    case "pointerMotion":
      options.onPointerMotion?.(withoutNulls(event));
      return options.onPointerMotion !== undefined;
    case "pointerButton":
      options.onPointerButton?.(withoutNulls(event));
      return options.onPointerButton !== undefined;
    case "scroll":
      options.onScroll?.(withoutNulls(event));
      return options.onScroll !== undefined;
    case "swipe":
      options.onSwipe?.(event.event);
      return options.onSwipe !== undefined;
    case "cancel":
      current = null;
      options.onCancel?.(event.reason);
      return true;
  }
}

/** Runtime side: forget the grab (the compositor drops it on reload). */
export function resetInputGrab(): void {
  current = null;
}

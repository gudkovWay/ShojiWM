import { ENV_CONTROLLER } from "./env";
import { requestPointerWarp } from "./runtime-hooks";
import type {
  CursorConfig,
  CursorController,
  RuntimeCursorConfigUpdate,
} from "./types";

const DEFAULT_CURSOR_THEME = "default";
const DEFAULT_CURSOR_SIZE = 24;
const MAX_CURSOR_SIZE = 512;

function initialConfig(): CursorConfig {
  const theme = ENV_CONTROLLER.get("XCURSOR_THEME")?.trim();
  const size = Number(ENV_CONTROLLER.get("XCURSOR_SIZE"));
  return {
    theme: theme || DEFAULT_CURSOR_THEME,
    size:
      Number.isInteger(size) && size >= 1 && size <= MAX_CURSOR_SIZE
        ? size
        : DEFAULT_CURSOR_SIZE,
  };
}

let currentConfig: CursorConfig = initialConfig();
let pendingConfig: RuntimeCursorConfigUpdate | undefined;

function normalizeConfig(config: CursorConfig): CursorConfig {
  const theme = String(config.theme).trim();
  if (!theme || theme.includes("\0")) {
    throw new Error("cursor theme must be a non-empty string without NUL bytes");
  }

  const size = Number(config.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_CURSOR_SIZE) {
    throw new Error(
      `cursor size must be an integer between 1 and ${MAX_CURSOR_SIZE}`,
    );
  }

  return { theme, size };
}

function cloneConfig(config: CursorConfig): CursorConfig {
  return { theme: config.theme, size: config.size };
}

function publishCursorEnvironment(config: CursorConfig): void {
  ENV_CONTROLLER.apply({
    XCURSOR_THEME: config.theme,
    XCURSOR_SIZE: config.size,
  });
  ENV_CONTROLLER.publish(["XCURSOR_THEME", "XCURSOR_SIZE"]);
}

export const CURSOR_CONTROLLER: CursorController = {
  configure(config) {
    currentConfig = normalizeConfig(config);
    publishCursorEnvironment(currentConfig);
    pendingConfig = { ...currentConfig, reload: false };
  },
  reload() {
    publishCursorEnvironment(currentConfig);
    pendingConfig = { ...currentConfig, reload: true };
  },
  warp(position) {
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("cursor warp position must be finite x/y coordinates");
    }
    requestPointerWarp({ x, y });
  },
};

export function takePendingCursorConfig():
  | RuntimeCursorConfigUpdate
  | undefined {
  const pending = pendingConfig;
  pendingConfig = undefined;
  return pending ? { ...pending } : undefined;
}

export function currentCursorConfig(): CursorConfig {
  return cloneConfig(currentConfig);
}

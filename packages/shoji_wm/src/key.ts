import type {
  KeyBindingController,
  KeyBindingEventPhase,
  KeyBindingOptions,
  KeyBindingRepeat,
} from "./types";

interface RuntimeKeyBindingConfigEntry {
  id: string;
  shortcut: string;
  on: KeyBindingEventPhase;
  repeat?: KeyBindingRepeat;
}

type KeyBindingHandler = () => void;

let desiredKeyBindingEntries = new Map<string, RuntimeKeyBindingConfigEntry>();
let desiredKeyBindingHandlers = new Map<string, KeyBindingHandler>();
let stagedKeyBindingEntries: Map<string, RuntimeKeyBindingConfigEntry> | null = null;
let stagedKeyBindingHandlers: Map<string, KeyBindingHandler> | null = null;
let pendingKeyBindingConfig = false;

function registrationEntriesTarget(): Map<string, RuntimeKeyBindingConfigEntry> {
  return stagedKeyBindingEntries ?? desiredKeyBindingEntries;
}

function registrationHandlersTarget(): Map<string, KeyBindingHandler> {
  return stagedKeyBindingHandlers ?? desiredKeyBindingHandlers;
}

function normalizeShortcut(shortcut: string): string {
  const parts = shortcut
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new Error("key binding shortcut must not be empty");
  }

  return parts.join("+");
}

function normalizePhase(options: KeyBindingOptions | undefined): KeyBindingEventPhase {
  return options?.on ?? "press";
}

/**
 * Validate the numeric shape of a repeat option. Shortcut-kind legality
 * (modifier-only / wheel / release) is enforced by the native compiler, which
 * owns shortcut parsing; here we only reject values that would not survive
 * serialization (NaN/Infinity) or are nonsensical.
 */
function normalizeRepeat(
  options: KeyBindingOptions | undefined,
): KeyBindingRepeat | undefined {
  const repeat = options?.repeat;
  if (!repeat) {
    return undefined;
  }
  if (!Number.isFinite(repeat.delayMs) || repeat.delayMs < 0) {
    throw new Error("key binding repeat delayMs must be a nonnegative finite number");
  }
  if (!Number.isFinite(repeat.intervalMs) || repeat.intervalMs <= 0) {
    throw new Error("key binding repeat intervalMs must be a positive finite number");
  }
  return { delayMs: repeat.delayMs, intervalMs: repeat.intervalMs };
}

function cloneConfigEntry(
  entry: RuntimeKeyBindingConfigEntry,
): RuntimeKeyBindingConfigEntry {
  return {
    ...entry,
    repeat: entry.repeat ? { ...entry.repeat } : undefined,
  };
}

export const KEY_BINDING_CONTROLLER: KeyBindingController = {
  bind(id, shortcut, handler, options) {
    if (!id.trim()) {
      throw new Error("key binding id must not be empty");
    }

    const entry: RuntimeKeyBindingConfigEntry = {
      id,
      shortcut: normalizeShortcut(shortcut),
      on: normalizePhase(options),
      repeat: normalizeRepeat(options),
    };

    registrationEntriesTarget().set(id, entry);
    registrationHandlersTarget().set(id, handler);

    if (!stagedKeyBindingEntries) {
      pendingKeyBindingConfig = true;
    }
  },
};

export function beginKeyBindingRegistration(): void {
  stagedKeyBindingEntries = new Map();
  stagedKeyBindingHandlers = new Map();
}

export function commitKeyBindingRegistration(): void {
  if (!stagedKeyBindingEntries || !stagedKeyBindingHandlers) {
    return;
  }

  desiredKeyBindingEntries = stagedKeyBindingEntries;
  desiredKeyBindingHandlers = stagedKeyBindingHandlers;
  stagedKeyBindingEntries = null;
  stagedKeyBindingHandlers = null;
  pendingKeyBindingConfig = true;
}

export function takePendingKeyBindingConfig():
  | RuntimeKeyBindingConfigEntry[]
  | undefined {
  if (!pendingKeyBindingConfig) {
    return undefined;
  }

  pendingKeyBindingConfig = false;
  return Array.from(desiredKeyBindingEntries.values())
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(cloneConfigEntry);
}

export function invokeKeyBinding(bindingId: string): boolean {
  const handler = desiredKeyBindingHandlers.get(bindingId);
  if (!handler) {
    return false;
  }

  handler();
  return true;
}

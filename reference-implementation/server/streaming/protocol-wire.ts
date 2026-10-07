// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface ReferenceWireViewportPayload {
  deviceScaleFactor?: number;
  hasTouch?: boolean;
  height: number;
  mobile?: true;
  screenHeight?: number;
  screenWidth?: number;
  userAgent?: string;
  width: number;
}

const MAX_INPUT_TEXT_LENGTH = 16_384;
const MAX_INPUT_COORDINATE = 32_768;
const MAX_INPUT_STRING_LENGTH = 512;
const MAX_WIRE_SEQ = Number.MAX_SAFE_INTEGER;
// X11 keysyms are 29-bit values (Unicode keysyms are 0x01000000 + code point).
const MAX_KEYSYM = 0x1f_ff_ff_ff;

// "string-list" is a bounded array of enum strings; it is the only non-scalar
// kind, and its items are checked like a "string" field with `enum`.
type FieldKind = "string" | "number" | "boolean" | "string-list";

interface FieldSpec {
  readonly kind: FieldKind;
  readonly enum?: ReadonlySet<string>;
  readonly max?: number;
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly min?: number;
}

interface TypeSpec {
  // Fields every event of this type must include.
  readonly required: ReadonlySet<string>;
  // At least one of these fields must be present.
  readonly requiredAnyOf?: readonly string[];
  // Validator for each allowed field (required or optional). A key absent
  // from this map is not an allowed field.
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

// Fields carried by every wire input event regardless of type: telemetry
// correlation only, never interpreted as CDP input.
const COMMON_FIELDS: Readonly<Record<string, FieldSpec>> = {
  correlationId: { kind: "string", maxLength: MAX_INPUT_STRING_LENGTH },
  type: { kind: "string", maxLength: MAX_INPUT_STRING_LENGTH },
  wireSeq: { kind: "number", max: MAX_WIRE_SEQ, min: 0 },
};

const COORDINATE: FieldSpec = { kind: "number", max: MAX_INPUT_COORDINATE, min: -MAX_INPUT_COORDINATE };
const DELTA: FieldSpec = { kind: "number", max: MAX_INPUT_COORDINATE, min: -MAX_INPUT_COORDINATE };

// The pointer, keyboard, and text shapes below are the Remote Surface input
// protocol (`RemoteSurfaceInputPayload`) that the console viewer sends
// unchanged; cdp-adapter.ts also checks them with that library's own parser.
// Modifiers are a list of key names, not a CDP bitmask: the library's CDP
// backend builds the mask itself.
const MODIFIERS: FieldSpec = {
  enum: new Set(["Alt", "Control", "Meta", "Shift"]),
  kind: "string-list",
  maxItems: 4,
};
const TIMESTAMP: FieldSpec = { kind: "number", max: MAX_WIRE_SEQ, min: 0 };

// Closed, type-specific schemas. Each event type dispatched to a CDP command
// (directly or via the Remote Surface backend) is validated against its own
// allowed-field set, required fields, action enum, and bounded numeric/string
// ranges before `cdp-adapter.ts`'s `dispatch()` ever sees it.
const TYPE_SPECS: Record<string, TypeSpec> = {
  clipboard: {
    fields: {
      ...COMMON_FIELDS,
      action: { enum: new Set(["local_to_remote", "remote_to_local"]), kind: "string" },
      text: { kind: "string", maxLength: MAX_INPUT_TEXT_LENGTH },
    },
    required: new Set(["action"]),
  },
  // The neko viewer's remote-copy fallback posts a bare `{ type: "copy" }`.
  copy: {
    fields: { ...COMMON_FIELDS },
    required: new Set(),
  },
  keyboard: {
    fields: {
      ...COMMON_FIELDS,
      action: { enum: new Set(["keydown", "keypress", "keyup"]), kind: "string" },
      code: { kind: "string", maxLength: MAX_INPUT_STRING_LENGTH },
      key: { kind: "string", maxLength: MAX_INPUT_STRING_LENGTH },
      // The soft-keyboard bridge sends special keys (Backspace, Enter) as X11
      // keysyms with no `key`.
      keysym: { kind: "number", max: MAX_KEYSYM, min: 0 },
      location: { kind: "number", max: 3, min: 0 },
      modifiers: MODIFIERS,
      repeat: { kind: "boolean" },
      timestamp: TIMESTAMP,
    },
    required: new Set(["action"]),
    requiredAnyOf: ["key", "code", "keysym"],
  },
  mouse: {
    fields: {
      ...COMMON_FIELDS,
      action: { enum: new Set(["click", "dblclick", "mousedown", "mousemove", "mouseup"]), kind: "string" },
      button: { kind: "number", max: 2, min: 0 },
      x: COORDINATE,
      y: COORDINATE,
    },
    required: new Set(["action", "x", "y"]),
  },
  paste: {
    fields: {
      ...COMMON_FIELDS,
      text: { kind: "string", maxLength: MAX_INPUT_TEXT_LENGTH },
    },
    required: new Set(["text"]),
  },
  pointer: {
    fields: {
      ...COMMON_FIELDS,
      action: { enum: new Set(["pointercancel", "pointerdown", "pointermove", "pointerup", "wheel"]), kind: "string" },
      button: { kind: "number", max: 4, min: -1 },
      buttons: { kind: "number", max: 31, min: 0 },
      clickCount: { kind: "number", max: 16, min: 0 },
      deltaX: DELTA,
      deltaY: DELTA,
      gestureBoundary: { kind: "boolean" },
      height: { kind: "number", max: MAX_INPUT_COORDINATE, min: 0 },
      modifiers: MODIFIERS,
      pointerId: { kind: "number", max: MAX_WIRE_SEQ, min: 0 },
      pointerType: { enum: new Set(["mouse", "pen", "touch"]), kind: "string" },
      pressure: { kind: "number", max: 1, min: 0 },
      source: { kind: "string", maxLength: MAX_INPUT_STRING_LENGTH },
      tiltX: { kind: "number", max: 90, min: -90 },
      tiltY: { kind: "number", max: 90, min: -90 },
      timestamp: TIMESTAMP,
      width: { kind: "number", max: MAX_INPUT_COORDINATE, min: 0 },
      x: COORDINATE,
      y: COORDINATE,
    },
    required: new Set(["action", "x", "y"]),
  },
  scroll: {
    fields: {
      ...COMMON_FIELDS,
      deltaX: DELTA,
      deltaY: DELTA,
      x: COORDINATE,
      y: COORDINATE,
    },
    required: new Set(["deltaX", "deltaY", "x", "y"]),
  },
  text: {
    fields: {
      ...COMMON_FIELDS,
      action: { enum: new Set(["commit", "start", "update"]), kind: "string" },
      composition: { enum: new Set(["cancel", "commit", "start", "update"]), kind: "string" },
      text: { kind: "string", maxLength: MAX_INPUT_TEXT_LENGTH },
      timestamp: TIMESTAMP,
    },
    required: new Set(["text"]),
  },
  touch: {
    fields: {
      ...COMMON_FIELDS,
      action: { enum: new Set(["touchend", "touchmove", "touchstart"]), kind: "string" },
      id: { kind: "number", max: MAX_WIRE_SEQ, min: 0 },
      x: COORDINATE,
      y: COORDINATE,
    },
    required: new Set(["action", "x", "y"]),
  },
  viewport: {
    fields: {
      ...COMMON_FIELDS,
      deviceScaleFactor: { kind: "number", max: 8, min: 0 },
      hasTouch: { kind: "boolean" },
      height: { kind: "number", max: MAX_INPUT_COORDINATE, min: 1 },
      mobile: { kind: "boolean" },
      screenHeight: { kind: "number", max: MAX_INPUT_COORDINATE, min: 1 },
      screenWidth: { kind: "number", max: MAX_INPUT_COORDINATE, min: 1 },
      userAgent: { kind: "string", maxLength: MAX_INPUT_STRING_LENGTH },
      width: { kind: "number", max: MAX_INPUT_COORDINATE, min: 1 },
    },
    required: new Set(["height", "width"]),
  },
};

function invalidInput(): Error & { code: string } {
  const error = new Error("Input event is malformed or exceeds supported limits") as Error & { code: string };
  error.code = "invalid_input";
  return error;
}

function validateField(key: string, value: unknown, spec: FieldSpec): void {
  if (spec.kind === "string-list") {
    if (!Array.isArray(value) || value.length > (spec.maxItems ?? 0)) {
      throw invalidInput();
    }
    for (const item of value) {
      validateField(key, item, { kind: "string", ...(spec.enum ? { enum: spec.enum } : {}) });
    }
    return;
  }
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") {
      throw invalidInput();
    }
    return;
  }
  if (spec.kind === "string") {
    if (typeof value !== "string") {
      throw invalidInput();
    }
    if (value.length > (spec.maxLength ?? MAX_INPUT_STRING_LENGTH)) {
      throw invalidInput();
    }
    if (spec.enum && !spec.enum.has(value)) {
      throw invalidInput();
    }
    return;
  }
  // kind === "number"
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidInput();
  }
  if (spec.min !== undefined && value < spec.min) {
    throw invalidInput();
  }
  if (spec.max !== undefined && value > spec.max) {
    throw invalidInput();
  }
  void key;
}

export function parseReferenceWireInputPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput();
  }
  const input = value as Record<string, unknown>;
  const spec = typeof input.type === "string" ? TYPE_SPECS[input.type] : undefined;
  if (!spec) {
    throw invalidInput();
  }
  for (const key of Object.keys(input)) {
    const fieldSpec = spec.fields[key];
    if (!fieldSpec) {
      throw invalidInput();
    }
    // Every allowed field must match its declared kind: a primitive, or for
    // "string-list" a bounded array of enum strings. Other nested objects or
    // arrays (e.g. `{ x: { nested: "x" } }`) are rejected before dispatch
    // rather than silently passed through.
    validateField(key, input[key], fieldSpec);
  }
  for (const key of spec.required) {
    if (!(key in input)) {
      throw invalidInput();
    }
  }
  if (spec.requiredAnyOf && !spec.requiredAnyOf.some((key) => key in input)) {
    throw invalidInput();
  }
  return input;
}

export function normalizeReferenceWireViewportPayload(value: unknown): ReferenceWireViewportPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const width = Math.floor(Number(input.width));
  const height = Math.floor(Number(input.height));
  if (!(Number.isFinite(width) && Number.isFinite(height)) || width <= 0 || height <= 0) {
    return null;
  }

  const viewport: ReferenceWireViewportPayload = {
    height,
    width,
  };
  const deviceScaleFactor = Number(input.deviceScaleFactor);
  if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
    viewport.deviceScaleFactor = deviceScaleFactor;
  }
  const screenWidth = Number(input.screenWidth);
  if (Number.isFinite(screenWidth) && screenWidth > 0) {
    viewport.screenWidth = Math.max(viewport.width, Math.floor(screenWidth));
  }
  const screenHeight = Number(input.screenHeight);
  if (Number.isFinite(screenHeight) && screenHeight > 0) {
    viewport.screenHeight = Math.max(viewport.height, Math.floor(screenHeight));
  }
  if (typeof input.hasTouch === "boolean") {
    viewport.hasTouch = input.hasTouch;
  }
  if (input.mobile === true) {
    viewport.mobile = true;
  }
  if (typeof input.userAgent === "string" && input.userAgent.length > 0) {
    viewport.userAgent = input.userAgent.slice(0, 512);
  }
  return viewport;
}

export function parseReferenceWireInputTelemetryCursor(value: unknown): { since: number } {
  const sinceRaw = typeof value === "string" ? Number(value) : 0;
  return { since: Number.isFinite(sinceRaw) ? sinceRaw : 0 };
}

export function buildReferenceWireAttachedPayload({
  runId,
  interactionId,
  browserSessionId,
  viewport,
}: {
  runId: string;
  interactionId: string;
  browserSessionId: string;
  viewport: unknown;
}): JsonObject {
  return {
    browser_session_id: browserSessionId,
    interaction_id: interactionId,
    run_id: runId,
    viewport: toJsonValueOrNull(viewport),
  };
}

export function buildReferenceWireFramePayload(frame: {
  sessionId?: unknown;
  data?: unknown;
  metadata?: unknown;
}): JsonObject {
  return {
    data_base64: typeof frame.data === "string" ? frame.data : "",
    metadata: frame.metadata ? toJsonValueOrNull(frame.metadata) : null,
    session_id: typeof frame.sessionId === "number" ? frame.sessionId : Number(frame.sessionId),
  };
}

export function buildReferenceWireCompanionEventPayload(event: unknown): { name: string; data: unknown } | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, unknown>;
  if (typeof record.kind !== "string") {
    return null;
  }

  switch (record.kind) {
    case "url_changed": {
      const data: Record<string, JsonValue> = {
        url: typeof record.url === "string" ? record.url : "",
      };
      if (typeof record.title === "string") {
        data.title = record.title;
      }
      return { data, name: "url_changed" };
    }
    case "popup_opened":
      return {
        data: {
          targetId: typeof record.targetId === "string" ? record.targetId : "",
          url: typeof record.url === "string" ? record.url : "",
        },
        name: "popup_opened",
      };
    case "popup_closed":
      return {
        data: { targetId: typeof record.targetId === "string" ? record.targetId : "" },
        name: "popup_closed",
      };
    case "keyboard_focus":
      return {
        data:
          record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
            ? record.payload
            : { focused: record.focused === true },
        name: "keyboard_focus",
      };
    default:
      return { data: event, name: record.kind };
  }
}

export function buildReferenceWireBackendReadyPayload({
  backend,
  token,
  browserOwnerMode,
  stealthMode,
}: {
  backend: unknown;
  token: string;
  browserOwnerMode?: (() => unknown) | null;
  stealthMode?: (() => unknown) | null;
}): JsonObject {
  const backendName = typeof backend === "string" ? backend : "cdp";
  const encodedToken = encodeURIComponent(token);
  return {
    backend: backendName,
    browser_owner_mode:
      backendName === "neko" && typeof browserOwnerMode === "function" ? nullableString(browserOwnerMode()) : null,
    client_config_path: backendName === "neko" ? `/_ref/run-interaction-streams/${encodedToken}/neko/session` : null,
    iframe_path: backendName === "neko" ? `/_ref/run-interaction-streams/${encodedToken}/neko` : null,
    stealth_mode: backendName === "neko" && typeof stealthMode === "function" ? nullableString(stealthMode()) : null,
  };
}

function toJsonValueOrNull(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValueOrNull);
  }
  if (typeof value !== "object") {
    return null;
  }

  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child !== undefined) {
      result[key] = toJsonValueOrNull(child);
    }
  }
  return result;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

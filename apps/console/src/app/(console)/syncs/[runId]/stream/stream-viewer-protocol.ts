// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StreamViewport } from "@opendatalabs/remote-surface/client";
import type { ProtocolParseResult } from "@opendatalabs/remote-surface/protocol";
import type { RunHandleStatus } from "../../../lib/ref-client.ts";

export interface AttachedMessage {
  browser_session_id: string;
  interaction_id: string;
  run_id: string;
  viewport: (StreamViewport & { screenHeight?: number; screenWidth?: number }) | null;
}

type JsonObject = Record<string, unknown>;

function ok<T>(value: T): ProtocolParseResult<T> {
  return { ok: true, value };
}

function err<T>(error: string): ProtocolParseResult<T> {
  return { error, ok: false };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(data: string): ProtocolParseResult<JsonObject> {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isObject(parsed)) {
      return err("payload_not_object");
    }
    return ok(parsed);
  } catch {
    return err("payload_invalid_json");
  }
}

function requiredString(payload: JsonObject, key: string): ProtocolParseResult<string> {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? ok(value) : err(`${key}_missing`);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseViewport(value: unknown): ProtocolParseResult<StreamViewport | null> {
  if (value === null || value === undefined) {
    return ok(null);
  }
  if (!isObject(value)) {
    return err("viewport_invalid");
  }
  const width = optionalNumber(value.width);
  const height = optionalNumber(value.height);
  const screenWidth = optionalNumber(value.screenWidth);
  const screenHeight = optionalNumber(value.screenHeight);
  const viewport = {
    height: typeof height === "number" ? Math.floor(height) : 0,
    width: typeof width === "number" ? Math.floor(width) : 0,
    ...(typeof screenWidth === "number" ? { screenWidth: Math.floor(screenWidth) } : {}),
    ...(typeof screenHeight === "number" ? { screenHeight: Math.floor(screenHeight) } : {}),
  };
  if (!(viewport.width > 0 && viewport.height > 0)) {
    return err("viewport_invalid_dimensions");
  }
  return ok(viewport);
}

export function parseAttachedMessage(data: string): ProtocolParseResult<AttachedMessage> {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return parsed;
  }
  const browserSessionId = requiredString(parsed.value, "browser_session_id");
  const interactionId = requiredString(parsed.value, "interaction_id");
  const runId = requiredString(parsed.value, "run_id");
  const viewport = parseViewport(parsed.value.viewport);
  if (!browserSessionId.ok) {
    return browserSessionId;
  }
  if (!interactionId.ok) {
    return interactionId;
  }
  if (!runId.ok) {
    return runId;
  }
  if (!viewport.ok) {
    return viewport;
  }
  return ok({
    browser_session_id: browserSessionId.value,
    interaction_id: interactionId.value,
    run_id: runId.value,
    viewport: viewport.value,
  });
}

/**
 * `run_ended` SSE payload (reference-implementation
 * server/streaming/protocol-wire.ts `buildReferenceWireRunEndedPayload`).
 * `status` is a run-status value, or `null` when the run ended but no
 * terminal state was readable yet.
 */
export interface RunEndedMessage {
  failure: { message: string | null; reason: string | null } | null;
  run_id: string | null;
  status: RunHandleStatus | null;
  terminal_reason: string | null;
}

function nullableString(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Lenient: a malformed payload still means the run ended, with no detail. */
export function parseRunEndedMessage(data: string): RunEndedMessage | null {
  const parsed = parseJsonObject(data);
  if (!parsed.ok) {
    return null;
  }
  const payload = parsed.value;
  const failure = isObject(payload.failure)
    ? { message: nullableString(payload.failure, "message"), reason: nullableString(payload.failure, "reason") }
    : null;
  return {
    failure,
    run_id: nullableString(payload, "run_id"),
    status: nullableString(payload, "status") as RunHandleStatus | null,
    terminal_reason: nullableString(payload, "terminal_reason"),
  };
}

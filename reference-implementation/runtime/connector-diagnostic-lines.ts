// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded collector for connector diagnostic lines.
//
// Connectors write technical detail through the polyfill-connectors helper
// `connectorDiagnostic()` (data-connectors
// `packages/polyfill-connectors/src/connector-diagnostic.ts`). The helper
// writes one stderr line per diagnostic:
//
//   [<source>-diagnostic] <event> {"key":"value",...}
//
// The connector protocol has no LOG message, and the collection profile (§4)
// says stderr is diagnostic only. The stderr tail (`stderr-tail.ts`) keeps
// the last 16 KiB, but the runtime persists it only on `run.failed`. This
// collector keeps the diagnostic lines for every run, so a completed run
// still has its detail. The runtime persists them as one owner-local
// `run.connector_diagnostics_recorded` spine event before the terminal event.
//
// This is an interim, reference-runtime-only shape. A later structured
// failure-diagnosis format will replace it inside the helper and the runtime;
// connectors that call `connectorDiagnostic()` do not change.
//
// Invariants:
//   - Only lines that start with the helper's prefix are kept. Other stderr
//     (stack traces, library noise) stays in the stderr tail only.
//   - Memory is bounded: at most `maxLines` lines and `maxBytes` UTF-8 bytes
//     are kept, the oldest are evicted first, and a partial line is
//     discarded once it is longer than `maxLineChars`.
//   - Counts say what was lost: `lines_observed` counts every diagnostic
//     line seen, `truncated` is true iff some were evicted or cut.
//   - The collector does not redact. The caller redacts each kept line with
//     `redactConnectorDiagnosticLine` before it persists them.

import { StringDecoder } from "node:string_decoder";
import { redactStderrTail } from "./stderr-redact.ts";

/** Matches the prefix `formatConnectorDiagnostic()` writes. */
export const CONNECTOR_DIAGNOSTIC_LINE_RE = /^\[[A-Za-z0-9_.:-]{1,80}-diagnostic\] \S/;

/** The helper caps a line at 2000 characters; match it. */
export const CONNECTOR_DIAGNOSTIC_MAX_LINE_CHARS = 2000;
export const CONNECTOR_DIAGNOSTIC_MAX_LINES = 200;
export const CONNECTOR_DIAGNOSTIC_MAX_BYTES = 32 * 1024;

export interface ConnectorDiagnosticLines {
  readonly lines: string[];
  readonly lines_observed: number;
  readonly truncated: boolean;
}

export interface ConnectorDiagnosticLineCollector {
  append: (chunk: Buffer | string | null | undefined) => void;
  finalize: () => ConnectorDiagnosticLines;
}

export function createConnectorDiagnosticLineCollector({
  maxBytes = CONNECTOR_DIAGNOSTIC_MAX_BYTES,
  maxLineChars = CONNECTOR_DIAGNOSTIC_MAX_LINE_CHARS,
  maxLines = CONNECTOR_DIAGNOSTIC_MAX_LINES,
}: {
  maxBytes?: number;
  maxLineChars?: number;
  maxLines?: number;
} = {}): ConnectorDiagnosticLineCollector {
  const decoder = new StringDecoder("utf8");
  const kept: string[] = [];
  let keptBytes = 0;
  let observed = 0;
  let truncated = false;
  let pending = "";
  // True while the current partial line has outgrown `maxLineChars`; the
  // rest of that line is dropped up to the next newline.
  let pendingOverflow = false;

  function take(rawLine: string, cut: boolean): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!CONNECTOR_DIAGNOSTIC_LINE_RE.test(line)) {
      return;
    }
    observed += 1;
    let text = line;
    if (cut || text.length > maxLineChars) {
      text = `${text.slice(0, maxLineChars - 1)}…`;
      truncated = true;
    }
    kept.push(text);
    keptBytes += Buffer.byteLength(text, "utf8");
    while (kept.length > maxLines || (keptBytes > maxBytes && kept.length > 0)) {
      const evicted = kept.shift() ?? "";
      keptBytes -= Buffer.byteLength(evicted, "utf8");
      truncated = true;
    }
  }

  function consume(text: string): void {
    let start = 0;
    let newline = text.indexOf("\n", start);
    while (newline !== -1) {
      const piece = text.slice(start, newline);
      if (pendingOverflow) {
        take(pending, true);
      } else {
        take(pending + piece, false);
      }
      pending = "";
      pendingOverflow = false;
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (pendingOverflow) {
      return;
    }
    pending += text.slice(start);
    if (pending.length > maxLineChars) {
      pending = pending.slice(0, maxLineChars);
      pendingOverflow = true;
    }
  }

  return {
    append(chunk) {
      if (!chunk) {
        return;
      }
      consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
    },
    finalize() {
      consume(decoder.end());
      if (pending.length > 0) {
        take(pending, pendingOverflow);
        pending = "";
        pendingOverflow = false;
      }
      return { lines: [...kept], lines_observed: observed, truncated };
    },
  };
}

// ─── Redaction ───────────────────────────────────────────────────────────────
//
// `redactStderrTail` alone would destroy these lines: its long-opaque rule
// eats any 24+ character `[A-Za-z0-9_-]` run, and the source prefix
// (`amazon-orders-diagnostic`), the event code and the JSON keys are often
// that long. stderr-redact.ts records why shape cannot tell a code from a
// name. Here, position can: the helper puts code-authored strings (source,
// event, field names) in fixed slots and data in the JSON values.
//
// So:
//   - Source, event and keys are kept when they have a strict code shape and
//     contain none of the run's known secrets. Otherwise they are replaced.
//   - Every string value, and any tail that is not a JSON object, gets the
//     full `redactStderrTail` policy, including identity matching.
//   - A value under a credential-named key (`token`, `accessToken`,
//     `api_key`, ...) is replaced unless it is a boolean or null.
//   - Other numbers, booleans and null are kept: they are the counts and
//     flags the helper exists to carry.

const LINE_PARTS_RE = /^\[([A-Za-z0-9_.:-]{1,80})-diagnostic\] (\S+)(?: (.*))?$/s;
const SOURCE_CODE_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const EVENT_CODE_RE = /^[a-z][a-z0-9_.:-]{0,79}$/;
const KEY_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
// Matched against the snake_case form of a key, word by word, so
// `accessToken` and `api_key` match and `footprint` does not.
const CREDENTIAL_KEY_RE =
  /(^|_)(token|bearer|password|passwd|pwd|passcode|cookie|cookies|secret|otp|authorization|auth|apikey|api_key|credential|credentials|pin)(_|$)/;
const REDACTED = "[REDACTED]";
// Same floor as stderr-redact.ts: shorter values are not matched by identity.
const MIN_MATCHABLE_SECRET_LENGTH = 4;

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_RE.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
}

export interface RedactedDiagnosticLine {
  readonly redacted: boolean;
  readonly text: string;
}

export function redactConnectorDiagnosticLine(line: string, knownSecrets: readonly string[]): RedactedDiagnosticLine {
  const secrets = knownSecrets.filter((secret) => secret.trim().length >= MIN_MATCHABLE_SECRET_LENGTH);
  let redacted = false;
  const code = (value: string, shape: RegExp): string => {
    if (shape.test(value) && !secrets.some((secret) => value.includes(secret))) {
      return value;
    }
    redacted = true;
    return REDACTED;
  };
  const text = (value: string): string => {
    const result = redactStderrTail(value, { knownSecrets: secrets });
    redacted ||= result.redacted;
    return result.text;
  };

  const parts = LINE_PARTS_RE.exec(line);
  if (!parts) {
    return { redacted: true, text: REDACTED };
  }
  const [, source = "", event = "", tail] = parts;
  const head = `[${code(source, SOURCE_CODE_RE)}-diagnostic] ${code(event, EVENT_CODE_RE)}`;
  if (tail === undefined) {
    return { redacted, text: head };
  }

  let fields: unknown = null;
  try {
    fields = JSON.parse(tail);
  } catch {
    fields = null;
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    const redactedTail = text(tail);
    return { redacted, text: `${head} ${redactedTail}` };
  }
  const safe: Record<string, unknown> = {};
  for (const [index, [key, value]] of Object.entries(fields).entries()) {
    // Two replaced keys must not overwrite each other's value.
    const codeKey = code(key, KEY_CODE_RE);
    const safeKey = codeKey === REDACTED ? `[REDACTED_KEY_${index}]` : codeKey;
    if (isCredentialKey(key) && value !== null && typeof value !== "boolean") {
      redacted = true;
      safe[safeKey] = REDACTED;
    } else if (typeof value === "string") {
      safe[safeKey] = text(value);
    } else if (value === null || typeof value === "number" || typeof value === "boolean") {
      safe[safeKey] = value;
    } else {
      safe[safeKey] = text(JSON.stringify(value));
    }
  }
  return { redacted, text: `${head} ${JSON.stringify(safe)}` };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Writable } from "node:stream";

/**
 * Shared safe emit/parse helpers for the PDPP connector JSONL protocol.
 *
 * WHY: Node.js 24+ `readline.createInterface()` treats U+2028 (LINE SEPARATOR)
 * and U+2029 (PARAGRAPH SEPARATOR) as line terminators, per ECMA-262's
 * LineTerminator production. `JSON.stringify()` does NOT escape these
 * characters — per RFC 8259 they are valid unescaped inside JSON strings.
 *
 * Collision: if a record's string content contains U+2028 or U+2029 (common
 * in newsletters, PDF-extracted text, or anywhere rich copy-paste lands),
 * the connector emits a valid JSON line but the runtime's readline splits it
 * into multiple 'line' events at the first U+2028/U+2029 byte sequence, and
 * `JSON.parse` fails on the partial first chunk with "Unterminated string".
 *
 * The fix is trivial: post-stringify, escape the two characters. `JSON.parse`
 * accepts `\u2028` / `\u2029` escape sequences, so this round-trips cleanly.
 *
 * Every PDPP connector MUST use `stringifyForJsonl(msg)` instead of raw
 * `JSON.stringify(msg)`. Prefer `emitToStdout(msg)` which bundles stringify
 * + write + backpressure handling.
 *
 * Root-cause details: see design-notes/gmail-jsonl-truncation-bug.md
 */

// Captures U+2028 AND U+2029. Global flag so all occurrences get escaped.
const JSONL_TERMINATOR = /[\u2028\u2029]/g;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * JSON.stringify replacer that normalizes BigInt values. Native JSON.stringify
 * throws "Do not know how to serialize a BigInt" otherwise, which caused a
 * whole-run failure in Gmail (imapflow returns UIDVALIDITY / HIGHESTMODSEQ as
 * BigInt and those landed in a STATE cursor).
 *
 * Policy: values inside JS safe-integer range become Number (the normal case
 * — fits downstream consumers that expect JSON numbers). Values outside the
 * safe range become String, which preserves precision for IDs like Gmail's
 * X-GM-MSGID, Twitter snowflakes, or SQLite rowids that exceed 2^53.
 */
function bigIntSafeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
  }
  return value;
}

function escapeJsonlTerminator(c: string): string {
  return c === "\u2028" ? "\\u2028" : "\\u2029";
}

/**
 * Serialize a message object to a JSONL-safe line (with trailing `\n`).
 * Output is guaranteed not to contain U+2028 / U+2029 in any position, and
 * any BigInt values are coerced to Number or String.
 */
export function stringifyForJsonl(msg: unknown): string {
  return `${JSON.stringify(msg, bigIntSafeReplacer).replace(JSONL_TERMINATOR, escapeJsonlTerminator)}\n`;
}

/**
 * Write one complete JSONL frame. Acceptance into the writable buffer is
 * not completion: settle from the callback, or reject if the sink fails first.
 */
export function emitToStdout(msg: unknown, sink: Writable = process.stdout): Promise<void> {
  const line = stringifyForJsonl(msg);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      sink.off("error", onError);
      sink.off("close", onClose);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const onError = (error: Error) => {
      cleanup();
      fail(error);
    };
    const onClose = () => {
      cleanup();
      fail(new Error("sink closed before JSONL write completed"));
    };
    sink.once("error", onError);
    sink.once("close", onClose);
    try {
      sink.write(line, (error) => {
        if (settled) {
          return;
        }
        if (error) {
          fail(error);
          // Node can emit this same write error after invoking the callback.
          // Leave the listener in place for that turn, including for stdout.
          setImmediate(cleanup);
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
    } catch (error) {
      cleanup();
      settled = true;
      reject(error);
    }
  });
}

/**
 * Parse a JSONL line produced by a PDPP connector. Equivalent to JSON.parse
 * but exposed as a named export so runtime callers can prove they're using
 * the same parser the connectors expect.
 *
 * JSON.parse accepts `\u2028` / `\u2029` escape sequences natively.
 */
export function parseJsonlLine(line: string): unknown {
  return JSON.parse(line);
}

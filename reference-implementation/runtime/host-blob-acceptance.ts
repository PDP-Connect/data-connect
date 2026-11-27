// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * BLOB -> RECORD acceptance rules for the reference runtime.
 *
 * A connector that declares the BLOB protocol capability closes a spool file,
 * emits a BLOB descriptor, and emits the RECORD that references the file as the
 * next record message. This module decides, for each message the runtime reads,
 * whether that order holds. It is pure: it holds no bytes, does no I/O and never
 * stores anything. The caller verifies the spool bytes and uploads them; this
 * module only says when a message is allowed.
 *
 * The rules (modelled in `docs/formal/host-blob-acceptance/HostBlobAcceptance.tla`,
 * checked with TLC):
 *
 * - At most one BLOB is held. A second BLOB before the RECORD is a violation.
 * - The held BLOB binds to the next RECORD, which must carry the same stream and
 *   key and must reference the blob. Any other RECORD is a violation.
 * - PROGRESS does not touch the held BLOB. Every other message type is a
 *   violation while a BLOB is held, because each could commit or end the run
 *   with a blob that has no record.
 * - A RECORD that references a host blob while none is held is a violation, so
 *   a record never carries a reference to a blob the host did not receive. A
 *   host blob reference is a `blob_ref` whose `blob_id` is `sha256:<hex>`, the
 *   form a connector writes before the host has stored the bytes.
 * - Nothing is durable while a BLOB is held. If the run ends, the held blob is
 *   dropped with the run's spool directory.
 *
 * A violation fails the run, like every other connector protocol violation.
 */

import { recordKeysEqual } from "@pdpp/connector-protocol/connector-runtime-protocol";

type RecordKey = string | readonly string[];

const HOST_BLOB_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** A RECORD's `blob_ref` object, as the connector wrote it. */
export interface HostBlobRef {
  readonly blob_id: string;
  readonly mime_type?: unknown;
  readonly sha256?: unknown;
  readonly size_bytes?: unknown;
  readonly [field: string]: unknown;
}

/**
 * The record's `data.blob_ref` when it is a host blob reference (`blob_id` in
 * the `sha256:<hex>` form), else null. A `blob_ref` in any other form names a
 * blob the connector stored itself and is not this module's concern.
 */
export function hostBlobRefOf(data: unknown): HostBlobRef | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const ref = (data as Record<string, unknown>).blob_ref;
  if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
    return null;
  }
  const blobId = (ref as Record<string, unknown>).blob_id;
  return typeof blobId === "string" && HOST_BLOB_ID_RE.test(blobId) ? (ref as HostBlobRef) : null;
}

/** What the host holds between a BLOB and its RECORD. */
export interface HeldHostBlob<Bytes> {
  readonly bytes: Bytes;
  readonly key: RecordKey;
  readonly mimeType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly stream: string;
}

export type HostBlobEvent<Bytes> =
  | { readonly kind: "blob"; readonly blob: HeldHostBlob<Bytes> }
  | { readonly kind: "record"; readonly key: RecordKey; readonly refsHostBlob: boolean; readonly stream: string }
  | { readonly kind: "message"; readonly type: string };

export type HostBlobDecision<Bytes> =
  /** No blob is involved; handle the message as before. */
  | { readonly action: "pass" }
  /** The BLOB is held until its RECORD arrives. */
  | { readonly action: "hold" }
  /** The RECORD consumes the held blob: upload it, then accept the record. */
  | { readonly action: "bind"; readonly blob: HeldHostBlob<Bytes> }
  | { readonly action: "violation"; readonly reason: string };

/** Message types that may arrive while a BLOB is held. */
const PASS_WHILE_HELD: ReadonlySet<string> = new Set(["PROGRESS"]);

export interface HostBlobAcceptance<Bytes> {
  /** Decide one message. A `bind` or `violation` clears the held blob. */
  decide(event: HostBlobEvent<Bytes>): HostBlobDecision<Bytes>;
  /** The held blob, or null. */
  held(): HeldHostBlob<Bytes> | null;
  /** Drop the held blob when the run ends. */
  release(): void;
}

export function createHostBlobAcceptance<Bytes>(): HostBlobAcceptance<Bytes> {
  let held: HeldHostBlob<Bytes> | null = null;

  function violation(reason: string): HostBlobDecision<Bytes> {
    held = null;
    return { action: "violation", reason };
  }

  function decideBlob(blob: HeldHostBlob<Bytes>): HostBlobDecision<Bytes> {
    if (held) {
      return violation("Connector emitted a second BLOB before the RECORD for the first");
    }
    held = blob;
    return { action: "hold" };
  }

  function decideRecord(event: Extract<HostBlobEvent<Bytes>, { kind: "record" }>): HostBlobDecision<Bytes> {
    const blob = held;
    if (!blob) {
      return event.refsHostBlob
        ? violation("Connector emitted a RECORD that references a host blob but no BLOB for it")
        : { action: "pass" };
    }
    if (blob.stream !== event.stream || !recordKeysEqual(blob.key, event.key)) {
      return violation("Connector emitted a RECORD that does not match the BLOB before it");
    }
    if (!event.refsHostBlob) {
      return violation("Connector emitted a BLOB whose RECORD does not reference a host blob");
    }
    held = null;
    return { action: "bind", blob };
  }

  return {
    decide(event) {
      if (event.kind === "blob") {
        return decideBlob(event.blob);
      }
      if (event.kind === "record") {
        return decideRecord(event);
      }
      if (held && !PASS_WHILE_HELD.has(event.type)) {
        return violation(`Connector emitted ${event.type} between a BLOB and its RECORD`);
      }
      return { action: "pass" };
    },
    held: () => held,
    release() {
      held = null;
    },
  };
}

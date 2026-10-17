// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reliance record: the trust signal an authorization server relied on when it
 * accepted a client's identity.
 *
 * spec-core.md#trust-registry-queries: "An authorization server records the trust
 * signal it relied on — subject, role or scope, status, governance-framework URI,
 * issuer or trust-anchor identifier, `valid_from`, `valid_until`, and the time of
 * lookup — on its acceptance record or resulting grant. The lookup time matters
 * because a status may be withdrawn later, and the record has to show what was true
 * when the server relied on it."
 *
 * The one signal this server produces today is verified domain control, obligation 5
 * of spec-core.md#client-display: where the AS retrieved a client's metadata document
 * from the https URL the client claims as its identity and the document names that
 * same client_id back, "the AS has verified that the client controls that domain."
 *
 * Why this is its own module and not a field on the resolved grant: `grant_json` is
 * validated on every read against `ResolvedGrantSchema`, which is
 * `additionalProperties: false` and ships from a vendored tarball this repo does not
 * author. An extra member there would fail every existing grant read. The reliance
 * record is therefore persisted beside the grant, in `grants.trust_signal_json`, the
 * same way `storage_binding_json` is.
 */

/** Governance framework under which domain control is conferred. */
const DOMAIN_CONTROL_FRAMEWORK_URI =
  "https://pdpp.dev/trust/framework/client-id-metadata-document";

/**
 * How the AS obtained the metadata document it relied on. Both establish domain
 * control; they differ in whether the document crossed the network, which is the
 * provenance a relying party needs to reproduce the decision.
 */
export type TrustSignalMethod = "same_origin_document" | "https_document_fetch";

export interface TrustSignal {
  /** Governance framework under which the issuer conferred the status, by URI. */
  framework_uri: string;
  /** Trust-anchor identifier: who conferred the status. The AS, by direct retrieval. */
  issuer: string;
  /** RFC 3339 instant the signal was looked up. A status may be withdrawn later. */
  looked_up_at: string;
  /** Which retrieval branch established the signal. */
  method: TrustSignalMethod;
  /** What the subject is authorized to do under this status. */
  role: string;
  /** The status itself. */
  status: string;
  /** Who the assertion is about: the client identity URL. */
  subject: string;
  /** Start of the validity window. Retrieval establishes control as of that instant. */
  valid_from: string;
  /**
   * End of the validity window, or null when the signal is not self-expiring.
   * Domain control is a point-in-time observation: it is true when observed and
   * carries no issuer-declared expiry, so an honest record says so rather than
   * inventing a horizon.
   */
  valid_until: string | null;
}

/**
 * Build the reliance record for verified domain control.
 *
 * `issuer` is the AS's own identity because no third party asserted this: the server
 * observed it directly by retrieving the document. When a real registry is consulted
 * one day, that issuer is the registry, and only this function changes.
 */
export function buildDomainControlTrustSignal(input: {
  clientId: string;
  issuer: string;
  lookedUpAt: string;
  method: TrustSignalMethod;
}): TrustSignal {
  return {
    framework_uri: DOMAIN_CONTROL_FRAMEWORK_URI,
    issuer: input.issuer,
    looked_up_at: input.lookedUpAt,
    method: input.method,
    role: "oauth_client",
    status: "domain_control_verified",
    subject: input.clientId,
    valid_from: input.lookedUpAt,
    valid_until: null,
  };
}

/** Serialize for the `grants.trust_signal_json` column. Absent signal stays absent. */
export function serializeTrustSignal(
  signal: TrustSignal | null | undefined,
): string | null {
  return signal ? JSON.stringify(signal) : null;
}

const REQUIRED_TRUST_SIGNAL_FIELDS = [
  "framework_uri",
  "issuer",
  "looked_up_at",
  "method",
  "role",
  "status",
  "subject",
  "valid_from",
] as const;

function isTrustSignalShape(value: Record<string, unknown>): boolean {
  return (
    REQUIRED_TRUST_SIGNAL_FIELDS.every(
      (field) => typeof value[field] === "string",
    ) &&
    (value.valid_until === null || typeof value.valid_until === "string")
  );
}

/**
 * Read a persisted reliance record back.
 *
 * Accepts a JSON string (SQLite `TEXT`) or an already-parsed object (PostgreSQL
 * `JSONB`, which the driver hands back decoded). A row that holds no signal, or holds
 * something that is not one, reads as absent: a malformed reliance record must never
 * take down introspection for a grant that is otherwise sound, and must never be
 * reported as though the server had relied on it.
 */
export function parseTrustSignal(value: unknown): TrustSignal | null {
  if (value === null || value === undefined) {
    return null;
  }
  let candidate: unknown = value;
  if (typeof value === "string") {
    if (value.length === 0) {
      return null;
    }
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  return isTrustSignalShape(record) ? (record as unknown as TrustSignal) : null;
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.polyfill.connector.register` operation.
 *
 * Owns the polyfill-only connector-registration semantics for `POST
 * /connectors`: manifest presence + connector identity validation, the
 * call into `registerConnector`, and the success-envelope shape.
 *
 * The host adapter owns Express plumbing, native-mode toggle (route is
 * only mounted when polyfill mode is active), and response writing.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsPolyfillConnectorRegisterInput {
  readonly manifest: Record<string, unknown> | null | undefined;
}

export interface AsPolyfillConnectorRegisterDependencies {
  /** Returns the accepted manifest stored under a connector key, or null. */
  getConnectorManifest: (
    connectorKey: string
  ) => Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined;
  /** Produces the exact representation `registerConnector` persists, and its storage key. */
  normalizeManifestForStorage: (manifest: Record<string, unknown>) => {
    connectorId: string;
    storedManifest: Record<string, unknown>;
  };
  registerConnector: (manifest: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Throws when the manifest is invalid; an invalid manifest is never equivocation. */
  validateManifest: (manifest: Record<string, unknown>) => void;
}

export interface AsPolyfillConnectorRegisterSuccessOutcome {
  readonly envelope: { readonly connector_id: string; readonly connector_key: string };
  readonly outcome: "success";
  readonly status: 201;
}

export interface AsPolyfillConnectorRegisterFailureOutcome {
  readonly errorCode: "invalid_request" | "declaration_equivocation";
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly status: 400 | 409;
}

export type AsPolyfillConnectorRegisterOutcome =
  | AsPolyfillConnectorRegisterSuccessOutcome
  | AsPolyfillConnectorRegisterFailureOutcome;

// Key-order-insensitive serialization: "different parsed content" is a
// structural difference, never a byte difference. Array order is content.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]])
      );
    }
    return v;
  });
}

async function acceptedManifestFor(
  deps: AsPolyfillConnectorRegisterDependencies,
  connectorId: string
): Promise<Record<string, unknown> | null> {
  try {
    return (await deps.getConnectorManifest(connectorId)) ?? null;
  } catch {
    // A stored manifest that no longer parses holds no accepted content to
    // retain, so it must stay replaceable by a valid registration.
    return null;
  }
}

export async function executeAsPolyfillConnectorRegister(
  input: AsPolyfillConnectorRegisterInput,
  deps: AsPolyfillConnectorRegisterDependencies
): Promise<AsPolyfillConnectorRegisterOutcome> {
  const { manifest } = input;
  const connectorKey =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? ((manifest as Record<string, unknown>).connector_key ?? (manifest as Record<string, unknown>).connector_id)
      : undefined;
  if (typeof connectorKey !== "string" || !connectorKey) {
    return {
      errorCode: "invalid_request",
      errorMessage: "Missing connector_key or connector_id",
      outcome: "failure",
      status: 400,
    };
  }
  // PDPP Core §5: an accepted declaration is keyed by source identity and
  // `declaration_version`; different parsed content under that key is
  // equivocation and the previously accepted content is retained. Same
  // content is an idempotent re-registration; a new version is a new key.
  deps.validateManifest(manifest as Record<string, unknown>);
  const { connectorId, storedManifest } = deps.normalizeManifestForStorage(manifest as Record<string, unknown>);
  const accepted = await acceptedManifestFor(deps, connectorId);
  if (
    accepted &&
    accepted.version === storedManifest.version &&
    canonicalJson(accepted) !== canonicalJson(storedManifest)
  ) {
    return {
      errorCode: "declaration_equivocation",
      errorMessage: `Connector ${connectorId} version ${String(accepted.version)} is already registered with different content; register a new version instead`,
      outcome: "failure",
      status: 409,
    };
  }
  const registered = await deps.registerConnector(manifest as Record<string, unknown>);
  const registeredKey = typeof registered === "string" && registered ? registered : connectorKey;
  return {
    envelope: { connector_id: registeredKey, connector_key: registeredKey },
    outcome: "success",
    status: 201,
  };
}

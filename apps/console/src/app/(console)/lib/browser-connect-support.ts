// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-session setup support, derived from the connector's own runtime
 * bindings.
 *
 * A connector supports "Connect account" in the browser-session flow when an
 * installed package (or a local manifest) declares a `browser` binding. The
 * decision is the shared `browserEnrollmentSupport` rule that the RI's
 * enrollment-shell route applies to the registered manifest, so the console
 * and the RI give the same answer. Known scaffolds stay excluded: they can
 * never collect. Without the conformance roster that rule adds no account.
 *
 * The console must not gate this on a connector-key list. A key list cannot
 * know about a connector that the owner installed from the runtime catalog,
 * and the production-ready roster that the shared list reads is an optional
 * module that a packaged console cannot always load.
 */

import {
  type BrowserEnrollmentSupport,
  browserEnrollmentSupport,
  canonicalConnectorKey,
} from "pdpp-reference-implementation/connection-setup-plan";

export interface BindingSource {
  readonly connector_id: string;
  readonly connector_key?: string | null;
  readonly bindings: Readonly<Record<string, unknown>> | null | undefined;
}

export type BrowserConnectSupport = BrowserEnrollmentSupport;

function sourceKey(source: BindingSource): string {
  return canonicalConnectorKey(source.connector_key ?? source.connector_id);
}

export function browserConnectSupport(
  connectorId: string | null | undefined,
  sources: readonly BindingSource[]
): BrowserConnectSupport {
  if (typeof connectorId !== "string" || connectorId.trim() === "") {
    return { browserBound: false, canAddAccount: false };
  }
  const key = canonicalConnectorKey(connectorId);
  const supports = sources
    .filter((source) => sourceKey(source) === key)
    .map((source) =>
      browserEnrollmentSupport(key, {
        connector_id: source.connector_id,
        runtime_requirements: { bindings: source.bindings ?? null },
      })
    );
  return {
    browserBound: supports.some((support) => support.browserBound),
    canAddAccount: supports.some((support) => support.canAddAccount),
  };
}

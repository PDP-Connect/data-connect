// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Console-side projection of the shared "how do I add a connection of type X?"
 * setup planner.
 *
 * This is the cookie-session-UI sibling of the backend owner-agent intent route.
 * Both surfaces consume `pdpp-reference-implementation/connection-setup-plan`;
 * the console MUST NOT call the owner-bearer route because a browser owner
 * session has no owner bearer. The important invariant is parity: the console
 * tells the owner the same honest story the trusted-agent surface tells, without
 * implying "Add connection" / "Sync now" for a flow the reference cannot
 * complete.
 *
 * The proven console creation primitive is device-exporter enrollment via the
 * cookie-authed `POST /_ref/device-exporters/enrollment-codes` route (surfaced at
 * `/device-exporters`). Static-secret API sources use the owner-session
 * draft path and connector-owned setup metadata, not console-side connector
 * labels or credential fields. The console renders connector display names from
 * manifests and setup plans; this module must not carry provider-specific UI
 * labels, example lists, or credential-field copy.
 *
 * The add-connection picker reads shipped manifests for the full catalog. If the
 * reference gains a new supported setup path, update the shared planner first;
 * console, owner-agent REST, CLI, and SDK-style projections should all consume
 * that same plan.
 */

import { canonicalConnectorKey as sharedCanonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";

/**
 * Connector creation modalities the console understands, matching the backend
 * intent route's taxonomy. `local_collector` is the only one-click path the
 * console can complete today; whether a given connector can use it is a fact
 * of its manifest, read through the server's owner connector templates.
 */
export type ConnectionAddModality = "local_collector" | "browser_bound" | "api_network";

/**
 * Public canonical bare key for a manifest's (possibly registry-URL-shaped)
 * `connector_id`. The connector catalog keys, displays, and routes on this value;
 * exporting the existing private helper keeps one canonicalization rule for the
 * console rather than letting the catalog re-implement the registry-prefix strip.
 */
export function canonicalConnectorKey(connectorId: string): string {
  return sharedCanonicalConnectorKey(connectorId);
}

/**
 * Connection source-binding kinds whose PRIMARY auth is an owner-authenticated
 * browser session, not a stored credential. A connection bound this way repairs
 * by browser/session repair (re-establish the session) — NOT static-secret
 * credential capture — even when the connector also supports a username_password
 * static secret at the connector level (e.g. a ChatGPT connection that logs in
 * via SSO through the browser). Mirrors the server-side
 * `BROWSER_SESSION_BINDING_KINDS` in `ref-control.ts`; the two must stay in sync.
 */
const BROWSER_SESSION_BINDING_KINDS = new Set(["browser_collector", "browser_enrollment_shell"]);

/**
 * True when THIS connection is bound as a browser session (from its
 * connection-scoped `source_binding_kind`), so repair must route to
 * browser/session repair rather than static-secret credential capture. This is
 * the connection-binding-first discriminator; it takes precedence over the
 * connector-level browser-binding and static-secret-capability facts.
 */
export function isBrowserSessionBoundConnection(sourceBindingKind: string | null | undefined): boolean {
  return typeof sourceBindingKind === "string" && BROWSER_SESSION_BINDING_KINDS.has(sourceBindingKind);
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-auth posture — the single source of truth for when owner routes may
 * fall through without a session.
 *
 * This module is pure: it derives a posture from explicit inputs (env snapshot
 * + start options) and never reads `process.env`, never touches the network,
 * and never imports server-internal route/auth/transport modules. That keeps it
 * exhaustively unit-testable and lets `server/index.js` own the env read.
 *
 * Why this exists (security audit S-1, lane A1):
 *   `requireOwnerSession` historically did `if (!enabled) next()` — when
 *   `PDPP_OWNER_PASSWORD` was unset, EVERY protected `/_ref` owner route was
 *   open. On a hosted deploy that binds a public interface, that is a full
 *   bypass of the owner control plane (connection delete/revoke, deployment
 *   diagnostics env dump, scheduler controls, manual run trigger). Local dev,
 *   by contrast, legitimately wants password-optional convenience.
 *
 * Shipped runtime modes set PDPP_OWNER_AUTH_REQUIRED explicitly: server images
 * use a setup-token claim when no password exists, and the desktop shell passes
 * its own generated credential. Network reachability remains a separate
 * fail-safe: an exposed listener also requires auth if a runtime forgot the
 * explicit setting.
 *
 *   - auth-required mode or exposed + no password → boot locked; setup must complete
 *   - auth-required mode or exposed + password     → normal owner-gated operation
 *   - local development on loopback               → password optional
 *
 * The contract has no unauthenticated-owner escape hatch: a non-loopback bind
 * or declared non-loopback origin always requires owner auth.
 */

import {
  isLoopbackBindHost,
  isLoopbackOriginHost,
} from "./reachability-contract.ts";

export interface OwnerExposureEnv {
  readonly PDPP_LOCK_CONNECTOR_REGISTRY?: string | undefined;
  readonly PDPP_OWNER_AUTH_REQUIRED?: string | undefined;
}

export interface OwnerExposureInputs {
  /** Interface the AS/RS listeners bind to (`opts.bindHost`). */
  readonly bindHost?: string | null | undefined;
  /** Process env snapshot. The caller passes only the relevant values. */
  readonly env?: OwnerExposureEnv | undefined;
  /** Whether an owner password is configured through any supported source. */
  readonly hasOwnerPassword: boolean;
  /** The normalized declared public origin, if configured. */
  readonly referenceOrigin?: string | null | undefined;
}

export interface OwnerExposurePosture {
  /**
   * True when `requireOwnerSession` should fall through to open local-dev
   * behavior while owner auth is disabled. False = fail closed (401/redirect).
   */
  readonly allowUnauthenticatedOwnerWhenDisabled: boolean;
  /** The bind host is a non-loopback interface. */
  readonly bindsNonLoopback: boolean;
  /** True when the bind or declared origin is externally reachable. */
  readonly hosted: boolean;
  /** Human-readable signals that drove the hosted classification. */
  readonly hostedSignals: readonly string[];
  /** True when owner auth must be configured before owner routes open. */
  readonly ownerAuthRequired: boolean;
  /**
   * True when `POST /connectors` (manifest upsert) MUST require an owner
   * session. A manifest upsert can bump `version` and invalidate every grant,
   * so server-mode and externally reachable deployments lock it by default.
   */
  readonly lockConnectorRegistry: boolean;
  /** Kept for compatibility; hosted installs now boot locked instead. */
  readonly refuseBootReason: string | null;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
function isTruthyFlag(value: string | undefined): boolean {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/** True when a valid declared origin names a non-loopback host. */
function isNonLoopbackOrigin(origin: string | null | undefined): boolean {
  if (typeof origin !== "string" || !origin.trim()) {
    return false;
  }
  try {
    return !isLoopbackOriginHost(new URL(origin.trim()).hostname);
  } catch {
    return false;
  }
}

/**
 * Derive owner-auth policy from runtime mode and the normalized reachability
 * contract. Reachability still controls the separate `hosted` classification.
 */
export function resolveOwnerExposurePosture(inputs: OwnerExposureInputs): OwnerExposurePosture {
  const env = inputs.env ?? {};
  const bindsNonLoopback = !isLoopbackBindHost(inputs.bindHost);
  const originIsNonLoopback = isNonLoopbackOrigin(inputs.referenceOrigin);
  const hostedSignals: string[] = [];
  const lockRegistryOverride = isTruthyFlag(env.PDPP_LOCK_CONNECTOR_REGISTRY);
  const ownerAuthRequiredOverride = isTruthyFlag(env.PDPP_OWNER_AUTH_REQUIRED);

  if (bindsNonLoopback) {
    hostedSignals.push(`bindHost=${inputs.bindHost ?? "(unset)"}`);
  }
  if (originIsNonLoopback) {
    hostedSignals.push("PDPP_REFERENCE_ORIGIN=<non-loopback>");
  }
  const hosted = bindsNonLoopback || originIsNonLoopback;
  const ownerAuthRequired = hosted || ownerAuthRequiredOverride;
  const refuseBootReason = null;

  return {
    allowUnauthenticatedOwnerWhenDisabled: !ownerAuthRequired,
    bindsNonLoopback,
    hosted,
    hostedSignals,
    lockConnectorRegistry: ownerAuthRequired || lockRegistryOverride,
    ownerAuthRequired,
    refuseBootReason,
  };
}

export { isLoopbackBindHost };

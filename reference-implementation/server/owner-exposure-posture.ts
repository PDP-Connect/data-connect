// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-exposure posture — the single source of truth for "is this reference
 * deployment internet-facing, and therefore must owner auth be mandatory?"
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
 * The fix distinguishes the two by the normalized reachability contract,
 * then fails closed in the hosted posture:
 *   - hosted + no password  → refuse to boot (the caller throws)
 *   - hosted + password      → normal owner-gated operation
 *   - local-dev (loopback)   → password optional; open behavior preserved
 *
 * The contract has no unauthenticated-owner escape hatch: a non-loopback bind
 * or declared non-loopback origin always requires a password at startup.
 */

import {
  isLoopbackBindHost,
  isLoopbackOriginHost,
} from "./reachability-contract.ts";

export interface OwnerExposureEnv {
  readonly PDPP_LOCK_CONNECTOR_REGISTRY?: string | undefined;
}

export interface OwnerExposureInputs {
  /** Interface the AS/RS listeners bind to (`opts.bindHost`). */
  readonly bindHost?: string | null | undefined;
  /** Process env snapshot. The caller passes only the relevant values. */
  readonly env?: OwnerExposureEnv | undefined;
  /** Whether owner auth is enabled (i.e. a non-empty password is configured). */
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
  /** True when the bind or declared origin creates a hosted posture. */
  readonly hosted: boolean;
  /** Human-readable signals that drove the hosted classification (for logs). */
  readonly hostedSignals: readonly string[];
  /**
   * True when `POST /connectors` (manifest upsert) MUST require an owner
   * session. A manifest upsert can bump `version` and invalidate every grant,
   * so we lock it whenever hosted OR when explicitly requested.
   */
  readonly lockConnectorRegistry: boolean;
  /**
   * Set when the caller should refuse to boot. Null when boot may proceed.
   */
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
 * Derive the owner-exposure posture from the normalized reachability contract.
 */
export function resolveOwnerExposurePosture(inputs: OwnerExposureInputs): OwnerExposurePosture {
  const env = inputs.env ?? {};
  const bindsNonLoopback = !isLoopbackBindHost(inputs.bindHost);
  const originIsNonLoopback = isNonLoopbackOrigin(inputs.referenceOrigin);
  const hostedSignals: string[] = [];
  const lockRegistryOverride = isTruthyFlag(env.PDPP_LOCK_CONNECTOR_REGISTRY);

  if (bindsNonLoopback) {
    hostedSignals.push(`bindHost=${inputs.bindHost ?? "(unset)"}`);
  }
  if (originIsNonLoopback) {
    hostedSignals.push("PDPP_REFERENCE_ORIGIN=<non-loopback>");
  }
  const hosted = bindsNonLoopback || originIsNonLoopback;
  const refuseBoot = hosted && !inputs.hasOwnerPassword;
  const refuseBootReason = refuseBoot
    ? `Refusing to start: this hosted reference deployment is reachable beyond loopback (${hostedSignals.join(", ")}) but PDPP_OWNER_PASSWORD is unset or empty. Set PDPP_OWNER_PASSWORD before using a non-loopback PDPP_BIND_HOST or non-loopback PDPP_REFERENCE_ORIGIN.`
    : null;

  return {
    allowUnauthenticatedOwnerWhenDisabled: !hosted,
    bindsNonLoopback,
    hosted,
    hostedSignals,
    lockConnectorRegistry: hosted || lockRegistryOverride,
    refuseBootReason,
  };
}

export { isLoopbackBindHost };

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { notFreshCopy } from "./add-source-list-model.ts";

/**
 * "Getting <Name> ready" (design "Page 2"): the person never sees an install
 * step. The page calls the install action itself, then waits until the server
 * reports the service ready to connect.
 */

export type GettingReadyOutcome =
  | { readonly href: string; readonly kind: "ready" }
  | { readonly detail: string; readonly kind: "failed" };

export type ReadinessCheck = { readonly href: string; readonly state: "ready" } | { readonly state: "waiting" } | { readonly state: "retry" };

export interface GettingReadyDeps {
  /** Reads the server again. Resolves "ready" once the service can be connected. */
  readonly check: () => Promise<ReadinessCheck>;
  /** True when the package is not on this computer yet. */
  readonly needsInstall: boolean;
  /** Gets the package. `ok: false` carries the server's message. */
  readonly install: () => Promise<{ ok: true } | { message: string; ok: false }>;
  readonly intervalMs?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const GETTING_READY_INTERVAL_MS = 1500;
/** Past the server's own five minute install limit would hide a real failure; two minutes after install is enough to register. */
export const GETTING_READY_MAX_WAIT_MS = 120_000;

export async function getServiceReady(deps: GettingReadyDeps): Promise<GettingReadyOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = deps.intervalMs ?? GETTING_READY_INTERVAL_MS;
  const maxWaitMs = deps.maxWaitMs ?? GETTING_READY_MAX_WAIT_MS;
  try {
    if (deps.needsInstall) {
      const installed = await deps.install();
      if (!installed.ok) return { detail: installed.message, kind: "failed" };
    }
    const startedAt = now();
    for (;;) {
      const result = await deps.check();
      if (result.state === "retry") return { detail: notFreshCopy(null), kind: "failed" };
      if (result.state === "ready") return { href: result.href, kind: "ready" };
      if (now() - startedAt >= maxWaitMs) {
        return { detail: "The server did not report this service ready within two minutes.", kind: "failed" };
      }
      await sleep(intervalMs);
    }
  } catch (error) {
    return { detail: error instanceof Error ? error.message : "Unexpected failure while getting ready.", kind: "failed" };
  }
}

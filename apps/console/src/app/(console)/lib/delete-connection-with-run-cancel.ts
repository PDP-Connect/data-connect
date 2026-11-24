// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CancelRunResult } from "./cancel-run-result.ts";
import type { DeleteConnectionResult } from "./connection-control-result.ts";

/**
 * "Cancel run, then delete" for the connection danger zone. The reference
 * delete refuses with `409 connection_run_active` while a run holds the
 * connection's active-run lease. When the owner has confirmed the delete AND
 * asked to cancel the blocking run, this cancels exactly that run and retries
 * the delete until the lease clears or the attempts run out.
 *
 * Pure orchestration with injected I/O so it is unit tested without the
 * server-only fetch helpers. Cancelling never erases anything; only the
 * delete that follows does.
 */
export async function deleteConnectionWithRunCancel(
  connectionId: string,
  cancelRunId: string | null,
  deps: {
    cancelRun: (runId: string) => Promise<CancelRunResult>;
    deleteConnection: (connectionId: string) => Promise<DeleteConnectionResult>;
    sleep?: (ms: number) => Promise<void>;
  },
  { attempts = 10, intervalMs = 500 }: { attempts?: number; intervalMs?: number } = {}
): Promise<DeleteConnectionResult & { cancelledRunId?: string }> {
  const first = await deps.deleteConnection(connectionId);
  if (first.status !== "run_active" || !cancelRunId) {
    return first;
  }
  // Cancel only the run the owner saw; a different run that started since is
  // surfaced again instead of being cancelled without the owner's consent.
  if (first.activeRunId && first.activeRunId !== cancelRunId) {
    return first;
  }
  await deps.cancelRun(cancelRunId);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = first;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    result = await deps.deleteConnection(connectionId);
    if (result.status !== "run_active" || result.activeRunId !== cancelRunId) {
      break;
    }
  }
  return { ...result, cancelledRunId: cancelRunId };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BindingResourceReference, BindingResourceCleanupReceipt } from "../runtime/binding-resource-reference.ts";
import { bindingResourceCleanupReceipt } from "../runtime/binding-resource-reference.ts";
import type { ConnectorBindingResourceStore } from "./stores/connector-binding-resource-store.ts";

/** Run before acquisition. No grant/resume, profile access, source data, or implicit retry.
 * Outcomes contain bounded codes and opaque intent IDs, never transport diagnostics.
 */
export async function reconcileProtectedBrowserResources(input: {
  allocator: {
    recoverStoppedResource(
      reference: BindingResourceReference,
      deadline: number
    ): Promise<BindingResourceCleanupReceipt>;
    releaseRecoveredResource?(reference: BindingResourceReference, deadline: number): Promise<void>;
  };
  store: ConnectorBindingResourceStore;
  deadline: number;
}): Promise<readonly { intentId: string; status: "removed" | "binding_cleanup_unverified" }[]> {
  const outcomes: { intentId: string; status: "removed" | "binding_cleanup_unverified" }[] = [];
  for (const intent of await input.store.listUnresolved()) {
    try {
      if (!Number.isFinite(input.deadline) || Date.now() >= input.deadline) throw new Error("Recovery deadline");
      const receipt = bindingResourceCleanupReceipt(
        await input.allocator.recoverStoppedResource(intent.reference, input.deadline),
        intent.reference
      );
      if (Date.now() >= input.deadline) throw new Error("Recovery deadline");
      await input.store.retire(intent.intentId, receipt);
      await input.allocator.releaseRecoveredResource?.(intent.reference, input.deadline);
      outcomes.push({ intentId: intent.intentId, status: "removed" });
    } catch {
      outcomes.push({ intentId: intent.intentId, status: "binding_cleanup_unverified" });
    }
  }
  return Object.freeze(outcomes.map((item) => Object.freeze(item)));
}

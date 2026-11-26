// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { assertCurrentStorageGeneration } from "./storage-generation.ts";
import { listStartupSearchIndexInstances, markStartupSearchIndexFailure } from "./stores/search-index-dirty-store.ts";

type Manifest = {
  connector_id: string;
  connector_instance_id?: string | null;
  storage_binding?: { connector_instance_id?: string | null } | null;
  streams?: unknown;
};

/** True when any stream declares semantic fields, so a semantic pass is owed. */
export function manifestDeclaresSemanticFields(manifest: { streams?: unknown }): boolean {
  if (!Array.isArray(manifest.streams)) {
    return false;
  }
  return manifest.streams.some((stream) => {
    const fields = (stream as { query?: { search?: { semantic_fields?: unknown } } } | null)?.query?.search
      ?.semantic_fields;
    return Array.isArray(fields) && fields.length > 0;
  });
}

/** Startup-only caller effect: reconcile failures own their revision/backoff. */
export async function queueStartupSearchIndexRetry(manifest: Manifest, generation: number): Promise<void> {
  assertCurrentStorageGeneration(generation);
  const connectorId = manifest.connector_id;
  const pin = manifest.storage_binding?.connector_instance_id || manifest.connector_instance_id;
  const instances = pin ? [pin] : await listStartupSearchIndexInstances(connectorId);
  assertCurrentStorageGeneration(generation);
  // One instance's failed mark must not leave its siblings without a durable
  // retry, so every instance is attempted before the failures are reported.
  const failures: unknown[] = [];
  for (const connectorInstanceId of new Set(instances)) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Never hold more than one instance deletion fence.
      await markStartupSearchIndexFailure({
        connectorId,
        connectorInstanceId,
        generation,
      });
    } catch (error) {
      failures.push(
        new Error(`startup search-index retry could not be queued for instance ${connectorInstanceId}`, {
          cause: error,
        })
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `startup search-index retry could not be queued for ${connectorId}`);
  }
}

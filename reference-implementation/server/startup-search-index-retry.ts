// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { resolveLexicalBackfillConnectorInstanceIds } from "./search.ts";
import { resolveSemanticBackfillConnectorInstanceIds } from "./search-semantic.ts";
import { assertCurrentStorageGeneration } from "./storage-generation.ts";
import { listStartupSearchIndexInstances, markStartupSearchIndexFailure } from "./stores/search-index-dirty-store.ts";

type Manifest = Parameters<typeof resolveLexicalBackfillConnectorInstanceIds>[0]["manifest"] &
  Parameters<typeof resolveSemanticBackfillConnectorInstanceIds>[0]["manifest"];

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
  const lexical = await resolveLexicalBackfillConnectorInstanceIds({
    connectorId,
    manifest,
  });
  assertCurrentStorageGeneration(generation);
  const semantic = await resolveSemanticBackfillConnectorInstanceIds({
    connectorId,
    manifest,
  });
  assertCurrentStorageGeneration(generation);
  const pin = manifest.storage_binding?.connector_instance_id || manifest.connector_instance_id;
  const orphanInstances = pin ? [] : await listStartupSearchIndexInstances(connectorId);
  assertCurrentStorageGeneration(generation);
  // One instance's failed mark must not leave its siblings without a durable
  // retry, so every instance is attempted before the failures are reported.
  const failures: unknown[] = [];
  for (const connectorInstanceId of new Set([...lexical, ...semantic, ...orphanInstances])) {
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

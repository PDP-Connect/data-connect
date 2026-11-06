// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { resolveLexicalBackfillConnectorInstanceIds } from "./search.ts";
import { resolveSemanticBackfillConnectorInstanceIds } from "./search-semantic.ts";
import { assertCurrentStorageGeneration } from "./storage-generation.ts";
import { listStartupSearchIndexInstances, markStartupSearchIndexFailure } from "./stores/search-index-dirty-store.ts";

type Manifest = Parameters<typeof resolveLexicalBackfillConnectorInstanceIds>[0]["manifest"] &
  Parameters<typeof resolveSemanticBackfillConnectorInstanceIds>[0]["manifest"];

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
  for (const connectorInstanceId of new Set([...lexical, ...semantic, ...orphanInstances])) {
    // biome-ignore lint/performance/noAwaitInLoops: Never hold more than one instance deletion fence.
    await markStartupSearchIndexFailure({
      connectorId,
      connectorInstanceId,
      generation,
    });
  }
}

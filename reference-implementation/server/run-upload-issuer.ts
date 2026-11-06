// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { RunUploadLifetime, type RunUploadLifetimeFactory } from "../runtime/run-upload-lifetime.ts";
import { createRunUploadPermissionStore } from "./stores/run-upload-permission-store.ts";

let currentIssuer: symbol | undefined;

/** Called after active storage initialization and before listeners or admissions. */
export async function initializeRunUploadIssuer(maxBytes: number): Promise<RunUploadLifetimeFactory> {
  const incarnation = Symbol("run upload issuer");
  currentIssuer = incarnation;
  const store = createRunUploadPermissionStore();
  const epochs = new Map<string, Promise<{ issuerEpoch: string; nextGeneration: number }>>();
  for (const connectionId of await store.retainedConnectionIds()) {
    epochs.set(connectionId, store.beginIssuerEpoch(connectionId));
  }
  await Promise.all(epochs.values());
  return (scope) => {
    const admitted = { ...scope };
    return new RunUploadLifetime(
      async (facts) => {
        if (currentIssuer !== incarnation) {
          throw new Error("Run upload issuer retired");
        }
        if (
          facts.connectionId !== admitted.connectionId ||
          facts.connectorId !== admitted.connectorId ||
          facts.ownerId !== admitted.ownerId ||
          facts.runId !== admitted.runId
        ) {
          throw new Error("Run upload admission identity mismatch");
        }
        // Store the promise before awaiting, so concurrent first issues cannot rotate
        // each other's epoch. Generation reservation happens synchronously after it.
        let epoch = epochs.get(admitted.connectionId);
        if (!epoch) {
          epoch = store.beginIssuerEpoch(admitted.connectionId);
          epochs.set(admitted.connectionId, epoch);
        }
        const current = await epoch;
        if (currentIssuer !== incarnation) {
          throw new Error("Run upload issuer retired");
        }
        const generation = current.nextGeneration;
        current.nextGeneration += 1;
        return store.issue({
          ...admitted,
          associations: facts.selection.streams.map((stream) => ({
            allJsonPointers: stream.fields === null,
            paths: ["@record", ...new Set([...(stream.fields ?? []), ...stream.requiredFields])].map((field) =>
              field === "@record" ? field : `/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`
            ),
            recordKeys: "any",
            stream: stream.name,
          })),
          generation,
          issuerEpoch: current.issuerEpoch,
          manifestSnapshot: facts.manifestSnapshot,
          purpose: "blob-upload",
          selectionIdentity: createHash("sha256").update(JSON.stringify(facts.selection)).digest("hex"),
          sourceSnapshot: facts.sourceSnapshot,
          staging: { maxBytes, selection: facts.selection },
        });
      },
      (grant) => store.revoke(grant)
    );
  };
}

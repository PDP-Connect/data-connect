// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Run-scoped blob upload credentials.
//
// A connector child needs exactly one authenticated call: `POST /v1/blobs`.
// Instead of handing it the owner bearer, the controller mints one random
// credential per admitted run. Only its SHA-256 hash is stored here, bound to
// the run's connector id, connector instance id and owner subject. The
// credential stops working when the controller revokes it at run end.
//
// The registry lives in the server process, next to the controller, so the
// blob route can check run liveness without a network hop. It is deliberately
// separate from the owner-token introspection path: no other route consults
// it, so a run credential presented anywhere else is just an unknown bearer.

import { createHash, timingSafeEqual } from "node:crypto";

export interface RunBlobUploadBinding {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly runId: string;
}

/** Hooks the controller calls to mint and revoke the credential for a run. */
export interface RunBlobUploadCredentialHooks {
  register: (args: RunBlobUploadBinding & { token: string }) => void;
  revoke: (args: { runId: string }) => void;
}

export interface RunBlobUploadCredentialRegistry extends RunBlobUploadCredentialHooks {
  /** Returns the binding for a live credential, or null for unknown or revoked ones. */
  verify: (presentedToken: string) => RunBlobUploadBinding | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRunBlobUploadCredentialRegistry(): RunBlobUploadCredentialRegistry {
  const byRunId = new Map<string, { binding: RunBlobUploadBinding; hash: string }>();
  return {
    register({ token, ...binding }) {
      if (!(token && binding.runId && binding.connectorId && binding.connectorInstanceId)) {
        throw new Error("run blob upload credential requires token, runId, connectorId and connectorInstanceId");
      }
      byRunId.set(binding.runId, { binding, hash: hashToken(token) });
    },
    revoke({ runId }) {
      byRunId.delete(runId);
    },
    verify(presentedToken) {
      if (!presentedToken) {
        return null;
      }
      const presentedHash = hashToken(presentedToken);
      for (const entry of byRunId.values()) {
        if (hexEqual(entry.hash, presentedHash)) {
          return entry.binding;
        }
      }
      return null;
    },
  };
}

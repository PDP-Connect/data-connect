// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { Observation, SecretBackend } from "@tnunamak/gozar";

import { ReachabilityError } from "./approvals.ts";

// The supervisor supplies this private bridge. There is deliberately no file
// fallback and no serialization of handles or credentials to browser state.
export function createHostSecretBackend(bridge: SecretBackend | null): SecretBackend {
  function available(): SecretBackend {
    if (!bridge) {
      throw new ReachabilityError("secret_backend_unavailable");
    }
    return bridge;
  }
  return {
    delete: (input: Parameters<SecretBackend["delete"]>[0]) => available().delete(input),
    presence: async (input: Parameters<SecretBackend["presence"]>[0]) => {
      if (!bridge) {
        return { known: false, reason: "secret_backend_unavailable" } as Observation<boolean>;
      }
      try {
        return await bridge.presence(input);
      } catch (error) {
        return {
          known: false,
          reason:
            (error as { code?: string })?.code === "secret_backend_locked"
              ? "secret_backend_locked"
              : "secret_backend_unavailable",
        } as Observation<boolean>;
      }
    },
    put: (input: Parameters<SecretBackend["put"]>[0]) => available().put(input),
    withSecret: <T>(input: Parameters<SecretBackend["withSecret"]>[0], use: (bytes: Uint8Array) => Promise<T>) =>
      available().withSecret(input, use),
  };
}

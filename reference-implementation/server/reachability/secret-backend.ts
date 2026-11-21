// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createCredentialCipherFromEnv } from "../stores/credential-encryption.ts";
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

// The desktop provisions the existing credential encryption key. Store only
// sealed bytes in a per-install directory, with the scope authenticated inside
// the ciphertext. The SDK keeps the binding and lifecycle separately.
export function createSealedSecretBackend(directory: string): SecretBackend {
  function file(scopeId: string, handle: string) {
    return join(directory, createHash("sha256").update(JSON.stringify([scopeId, handle])).digest("hex"));
  }
  async function read(scopeId: string, handle: string): Promise<Buffer | null> {
    try {
      const sealed = await readFile(file(scopeId, handle), "utf8");
      const record = JSON.parse(createCredentialCipherFromEnv().open(sealed)) as { scopeId: string; handle: string; bytes: string };
      if (record.scopeId !== scopeId || record.handle !== handle || typeof record.bytes !== "string") {
        throw new ReachabilityError("secret_backend_locked");
      }
      return Buffer.from(record.bytes, "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ReachabilityError("secret_backend_locked");
    }
  }
  return {
    async put({ scopeId, bytes }) {
      const handle = randomUUID();
      const encoded = Buffer.from(bytes);
      try {
        const sealed = createCredentialCipherFromEnv().seal(JSON.stringify({ scopeId, handle, bytes: encoded.toString("base64") }));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = file(scopeId, handle);
        const temp = `${path}.pending`;
        const fd = await open(temp, "wx", 0o600);
        try {
          try {
            await fd.writeFile(sealed);
            await fd.sync();
          } finally {
            await fd.close();
          }
          await rename(temp, path);
          const parent = await open(directory, "r");
          try { await parent.sync(); } finally { await parent.close(); }
        } finally {
          await rm(temp, { force: true });
        }
        return { handle };
      } catch {
        throw new ReachabilityError("secret_backend_unavailable");
      } finally {
        encoded.fill(0);
      }
    },
    async presence({ scopeId, handle }) {
      const bytes = await read(scopeId, handle);
      bytes?.fill(0);
      return { known: true, value: bytes !== null };
    },
    async withSecret({ scopeId, handle }, use) {
      const bytes = await read(scopeId, handle);
      if (!bytes) throw new ReachabilityError("secret_input_unavailable");
      try { return await use(bytes); } finally { bytes.fill(0); }
    },
    async delete({ scopeId, handle }) {
      const bytes = await read(scopeId, handle);
      if (bytes) {
        bytes.fill(0);
        await rm(file(scopeId, handle), { force: true });
      }
      return { deleted: bytes !== null };
    },
  };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Observation, SecretBackend } from "@tnunamak/gozar";
import type { CredentialCipher } from "../stores/credential-encryption.ts";

const HANDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Sealed = { scopeId: string; bytes: string };
// What opening a file under one key showed. No secret bytes are kept.
type Verdict = { scopeId: string } | "wrong_key";

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

// One sealed file per secret under `dir`. The scope lives inside the sealed
// payload, not in the file name: a file copied under another scope still opens
// but is refused, so a stolen or misplaced file cannot serve a different route.
// `cipherNow` resolves the key on every call and returns null while it is
// absent: that reads as locked and recovers when the key returns. A key that is
// present but does not open the file is a different fault: `secret_key_mismatch`
// does not clear until the key or the file changes. The host never falls back to
// plaintext.
//
// Trust boundary: `dir` sits in the app's owner-only data directory. Other
// users are kept out by its 0700 mode. A process running as the same user is
// out of scope: it can read the key and the files directly. File operations
// therefore use plain paths inside `dir`; they are not anchored to a directory
// handle and do not defend against entries swapped by such a process.
export function createSealedFileSecretBackend(dir: string, cipherNow: () => CredentialCipher | null): SecretBackend {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  // `mkdir` leaves an existing directory as it is. Take it back to owner-only,
  // and refuse one that another user owns: its entries are not ours to trust.
  const stat = statSync(dir);
  if (process.getuid && stat.uid !== process.getuid()) {
    throw coded("secret_dir_foreign_owner");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
  const pathOf = (handle: string) => {
    if (!HANDLE.test(handle)) {
      throw coded("secret_not_found");
    }
    return join(dir, `${handle}.sealed`);
  };
  const read = (handle: string): string => {
    try {
      return readFileSync(pathOf(handle), "utf8").trim();
    } catch (error) {
      throw (error as { code?: string }).code === "ENOENT" ? coded("secret_not_found") : error;
    }
  };
  const locked = (): CredentialCipher => {
    const cipher = cipherNow();
    if (!cipher) {
      throw coded("secret_backend_locked");
    }
    return cipher;
  };
  const open = (cipher: CredentialCipher, text: string): Sealed => {
    try {
      return JSON.parse(cipher.open(text)) as Sealed;
    } catch {
      throw coded("secret_key_mismatch");
    }
  };
  const unseal = (scopeId: string, handle: string): Sealed => {
    const cipher = locked();
    const sealed = open(cipher, read(handle));
    if (sealed.scopeId !== scopeId) {
      throw coded("secret_scope_mismatch");
    }
    return sealed;
  };
  // Opening costs a key derivation and presence is polled, so remember the
  // outcome per key value and per handle, with the digest of the content it was
  // learned from. A replaced file or a changed key is read again. One entry per
  // handle, dropped on delete, keeps this bounded by the files that exist.
  const verdicts = new WeakMap<CredentialCipher, Map<string, { digest: string; verdict: Verdict }>>();
  const verdictOf = (cipher: CredentialCipher, handle: string, text: string): Verdict => {
    const known = verdicts.get(cipher) ?? new Map<string, { digest: string; verdict: Verdict }>();
    verdicts.set(cipher, known);
    const digest = createHash("sha256").update(text).digest("hex");
    const cached = known.get(handle);
    if (cached?.digest === digest) {
      return cached.verdict;
    }
    let verdict: Verdict;
    try {
      verdict = { scopeId: open(cipher, text).scopeId };
    } catch {
      verdict = "wrong_key";
    }
    known.set(handle, { digest, verdict });
    return verdict;
  };
  return {
    async put(input) {
      const cipher = locked();
      const handle = randomUUID();
      const path = pathOf(handle);
      const temp = `${path}.${randomUUID()}.tmp`;
      const payload: Sealed = { bytes: Buffer.from(input.bytes).toString("base64"), scopeId: input.scopeId };
      writeFileSync(temp, cipher.seal(JSON.stringify(payload)), { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
      return { handle };
    },
    async withSecret(input, use) {
      const bytes = Buffer.from(unseal(input.scopeId, input.handle).bytes, "base64");
      try {
        return await use(bytes);
      } finally {
        bytes.fill(0);
      }
    },
    async presence(input): Promise<Observation<boolean>> {
      try {
        const verdict = verdictOf(locked(), input.handle, read(input.handle));
        if (verdict === "wrong_key") {
          return { known: false, reason: "secret_key_mismatch" };
        }
        return { known: true, value: verdict.scopeId === input.scopeId };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "secret_not_found") {
          return { known: true, value: false };
        }
        return { known: false, reason: code === "secret_backend_locked" ? code : "secret_backend_unavailable" };
      }
    },
    async delete(input) {
      try {
        unseal(input.scopeId, input.handle);
      } catch (error) {
        if ((error as { code?: string }).code === "secret_not_found") {
          return { deleted: false };
        }
        throw error;
      }
      unlinkSync(pathOf(input.handle));
      const cipher = cipherNow();
      if (cipher) {
        verdicts.get(cipher)?.delete(input.handle);
      }
      return { deleted: true };
    },
  };
}

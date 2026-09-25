// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { StringDecoder } from "node:string_decoder";
import { closeDb, initDb } from "../../server/db.ts";
import { createOwnerPasswordVerifier, OWNER_PASSWORD_MIN_LENGTH } from "../../server/owner-password-verifier.ts";
import { OWNER_SESSION_DEFAULT_SUBJECT_ID } from "../../server/owner-session.ts";
import { closePostgresStorage, initPostgresStorage, resolveStorageBackend } from "../../server/postgres-storage.ts";
import { createOwnerPasswordVerifierStore } from "../../server/stores/owner-password-verifier-store.ts";

let pendingSecretInput = "";

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error(
      "Run reset-owner-password in an interactive terminal so passwords are not passed in arguments or environment variables."
    );
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const decoder = new StringDecoder("utf8");
    let onData: (chunk: Buffer) => void = () => undefined;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    const restore = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    const takeLine = () => {
      const boundary = pendingSecretInput.search(/[\r\n]/u);
      if (boundary < 0) return null;
      const line = Array.from(pendingSecretInput.slice(0, boundary)).reduce((value, character) => {
        if (character === "\u007f" || character === "\b") return value.slice(0, -1);
        return value + character;
      }, "");
      const terminator = pendingSecretInput[boundary];
      pendingSecretInput = pendingSecretInput.slice(boundary + 1);
      if (terminator === "\r" && pendingSecretInput.startsWith("\n")) pendingSecretInput = pendingSecretInput.slice(1);
      return line;
    };
    const finishLine = (line: string) => {
      restore();
      resolve(line);
    };
    const bufferedLine = takeLine();
    if (bufferedLine !== null) {
      finishLine(bufferedLine);
      return;
    }
    onData = (chunk: Buffer) => {
      pendingSecretInput += decoder.write(chunk);
      if (pendingSecretInput.includes("\u0003")) {
        pendingSecretInput = "";
        restore();
        reject(new Error("Password reset cancelled."));
        return;
      }
      const line = takeLine();
      if (line !== null) finishLine(line);
    };
    stdin.on("data", onData);
  });
}

export async function resetOwnerPassword(): Promise<void> {
  if (typeof process.env.PDPP_OWNER_PASSWORD === "string" && process.env.PDPP_OWNER_PASSWORD.length > 0) {
    throw new Error(
      "PDPP_OWNER_PASSWORD is set and remains authoritative. Change it in the environment and restart the server; unset it before using this CLI."
    );
  }

  const backend = resolveStorageBackend();
  const sqlitePath = process.env.PDPP_DB_PATH || process.env.DB_PATH;
  if (backend.backend === "sqlite" && (!sqlitePath || sqlitePath === ":memory:")) {
    throw new Error("Set PDPP_DB_PATH (or DB_PATH) to the durable SQLite database used by the running server.");
  }

  const password = await readSecret("New owner password: ");
  const confirmation = await readSecret("Confirm new owner password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  if (Array.from(password).length < OWNER_PASSWORD_MIN_LENGTH) {
    throw new Error(`Owner passwords must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters long.`);
  }

  try {
    await initDb(backend.backend === "postgres" ? ":memory:" : (sqlitePath as string));
    await initPostgresStorage(backend.backend === "postgres" ? backend : null);
    const passwordStore = createOwnerPasswordVerifierStore();
    if (!passwordStore.isDurable()) throw new Error("The configured owner password store is not durable.");
    if (!(await passwordStore.read()))
      throw new Error("No app-managed owner password exists. Claim the install at /setup first.");
    const subjectId = process.env.PDPP_OWNER_SUBJECT_ID || OWNER_SESSION_DEFAULT_SUBJECT_ID;
    await passwordStore.writeAndRevokeAccess(await createOwnerPasswordVerifier(password), subjectId);
    process.stdout.write("Owner password reset. All browser sessions and owner tokens were signed out.\n");
  } finally {
    closeDb();
    await closePostgresStorage();
  }
}

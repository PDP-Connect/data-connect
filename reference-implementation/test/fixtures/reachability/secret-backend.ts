// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { Observation, SecretBackend } from "@tnunamak/gozar";

export class FixtureSecretBackend implements SecretBackend {
  locked = false;
  readonly trace: string[] = [];
  private readonly records = new Map<string, { scopeId: string; bytes: Uint8Array }>();
  private readonly issued = new Set<string>();
  private check(): void {
    if (this.locked) {
      throw Object.assign(new Error("backend locked"), { code: "secret_backend_locked" });
    }
  }
  async put(input: { scopeId: string; inputId: string; revision: string; bytes: Uint8Array }) {
    this.check();
    this.trace.push("put");
    const handle = randomUUID();
    this.issued.add(handle);
    this.records.set(handle, { bytes: input.bytes.slice(), scopeId: input.scopeId });
    return { handle };
  }
  async withSecret<T>(input: { scopeId: string; handle: string }, use: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    this.check();
    this.trace.push("use");
    const record = this.records.get(input.handle);
    if (!record || record.scopeId !== input.scopeId) {
      throw Object.assign(new Error("unknown secret"), { code: "secret_not_found" });
    }
    const bytes = record.bytes.slice();
    try {
      return await use(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  async presence(input: { scopeId: string; handle: string }): Promise<Observation<boolean>> {
    this.trace.push("presence");
    if (this.locked) {
      return { known: false, reason: "secret_backend_locked" };
    }
    return { known: true, value: this.records.get(input.handle)?.scopeId === input.scopeId };
  }
  async delete(input: { scopeId: string; handle: string }) {
    this.check();
    this.trace.push("delete");
    const record = this.records.get(input.handle);
    if (record && record.scopeId !== input.scopeId) {
      throw Object.assign(new Error("foreign secret"), { code: "secret_scope_mismatch" });
    }
    record?.bytes.fill(0);
    return { deleted: this.records.delete(input.handle) };
  }
  handles(): string[] {
    return [...this.records.keys()];
  }
  issuedHandles(): string[] {
    return [...this.issued];
  }
}

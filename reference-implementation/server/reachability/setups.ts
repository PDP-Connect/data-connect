// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

// One entry per service (provider). It holds the service's draft and its setup
// operation, so a console that reloads or restarts reads them from here instead
// of keeping its own copy. Only non-secret identifiers are stored.
export type ServiceSetup = {
  operationId: string;
  actionId: string;
  expectedConfigurationRevision: string;
};
export type ServiceEntry = {
  providerId: string;
  providerLabel: string;
  draftId: string | null;
  usage: string | null;
  committed: boolean;
  setup: ServiceSetup | null;
};

export class ReachabilitySetups {
  private readonly file: string;
  private readonly root: string;
  // Writes run one at a time, so check-then-write sequences stay atomic.
  private queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) {
    this.root = root;
    this.file = join(root, "services.json");
  }
  private async load(): Promise<ServiceEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? (value as ServiceEntry[]) : [];
  }
  private async save(entries: ServiceEntry[]): Promise<void> {
    await mkdir(this.root, { mode: 0o700, recursive: true });
    const temporary = `${this.file}.${randomUUID()}.pending`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(entries)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.file);
  }
  // Runs `change` against the current entries and saves what it returns.
  private mutate<T>(change: (entries: ServiceEntry[]) => { entries: ServiceEntry[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const { entries, result } = change(await this.load());
      await this.save(entries);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async list(): Promise<ServiceEntry[]> {
    await this.queue;
    return this.load();
  }
  async get(providerId: string): Promise<ServiceEntry | null> {
    return (await this.list()).find((entry) => entry.providerId === providerId) ?? null;
  }
  // Replaces the service's draft. A setup in progress stays: it lives on its own.
  recordDraft(input: { providerId: string; providerLabel: string; draftId: string; usage: string | null }) {
    return this.mutate((entries) => {
      const prior = entries.find((entry) => entry.providerId === input.providerId);
      const next: ServiceEntry = {
        providerId: input.providerId,
        providerLabel: input.providerLabel,
        draftId: input.draftId,
        usage: input.usage ?? prior?.usage ?? null,
        committed: false,
        setup: prior?.setup ?? null,
      };
      return { entries: [...entries.filter((entry) => entry !== prior), next], result: next };
    });
  }
  // Starts the service's setup, or returns the one already recorded. Retries and
  // double clicks therefore share one operation id.
  reserveSetup(input: {
    providerId: string;
    providerLabel: string;
    draftId: string;
    usage: string | null;
    actionId: string;
    expectedConfigurationRevision: string;
  }) {
    return this.mutate((entries) => {
      const prior = entries.find((entry) => entry.providerId === input.providerId);
      if (prior?.setup) return { entries, result: { entry: prior, created: false } };
      const next: ServiceEntry = {
        providerId: input.providerId,
        providerLabel: prior?.providerLabel ?? input.providerLabel,
        draftId: input.draftId,
        usage: input.usage ?? prior?.usage ?? null,
        committed: prior?.committed ?? false,
        setup: {
          operationId: randomUUID(),
          actionId: input.actionId,
          expectedConfigurationRevision: input.expectedConfigurationRevision,
        },
      };
      return { entries: [...entries.filter((entry) => entry !== prior), next], result: { entry: next, created: true } };
    });
  }
  // Takes over a setup that an older console kept in the browser. The service's
  // current setup wins if it has one.
  adoptSetup(input: ServiceEntry & { setup: ServiceSetup }) {
    return this.mutate((entries) => {
      const prior = entries.find((entry) => entry.providerId === input.providerId);
      if (prior?.setup) {
        return { entries, result: { entry: prior, adopted: prior.setup.operationId === input.setup.operationId } };
      }
      const next: ServiceEntry = {
        ...input,
        draftId: prior?.draftId ?? input.draftId,
        committed: prior?.committed ?? false,
      };
      return { entries: [...entries.filter((entry) => entry !== prior), next], result: { entry: next, adopted: true } };
    });
  }
  markCommitted(draftId: string) {
    return this.mutate((entries) => ({
      entries: entries.map((entry) => (entry.draftId === draftId ? { ...entry, committed: true } : entry)),
      result: undefined,
    }));
  }
  // The draft is gone. The entry stays only while a setup still needs it.
  dropDraft(draftId: string) {
    return this.mutate((entries) => ({
      entries: entries.flatMap((entry) => {
        if (entry.draftId !== draftId) return [entry];
        return entry.setup ? [{ ...entry, draftId: null, committed: false }] : [];
      }),
      result: undefined,
    }));
  }
  // The setup has ended with nothing left to remove.
  dropSetup(operationId: string) {
    return this.mutate((entries) => ({
      entries: entries.flatMap((entry) => {
        if (entry.setup?.operationId !== operationId) return [entry];
        return entry.draftId ? [{ ...entry, setup: null }] : [];
      }),
      result: undefined,
    }));
  }
}

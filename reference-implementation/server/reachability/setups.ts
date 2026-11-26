// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  // Setup operations a console started for this service that the host still
  // holds and that this service does not use. Each needs cleaning up.
  cleanup: string[];
};

// The journal file exists but is not a journal this code can read. It is kept
// as it is; nothing writes over it until an owner looks at it.
export class SetupsJournalCorruptError extends Error {
  readonly code = "setups_journal_corrupt";
  constructor(detail: string) {
    super(`The saved setup list is unreadable (${detail}). It was left as it is.`);
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// Keeps only known fields. Returns null for an entry that is not usable.
function parseEntry(value: unknown): ServiceEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isText(raw.providerId) || !isText(raw.providerLabel)) return null;
  const rawSetup = raw.setup;
  let setup: ServiceSetup | null = null;
  if (rawSetup !== null && rawSetup !== undefined) {
    if (typeof rawSetup !== "object") return null;
    const item = rawSetup as Record<string, unknown>;
    if (!isText(item.operationId) || !isText(item.actionId) || !isText(item.expectedConfigurationRevision)) return null;
    setup = {
      operationId: item.operationId,
      actionId: item.actionId,
      expectedConfigurationRevision: item.expectedConfigurationRevision,
    };
  }
  if (raw.draftId !== null && raw.draftId !== undefined && !isText(raw.draftId)) return null;
  if (raw.usage !== null && raw.usage !== undefined && typeof raw.usage !== "string") return null;
  const cleanup = raw.cleanup === undefined ? [] : raw.cleanup;
  if (!Array.isArray(cleanup) || !cleanup.every(isText)) return null;
  return {
    providerId: raw.providerId,
    providerLabel: raw.providerLabel,
    draftId: (raw.draftId as string | null | undefined) ?? null,
    usage: (raw.usage as string | null | undefined) ?? null,
    committed: raw.committed === true,
    setup,
    cleanup: [...new Set(cleanup as string[])],
  };
}

// Writes the directory entry itself to disk, so a rename or a new directory
// survives a crash. Platforms that cannot open a directory skip it.
async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (["EISDIR", "EPERM", "EACCES", "ENOENT"].includes((error as { code?: string }).code ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!["EISDIR", "EPERM", "EINVAL", "ENOTSUP"].includes((error as { code?: string }).code ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

export class ReachabilitySetups {
  private readonly file: string;
  private readonly root: string;
  // Writes run one at a time, so check-then-write sequences stay atomic.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly syncDirectory: (path: string) => Promise<void>;
  constructor(root: string, syncDir: (path: string) => Promise<void> = syncDirectory) {
    this.syncDirectory = syncDir;
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
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SetupsJournalCorruptError("not JSON");
    }
    if (!Array.isArray(value)) throw new SetupsJournalCorruptError("not a list");
    const entries: ServiceEntry[] = [];
    for (const item of value) {
      const entry = parseEntry(item);
      if (!entry) throw new SetupsJournalCorruptError("an entry is not valid");
      entries.push(entry);
    }
    return entries;
  }
  private async save(entries: ServiceEntry[]): Promise<void> {
    const created = await mkdir(this.root, { mode: 0o700, recursive: true });
    // `created` is the first directory this call made. Its parent must record
    // it, or a crash can lose the whole directory and the file with it.
    if (created) await this.syncDirectory(dirname(created));
    const temporary = `${this.file}.${randomUUID()}.pending`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(entries)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.file);
    await this.syncDirectory(this.root);
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
        cleanup: prior?.cleanup ?? [],
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
        cleanup: prior?.cleanup ?? [],
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
  adoptSetup(input: Omit<ServiceEntry, "cleanup"> & { setup: ServiceSetup }) {
    return this.mutate((entries) => {
      const prior = entries.find((entry) => entry.providerId === input.providerId);
      if (prior?.setup) {
        return { entries, result: { entry: prior, adopted: prior.setup.operationId === input.setup.operationId } };
      }
      const next: ServiceEntry = {
        ...input,
        draftId: prior?.draftId ?? input.draftId,
        committed: prior?.committed ?? false,
        cleanup: prior?.cleanup ?? [],
      };
      return { entries: [...entries.filter((entry) => entry !== prior), next], result: { entry: next, adopted: true } };
    });
  }
  // A second setup operation for a service that already has one. The host
  // still holds it, so the journal keeps its id until it is cleaned up.
  addCleanup(input: { providerId: string; providerLabel: string; operationId: string }) {
    return this.mutate((entries) => {
      const prior = entries.find((entry) => entry.providerId === input.providerId);
      const base: ServiceEntry = prior ?? {
        providerId: input.providerId,
        providerLabel: input.providerLabel,
        draftId: null,
        usage: null,
        committed: false,
        setup: null,
        cleanup: [],
      };
      const next = { ...base, cleanup: [...new Set([...base.cleanup, input.operationId])] };
      return { entries: [...entries.filter((entry) => entry !== prior), next], result: next };
    });
  }
  // Takes over a draft an older console kept in the browser, unless the
  // service already has one. Returns whether the journal now names it.
  adoptDraft(input: { providerId: string; providerLabel: string; draftId: string; usage: string | null }) {
    return this.mutate((entries) => {
      const prior = entries.find((entry) => entry.providerId === input.providerId);
      if (prior?.draftId) return { entries, result: { adopted: prior.draftId === input.draftId } };
      const next: ServiceEntry = {
        providerId: input.providerId,
        providerLabel: prior?.providerLabel ?? input.providerLabel,
        draftId: input.draftId,
        usage: input.usage ?? prior?.usage ?? null,
        committed: false,
        setup: prior?.setup ?? null,
        cleanup: prior?.cleanup ?? [],
      };
      return { entries: [...entries.filter((entry) => entry !== prior), next], result: { adopted: true } };
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
        return entry.setup || entry.cleanup.length ? [{ ...entry, draftId: null, committed: false }] : [];
      }),
      result: undefined,
    }));
  }
  // The setup has ended with nothing left to remove. It leaves the journal
  // whether it was the service's setup or a leftover one.
  dropSetup(operationId: string) {
    return this.mutate((entries) => ({
      entries: entries.flatMap((entry) => {
        const cleanup = entry.cleanup.filter((id) => id !== operationId);
        const next = { ...entry, cleanup, setup: entry.setup?.operationId === operationId ? null : entry.setup };
        return next.setup || next.draftId || next.cleanup.length ? [next] : [];
      }),
      result: undefined,
    }));
  }
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The provider catalog is read by a page that polls it, and each read probes this
 * computer (installed tools, sign-in state). On some computers one read takes
 * seconds, so reads are shared:
 *
 * - A read newer than `freshMs` is served as it is.
 * - A read older than that but newer than `maxStaleMs` is served at once, and one
 *   background read replaces it.
 * - Anything older, or nothing, waits for one read. Callers that arrive while a
 *   read is under way join it.
 *
 * The value keeps its own `observedAt`: a served read says when it was made. Any
 * change this process makes to the configuration calls `invalidate()`, so an
 * owner never reads a catalog older than their own last change. The review that
 * Turn on approves does not use this cache.
 */
export const CATALOG_FRESH_MS = 10_000;
export const CATALOG_MAX_STALE_MS = 120_000;

export class CatalogCache<T> {
  private readonly load: () => Promise<T>;
  private readonly freshMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => number;
  private entry: { value: T; at: number } | null = null;
  private inflight: Promise<T> | null = null;
  // Bumped by invalidate(): a read that started before it must not fill the cache.
  private generation = 0;

  constructor(
    load: () => Promise<T>,
    options: { freshMs?: number; maxStaleMs?: number; now?: () => number } = {}
  ) {
    this.load = load;
    this.freshMs = options.freshMs ?? CATALOG_FRESH_MS;
    this.maxStaleMs = options.maxStaleMs ?? CATALOG_MAX_STALE_MS;
    this.now = options.now ?? Date.now;
  }

  read(): Promise<T> {
    const held = this.entry;
    if (held) {
      const age = this.now() - held.at;
      if (age < this.freshMs) return Promise.resolve(held.value);
      if (age < this.maxStaleMs) {
        // The caller gets the held read now; a failed refresh leaves it for the next caller to retry.
        this.refresh().catch(() => undefined);
        return Promise.resolve(held.value);
      }
    }
    return this.refresh();
  }

  invalidate(): void {
    this.generation++;
    this.entry = null;
    this.inflight = null;
  }

  private refresh(): Promise<T> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const run: Promise<T> = this.load().then(
      (value) => {
        if (generation === this.generation) this.entry = { value, at: this.now() };
        return value;
      }
    );
    const settled = run.finally(() => {
      if (this.inflight === settled) this.inflight = null;
    });
    this.inflight = settled;
    return settled;
  }
}

/** Calls that only read. Every other call on the host library may change the configuration or a route. */
const READS = new Set([
  "listProviders",
  "readConfigurationDraft",
  "readSetupOperation",
  "listRoutes",
  "routeStatus",
  "catalogRoutes",
  "watchRoutes",
  "reviewRouteConsent",
]);

/**
 * The library with a hook on every call that is not a read: once the call settles, or
 * fails, `onChange` runs. A new method on the library is a change until it is listed
 * as a read, so a missed entry costs a probe, never a stale catalog.
 */
export function watchForChanges<T extends object>(api: T, onChange: () => void): T {
  return new Proxy(api, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver);
      if (typeof member !== "function" || typeof property !== "string" || READS.has(property)) return member;
      return (...args: unknown[]) => {
        onChange();
        let result: unknown;
        try {
          result = member.apply(target, args);
        } catch (error) {
          onChange();
          throw error;
        }
        if (result instanceof Promise) {
          return result.finally(onChange);
        }
        onChange();
        return result;
      };
    },
  });
}

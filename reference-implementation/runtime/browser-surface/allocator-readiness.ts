// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const TRAILING_SLASHES = /\/+$/;

function discardBody(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}

/** Builds a bounded, read-only capability check; no credentials are sent. */
export function createAllocatorReadinessCheck({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): () => Promise<void> {
  const url = `${baseUrl.replace(TRAILING_SLASHES, "")}/readyz`;
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  return async () => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error("Allocator readiness timed out"), { code: "allocator_timeout" }));
        abort.abort();
      }, budget);
    });
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => fetchImpl(url, { method: "GET", signal: abort.signal }))
          .catch(() => {
            throw Object.assign(new Error("Allocator readiness fetch failed"), { code: "allocator_fetch" });
          })
          .then((response) => {
            // Status is authoritative; do not retain or log diagnostic bodies.
            discardBody(response);
            if (!response.ok) {
              throw Object.assign(new Error("Allocator readiness HTTP failure"), { code: "allocator_http" });
            }
          }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
}

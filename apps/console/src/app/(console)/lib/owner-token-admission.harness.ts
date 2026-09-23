// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared harness for the `owner-token-admission.*.test.ts` files.
 *
 * It runs the REAL console modules (`owner-token.ts`, the app-config client,
 * the desktop-settings Server Actions) against a REAL reference server
 * started in-process. Only the Next.js request boundary is substituted:
 * `next/headers` reads the current request's cookie from an
 * AsyncLocalStorage store (as Next's own request store does),
 * `next/navigation`'s `redirect()` throws a recognizable signal, and
 * `server-only` is emptied. Each topology lives in its own test file because
 * `owner-token.ts` reads `PDPP_OWNER_PASSWORD` once, at import.
 *
 * Needs `--experimental-test-module-mocks` (the console `test` script passes
 * it). The reference server's app-config store writes under `$HOME`, so this
 * harness points `HOME` at a scratch directory before the server starts.
 */

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";

export const OWNER_PASSWORD = "synthetic-owner-password-for-tests";
export const OWNER_SESSION_COOKIE = "pdpp_owner_session";

interface RequestContext {
  readonly cookie: string | null;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

export class RedirectSignal extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT ${url}`);
    this.url = url;
  }
}

/** Run `fn` as one incoming browser request carrying `cookie` (or none). */
export function asRequest<T>(cookie: string | null, fn: () => Promise<T>): Promise<T> {
  return requestStore.run({ cookie }, fn);
}

export function installNextRequestMocks(t: typeof test): void {
  assert.equal(
    typeof t.mock.module,
    "function",
    "run with --experimental-test-module-mocks (npm --prefix apps/console test passes it)"
  );
  t.mock.module("server-only", { namedExports: {} });
  t.mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({
        get(name: string) {
          const cookie = requestStore.getStore()?.cookie ?? null;
          return name === OWNER_SESSION_COOKIE && cookie ? { name, value: cookie } : undefined;
        },
      }),
      headers: async () => new Headers({ host: "localhost" }),
    },
  });
  t.mock.module("next/navigation", {
    namedExports: {
      redirect(url: string): never {
        throw new RedirectSignal(url);
      },
    },
  });
}

/** Records every outbound request so tests can prove which server was consulted. */
export function recordFetches(): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return original(input, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

interface StartedReference {
  asUrl: string;
  rsUrl: string;
  stop: () => Promise<void>;
}

interface CloseableServer {
  close: (cb: () => void) => void;
  closeAllConnections: () => void;
}

/**
 * Start a real reference AS+RS on loopback ephemeral ports and point the
 * console topology (`PDPP_AS_URL` / `PDPP_RS_URL`) at it. Call before the
 * console modules are imported.
 */
export async function startReference(opts: Record<string, unknown>): Promise<StartedReference> {
  const home = await mkdtemp(join(tmpdir(), "owner-token-admission-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  // Non-literal specifiers keep the reference server out of the console's
  // type-check program; it is type-checked under its own tsconfig.
  const serverDir: string = "../../../../../../reference-implementation/server";
  const { startServer } = (await import(`${serverDir}/index.ts`)) as {
    startServer: (opts: Record<string, unknown>) => Promise<unknown>;
  };
  const { closeDb } = (await import(`${serverDir}/db.ts`)) as { closeDb: () => void };
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0, ...opts })) as {
    asPort: number;
    asServer: CloseableServer;
    rsPort: number;
    rsServer: CloseableServer;
    schedulerManager?: { stop?: () => void };
    abortStartupBackfill?: (reason: string) => void;
  };
  const asUrl = `http://127.0.0.1:${server.asPort}`;
  const rsUrl = `http://127.0.0.1:${server.rsPort}`;
  process.env.PDPP_AS_URL = asUrl;
  process.env.PDPP_RS_URL = rsUrl;
  return {
    asUrl,
    rsUrl,
    async stop() {
      server.schedulerManager?.stop?.();
      server.abortStartupBackfill?.("test shutdown");
      for (const srv of [server.asServer, server.rsServer]) {
        srv.closeAllConnections();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
      closeDb();
      process.env.HOME = previousHome;
      await rm(home, { force: true, recursive: true });
    },
  };
}

/** Issue a session cookie value exactly as the AS would after a password login. */
export async function issueSessionCookie(password: string, { expired = false } = {}): Promise<string> {
  const { deriveOwnerSessionSecret, encodeOwnerSession, OWNER_SESSION_DEFAULT_SUBJECT_ID } = await import(
    "pdpp-reference-implementation/owner-session"
  );
  const now = Math.floor(Date.now() / 1000);
  const sub = OWNER_SESSION_DEFAULT_SUBJECT_ID;
  const payload = expired ? { exp: now - 60, iat: now - 3600, sub } : { exp: now + 3600, iat: now, sub };
  return encodeOwnerSession(payload, deriveOwnerSessionSecret(password));
}

export function isLoginRedirect(err: unknown): boolean {
  return err instanceof RedirectSignal && err.url.startsWith("/owner/login");
}

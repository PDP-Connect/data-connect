// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Post-commit browser-profile purge for an owner delete or revoke of one
// connection. A browser connector keeps the source's logged-in session in a
// persistent Chromium profile; after the owner removes the source that session
// must not stay on disk.
//
// Two places hold that profile:
//   - Local (Core, the RI child runtime): the connector runtime launches
//     Chromium with `<PDPP_BROWSER_PROFILE_ROOT or ~/.pdpp/profiles>/
//     <profileName>__<connectorInstanceId>` (packages/polyfill-connectors
//     connector-runtime.ts `resolveBrowserRuntimeVisibility`, browser-launch.ts
//     `acquireIsolatedBrowser`). The RI does not know `profileName`, so it
//     matches the `__<connectorInstanceId>` suffix instead.
//   - Desktop host (`PDPP_BROWSER_SURFACE_MODE=host`): the Tauri host owns the
//     profile; the RI asks it over the existing authenticated loopback
//     contract (`DELETE <endpoint>/browser-surface/profiles/<connector_key>`,
//     docs/host-capability-provider-contract.md).
//
// The purge never throws: the delete or revoke has already committed, so a
// purge failure is logged and returned for the route to report.

import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export type BrowserProfilePurgeResult =
  | { readonly status: "purged"; readonly target: "host" | "local"; readonly removed: number }
  | { readonly status: "absent"; readonly target: "host" | "local" }
  | {
      readonly status: "failed";
      readonly target: "host" | "local";
      readonly error_code: string;
      readonly message: string;
    };

export interface BrowserProfilePurgeInput {
  readonly connectorKey: string;
  readonly connectorInstanceId: string;
}

export type BrowserProfilePurger = (input: BrowserProfilePurgeInput) => Promise<BrowserProfilePurgeResult>;

interface PurgeLogger {
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
}

const CONSOLE_LOGGER: PurgeLogger = {
  error: (obj, msg) => console.error(msg ?? "browser profile purge failed", obj),
};

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const HOST_REQUEST_TIMEOUT_MS = 5000;

export function resolveLocalBrowserProfileRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PDPP_BROWSER_PROFILE_ROOT?.trim() || join(homedir(), ".pdpp", "profiles");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

// Removes every `<profileName>__<connectorInstanceId>` directory directly under
// `root`. Refuses a symlinked entry (never follows a link out of the root) and
// any resolved path that is not inside the resolved root.
export async function purgeLocalBrowserProfiles(
  root: string,
  connectorInstanceId: string
): Promise<BrowserProfilePurgeResult> {
  if (!SAFE_SEGMENT_RE.test(connectorInstanceId)) {
    return {
      error_code: "profile_purge_invalid_connection_id",
      message: "The connection id is not a safe profile-name segment.",
      status: "failed",
      target: "local",
    };
  }
  let realRoot: string;
  let entries: string[];
  try {
    realRoot = await realpath(root);
    entries = await readdir(realRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent", target: "local" };
    }
    throw err;
  }
  const suffix = `__${connectorInstanceId}`;
  const matches = entries.filter((entry) => {
    if (!entry.endsWith(suffix)) {
      return false;
    }
    const profileName = entry.slice(0, -suffix.length);
    // A profile name never contains "__"; requiring that keeps a connection id
    // from matching the tail of a different, longer connection id.
    return profileName.length > 0 && SAFE_SEGMENT_RE.test(profileName) && !profileName.includes("__");
  });
  let removed = 0;
  for (const entry of matches) {
    const candidate = join(realRoot, entry);
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        error_code: "profile_purge_refused_path",
        message: `Refused to remove '${entry}': it is not a real directory under the profile root.`,
        status: "failed",
        target: "local",
      };
    }
    const resolved = await realpath(candidate);
    if (!isInside(realRoot, resolved)) {
      return {
        error_code: "profile_purge_refused_path",
        message: `Refused to remove '${entry}': it resolves outside the profile root.`,
        status: "failed",
        target: "local",
      };
    }
    // Chromium holds `SingletonLock` while it runs against the profile (for
    // example a revoke while a run is still collecting). Removing a live
    // profile would corrupt that run, so refuse and report instead.
    if (await pathExists(join(resolved, "SingletonLock"))) {
      return {
        error_code: "profile_purge_in_use",
        message: `Refused to remove '${entry}': a browser is still using it. Remove the source again after the run ends.`,
        status: "failed",
        target: "local",
      };
    }
    await rm(resolved, { force: true, recursive: true });
    removed += 1;
  }
  return removed > 0 ? { removed, status: "purged", target: "local" } : { status: "absent", target: "local" };
}

async function purgeHostBrowserProfile(
  { endpoint, token }: { endpoint: string; token: string },
  connectorKey: string,
  fetchImpl: typeof fetch
): Promise<BrowserProfilePurgeResult> {
  const url = `${endpoint.replace(/\/+$/u, "")}/browser-surface/profiles/${encodeURIComponent(connectorKey)}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    method: "DELETE",
    signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 204) {
    return { removed: 1, status: "purged", target: "host" };
  }
  if (response.status === 404) {
    return { status: "absent", target: "host" };
  }
  let hostError = "host_error";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") {
      hostError = body.error.slice(0, 100);
    }
  } catch {
    // The host sent no JSON body; keep the generic code.
  }
  return {
    error_code: `profile_purge_host_${hostError}`,
    message: `The desktop host refused the browser profile reset (HTTP ${response.status}).`,
    status: "failed",
    target: "host",
  };
}

export function createBrowserProfilePurger({
  env = process.env,
  fetchImpl = fetch,
  logger,
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: PurgeLogger | null;
} = {}): BrowserProfilePurger {
  const log = logger ?? CONSOLE_LOGGER;
  const hostMode = env.PDPP_BROWSER_SURFACE_MODE?.trim() === "host";
  const hostEndpoint = env.PDPP_BROWSER_SURFACE_HOST_ENDPOINT?.trim() ?? "";
  const hostToken = env.PDPP_BROWSER_SURFACE_HOST_TOKEN?.trim() ?? "";
  return async ({ connectorKey, connectorInstanceId }) => {
    const target = hostMode ? "host" : "local";
    let result: BrowserProfilePurgeResult;
    try {
      result = hostMode
        ? await purgeHostBrowserProfile({ endpoint: hostEndpoint, token: hostToken }, connectorKey, fetchImpl)
        : await purgeLocalBrowserProfiles(resolveLocalBrowserProfileRoot(env), connectorInstanceId);
    } catch (err) {
      result = {
        error_code: "profile_purge_failed",
        message: err instanceof Error ? err.message : String(err),
        status: "failed",
        target,
      };
    }
    if (result.status === "failed") {
      log.error?.(
        {
          connection_id: connectorInstanceId,
          connector_key: connectorKey,
          error_code: result.error_code,
          target: result.target,
        },
        `browser profile purge failed after the connection change committed: ${result.message}`
      );
    }
    return result;
  };
}

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
//     contract (`DELETE <endpoint>/browser-surface/profiles/<connector_key>/
//     <connectorInstanceId>`, docs/host-capability-provider-contract.md). The
//     host keeps one profile per connection. Before that it kept one per
//     connector; when the owner has no other connection of the connector, the
//     purge also asks the host to remove that old profile (`?legacy=remove`),
//     because it can only have belonged to this connection.
//
// The purge never throws: the delete or revoke has already committed, so a
// purge failure is logged and returned for the route to report.

import { lstat, readdir, readlink, realpath, rm, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
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
  // Needed to decide whether the host's old per-connector profile is this
  // connection's.
  readonly ownerSubjectId?: string | null;
}

// Counts the owner's connections of `connectorKey` other than
// `connectorInstanceId`, in any status.
export type CountOtherConnections = (input: {
  readonly connectorKey: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
}) => Promise<number> | number;

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

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

// Chromium's singleton files (`SingletonLock` -> `<hostname>-<pid>`,
// `SingletonCookie`, `SingletonSocket`). Mirrors
// packages/polyfill-connectors/src/profile-lock.ts; the RI cannot import it
// because the Docker reference image does not ship that package.
const SINGLETON_FILE_NAMES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A lock is live only when it names this host and a running pid. Chromium
// leaves the lock behind when it dies non-gracefully (SIGKILL, OOM, a
// cancelled run), and that residue must not block the purge forever.
async function isLiveSingletonLock(profileDir: string): Promise<boolean> {
  let target: string;
  try {
    target = await readlink(join(profileDir, "SingletonLock"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    if (code === "EINVAL") {
      // A regular file, not Chromium's symlink: no owner to check.
      return false;
    }
    throw err;
  }
  const separator = target.lastIndexOf("-");
  const lockHost = separator > 0 ? target.slice(0, separator) : "";
  const pid = Number(target.slice(separator + 1));
  if (lockHost !== hostname() || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  return processIsAlive(pid);
}

async function removeChromiumSingletonResidue(profileDir: string): Promise<void> {
  for (const name of SINGLETON_FILE_NAMES) {
    try {
      await unlink(join(profileDir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
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
    // profile would corrupt that run, so refuse and report instead. A lock
    // left behind by a crashed or killed browser is residue: clear it and go on.
    if (await isLiveSingletonLock(resolved)) {
      return {
        error_code: "profile_purge_in_use",
        message: `Refused to remove '${entry}': a browser is still using it. Retry the browser-session removal after the run ends.`,
        status: "failed",
        target: "local",
      };
    }
    await removeChromiumSingletonResidue(resolved);
    await rm(resolved, { force: true, recursive: true });
    removed += 1;
  }
  return removed > 0 ? { removed, status: "purged", target: "local" } : { status: "absent", target: "local" };
}

async function purgeHostBrowserProfile(
  { endpoint, token }: { endpoint: string; token: string },
  {
    connectorInstanceId,
    connectorKey,
    removeLegacy,
  }: { connectorInstanceId: string; connectorKey: string; removeLegacy: boolean },
  fetchImpl: typeof fetch
): Promise<BrowserProfilePurgeResult> {
  const url = `${endpoint.replace(/\/+$/u, "")}/browser-surface/profiles/${encodeURIComponent(connectorKey)}/${encodeURIComponent(connectorInstanceId)}${removeLegacy ? "?legacy=remove" : ""}`;
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

const RUN_ACTIVE_MESSAGE =
  "A collection run for this connection is still in progress, so its browser session was kept. Retry the browser-session removal after the run ends.";

export function createBrowserProfilePurger({
  countOtherConnections,
  env = process.env,
  isConnectionRunActive,
  fetchImpl = fetch,
  logger,
}: {
  countOtherConnections?: CountOtherConnections;
  env?: NodeJS.ProcessEnv;
  // A headless browser (chrome-headless-shell) writes no SingletonLock, so the
  // lock check alone cannot see a live run. The run registry can.
  isConnectionRunActive?: (connectorInstanceId: string) => Promise<boolean> | boolean;
  fetchImpl?: typeof fetch;
  logger?: PurgeLogger | null;
} = {}): BrowserProfilePurger {
  const log = logger ?? CONSOLE_LOGGER;
  const hostMode = env.PDPP_BROWSER_SURFACE_MODE?.trim() === "host";
  const hostEndpoint = env.PDPP_BROWSER_SURFACE_HOST_ENDPOINT?.trim() ?? "";
  const hostToken = env.PDPP_BROWSER_SURFACE_HOST_TOKEN?.trim() ?? "";
  return async ({ connectorKey, connectorInstanceId, ownerSubjectId }) => {
    const target = hostMode ? "host" : "local";
    let result: BrowserProfilePurgeResult;
    try {
      if (await isConnectionRunActive?.(connectorInstanceId)) {
        result = { error_code: "profile_purge_in_use", message: RUN_ACTIVE_MESSAGE, status: "failed", target };
      } else if (hostMode) {
        const removeLegacy =
          countOtherConnections && ownerSubjectId
            ? (await countOtherConnections({ connectorInstanceId, connectorKey, ownerSubjectId })) === 0
            : false;
        result = await purgeHostBrowserProfile(
          { endpoint: hostEndpoint, token: hostToken },
          { connectorInstanceId, connectorKey, removeLegacy },
          fetchImpl
        );
      } else {
        result = await purgeLocalBrowserProfiles(resolveLocalBrowserProfileRoot(env), connectorInstanceId);
      }
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

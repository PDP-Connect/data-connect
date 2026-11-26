// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-header allowlist for this process's own listener, active ONLY when
 * `HOSTNAME` (set by `src-tauri/src/unified.rs`'s `console_process_spec`)
 * is non-loopback -- i.e. only for the `my_devices_only` posture. Every
 * other posture keeps `HOSTNAME=127.0.0.1` and this check never activates,
 * so existing behavior for the loopback-only case is unchanged.
 *
 * This is the same allowlist-and-reject shape as the reference server's
 * `isAllowedRequestHost` (`reference-implementation/server/
 * reachability-contract.ts`), and exists for the same reason: a browser on
 * this LAN visiting an attacker's page can be made to send a request to
 * this listener with an attacker-chosen Host header (DNS rebinding). Before
 * this posture existed, the console had no Host check at all because it
 * was never reachable from anything but this same machine's loopback
 * interface -- binding a LAN address changes that, so this check exists
 * specifically to close the gap `my_devices_only` opens. See the fixes for
 * CVE-2025-49596 (Anthropic's MCP Inspector) and GHSA-89vp-x53w-74fx (Rust
 * MCP SDK), both the same missing-Host-check-on-a-locally-bound-HTTP-server
 * shape, both fixed by adding exactly this kind of allowlist.
 */
function isLoopbackBindHost(bindHost: string): boolean {
  return (
    bindHost === "" ||
    bindHost === "127.0.0.1" ||
    bindHost === "localhost" ||
    bindHost === "::1"
  );
}

function requestHostname(host: string): string {
  const withoutPort = host.split(":")[0] ?? host;
  return withoutPort.toLowerCase();
}

/**
 * Pure predicate behind `isAllowedConsoleHost`, parameterized for testing
 * without mutating `process.env`.
 */
export function isAllowedConsoleHostFor(
  requestHost: string,
  bindHost: string,
  trustedHosts: readonly string[]
): boolean {
  if (isLoopbackBindHost(bindHost)) {
    return true;
  }
  const hostname = requestHostname(requestHost);
  return (
    hostname === bindHost.trim().toLowerCase() ||
    trustedHosts.some(trusted => trusted.trim().toLowerCase() === hostname)
  );
}

const consoleBindHost = () => process.env.HOSTNAME?.trim() ?? "";
const consoleTrustedHosts = () =>
  (process.env.PDPP_TRUSTED_HOSTS ?? "")
    .split(",")
    .map(host => host.trim())
    .filter(Boolean);

/** The allowlist for this process, from its environment at the time of the request. */
export function isAllowedConsoleRequestHost(host: string): boolean {
  return isAllowedConsoleHostFor(host, consoleBindHost(), consoleTrustedHosts());
}

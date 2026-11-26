// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";

export const consoleProofPath = "/api/reachability/console-proof";
export const consoleChallengeHeader = "x-pdpp-console-challenge";
export const consoleProofHeader = "x-pdpp-console-proof";

// Bind the response to a one-use challenge and the supervised console process.
// The desktop session's key never travels over this listener.
export function consoleProof(key: string, challenge: string, pid: number, port: number): string {
  return createHmac("sha256", key).update(`pdpp.console-proof.v1:${pid}:${port}:${challenge}`).digest("hex");
}

// The desktop launcher records its own pid here before it execs into the server
// (Linux) or forks it (elsewhere), so the pid a lease names is known either way.
// Without it the launcher is taken to be the parent, as before.
export function launcherPid(env: NodeJS.ProcessEnv = process.env): number {
  const pid = Number(env.PDPP_LAUNCHER_PID);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : process.ppid;
}

export function respondToConsoleProof(request: Request): Response {
  const key = process.env.PDPP_OWNER_CREDENTIAL_REVEAL_PROOF;
  const challenge = request.headers.get(consoleChallengeHeader);
  const port = Number(process.env.PORT);
  if (process.env.PDPP_MANAGED_DESKTOP_HOST !== "1" || process.env.HOSTNAME !== "127.0.0.1" ||
      !key || !challenge || !/^[0-9a-f]{64}$/.test(challenge) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return new Response(null, { status: 404 });
  }
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", [consoleProofHeader]: consoleProof(key, challenge, launcherPid(), port) },
  });
}

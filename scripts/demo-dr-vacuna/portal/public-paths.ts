// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Which AS paths the walkthrough's public listener forwards (server.ts).
// The AS runs without an owner password, so owner, token, PAR, ingest and
// registration endpoints must stay reachable only on loopback.

/** Paths a browser needs on the AS during the walkthrough. */
export function isPublicAsPath(method: string, path: string): boolean {
  if (path === "/pilot" || path.startsWith("/pilot/")) {
    // The pilot's own surface, except the client-facing lifecycle endpoint
    // (the reminder service calls it on loopback).
    return path !== "/pilot/vacuna/grant-lifecycle";
  }
  const read = method === "GET" || method === "HEAD";
  if (path === "/oauth/authorize" || path.startsWith("/.well-known/")) {
    return read;
  }
  return path === "/consent" && read;
}

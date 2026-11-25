// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const PRIVATE_172_ADDRESS = /^172\.(1[6-9]|2\d|3[01])\./;

export function needsRemoteAccess(origin: string): boolean {
  const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host.endsWith(".local") || host === "::1" || host.startsWith("127.") ||
    host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") ||
    PRIVATE_172_ADDRESS.test(host) || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")
  );
}

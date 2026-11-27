// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const PRIVATE_172_ADDRESS = /^172\.(1[6-9]|2\d|3[01])\./;

export type AddressKind = "this-computer" | "private-network" | "public";

/** Who can use an address: only this computer, only the owner's own network, or anyone on the internet. */
export function addressReach(origin: string): { kind: AddressKind; phrase: string | null } {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    // A value that is not an address is never offered as reachable from the internet.
    return { kind: "private-network", phrase: "only works on your own network" };
  }
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return { kind: "this-computer", phrase: "only works on this computer" };
  const privateName =
    host.endsWith(".local") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") ||
    PRIVATE_172_ADDRESS.test(host) ||
    (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) ||
    (!host.includes(".") && !host.includes(":"));
  return privateName ? { kind: "private-network", phrase: "only works on your own network" } : { kind: "public", phrase: null };
}

export function needsRemoteAccess(origin: string): boolean {
  return addressReach(origin).kind !== "public";
}

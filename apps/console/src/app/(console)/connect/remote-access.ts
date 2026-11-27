// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const PRIVATE_172_ADDRESS = /^172\.(1[6-9]|2\d|3[01])\./;

export type AddressKind = "this-computer" | "private-network" | "public" | "unusable";

/** Who can use an address: only this computer, only the owner's own network, or anyone on the internet. */
export function addressReach(origin: string): { kind: AddressKind; phrase: string | null } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { kind: "unusable", phrase: null };
  }
  // Not an address an assistant could use: other schemes, or sign-in details inside the address.
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return { kind: "unusable", phrase: null };
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  host = host.replace(/\.+$/, "");
  if (host === "0.0.0.0" || host === "::" || host === "") return { kind: "unusable", phrase: null };
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return { kind: "this-computer", phrase: "only works on this computer" };
  const firstHextet = host.includes(":") ? Number.parseInt(host.split(":")[0] || "0", 16) : Number.NaN;
  const secondOctet = /^100\.(\d+)\./.exec(host)?.[1];
  const privateName =
    host.endsWith(".local") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") ||
    PRIVATE_172_ADDRESS.test(host) ||
    (secondOctet !== undefined && Number(secondOctet) >= 64 && Number(secondOctet) <= 127) ||
    // fc00::/7 (unique local) and fe80::/10 (link local)
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
    (!host.includes(".") && !host.includes(":"));
  return privateName ? { kind: "private-network", phrase: "only works on your own network" } : { kind: "public", phrase: null };
}

/** The address an assistant is given: the origin alone, whatever path or query the page address carried. */
export function mcpEndpoint(origin: string): string {
  return `${new URL(origin).origin}/mcp`;
}

export function needsRemoteAccess(origin: string): boolean {
  return addressReach(origin).kind !== "public";
}

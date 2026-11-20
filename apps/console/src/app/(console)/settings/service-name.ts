// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The name the owner reads for the service behind a way: "localhost.run can see
// what passes through." The library's display label can carry a word about the
// service's plan ("localhost.run trial"). The card names the service, so the
// console keeps its own names for those, by provider id, and shows the
// library's label for every other way. Stopgap: Gozar 0.5.2 gives a provider
// only its display label (`label`, on the inventory and on the candidate's
// `display`), with no separate service name. Delete this map when it does.

const serviceNames: Readonly<Record<string, string>> = {
  "localhost-run": "localhost.run",
  "tunnl-gg": "tunnl.gg",
};

export function serviceName(providerId: string | null | undefined, label: string): string {
  return (providerId ? serviceNames[providerId] : undefined) ?? label;
}

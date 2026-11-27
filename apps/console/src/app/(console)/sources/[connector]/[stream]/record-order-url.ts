// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function recordOrderHref(pathname: string, currentSearch: string, order: "asc" | "desc"): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("cursors");
  params.set("order", order);
  return `${pathname}?${params.toString()}`;
}

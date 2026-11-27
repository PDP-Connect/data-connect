"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useRouter, useSearchParams } from "next/navigation";
import { recordOrderHref } from "./record-order-url.ts";

export function RecordOrderSelect({
  currentOrder,
  pathname,
}: {
  currentOrder: "asc" | "desc";
  pathname: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSearch = searchParams?.toString() ?? "";

  return (
    <label className="flex items-center gap-2 text-muted-foreground text-sm">
      <span>Sort</span>
      <select
        aria-label="sort records"
        className="rounded-md border border-[var(--control-border)] bg-background px-2 py-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => {
          router.replace(recordOrderHref(pathname, currentSearch, event.currentTarget.value as "asc" | "desc"), {
            scroll: false,
          });
        }}
        value={currentOrder}
      >
        <option value="desc">Newest first</option>
        <option value="asc">Oldest first</option>
      </select>
    </label>
  );
}

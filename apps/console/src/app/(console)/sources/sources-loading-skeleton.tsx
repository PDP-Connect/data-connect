// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, Text } from "@pdpp/brand-react";
import Link from "next/link";
import { LoadingRegion } from "../components/route-loading.tsx";

const ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

/**
 * The Data sources page while it loads: the page's own header (title and the
 * "Add a data source" button, which need no data), then one plain row per data
 * source: a logo, a name, a status line. No table columns, so it matches the
 * list that follows at phone width.
 */
export function SourcesLoadingSkeleton() {
  return (
    <LoadingRegion label="data sources">
      <header className="rr-s-header">
        <div className="rr-s-header__title-row">
          <Text as="h1" className="rr-s-header__title" size="title" weight="semi">Data sources</Text>
          <Link className={buttonVariants({ size: "sm", variant: "default" })} href="/sources/add">Add a data source</Link>
        </div>
      </header>
      <ul aria-hidden="true" className="divide-y divide-border/70 border-border/70 border-y">
        {ROW_KEYS.map((key) => (
          <li className="flex items-center gap-3 py-3" key={key}>
            <Bar className="h-8 w-8 shrink-0 rounded-md" />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Bar className="h-4 w-40 max-w-[60%]" />
              <Bar className="h-3 w-28 max-w-[40%]" />
            </span>
          </li>
        ))}
      </ul>
    </LoadingRegion>
  );
}

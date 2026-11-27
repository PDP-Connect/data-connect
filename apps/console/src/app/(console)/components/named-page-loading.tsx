// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import type { ReactNode } from "react";
import { LoadingRegion } from "./route-loading.tsx";

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

const ROW_KEYS = ["row-a", "row-b", "row-c", "row-d", "row-e", "row-f", "row-g", "row-h"] as const;

export type LoadingShape = "form" | "list" | "none" | "rows" | "text";

/**
 * A page while it loads: the page's own trail and title (both known before any data),
 * then rows of the kind the page shows. Its screen-reader text uses the page's own name,
 * so a person never hears a word the finished page does not use.
 */
export function NamedPageLoadingSkeleton({
  breadcrumbs,
  children,
  framed = false,
  label,
  rowAction = true,
  rows = 5,
  shape,
  title,
}: {
  breadcrumbs?: readonly { href?: string; label: string }[];
  /** For a shape of the page's own, drawn under the header (use with shape "none"). */
  children?: ReactNode;
  /** The page sits in the width and padding wrapper that Settings pages use. */
  framed?: boolean;
  /** The page's own name, e.g. "apps": announced as "Loading apps…". */
  label: string;
  /** Whether each row of a "list" has a button at its right; the loaded rows of some pages have none. */
  rowAction?: boolean;
  rows?: number;
  shape: LoadingShape;
  title: string;
}) {
  const body = (
    <LoadingRegion label={label}>
      <PageHeader breadcrumbs={breadcrumbs ? [...breadcrumbs] : undefined} title={title} />
      {shape === "rows" ? <RowsShape rows={rows} /> : null}
      {shape === "list" ? <ListShape action={rowAction} rows={rows} /> : null}
      {shape === "form" ? <FormShape /> : null}
      {shape === "text" ? <TextShape /> : null}
      {children}
    </LoadingRegion>
  );
  return framed ? <div className="mx-auto grid min-w-0 w-full max-w-5xl gap-6 px-4 py-6">{body}</div> : body;
}

/** Name on the left, a short state on the right: Settings and the pages that look like it. */
function RowsShape({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="divide-y divide-border/70 border-y border-border/70">
      {ROW_KEYS.slice(0, rows).map((key) => (
        <div className="flex items-center justify-between gap-4 py-4" key={key}>
          <Bar className="h-4 w-48 max-w-[55%]" />
          <Bar className="h-3 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A mark, two lines and an action: a list of things the person owns. */
function ListShape({ action, rows }: { action: boolean; rows: number }) {
  return (
    <div aria-hidden="true" className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70">
      {ROW_KEYS.slice(0, rows).map((key) => (
        <div className="flex items-center gap-3 px-3 py-3" key={key}>
          <Bar className="size-8 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Bar className="h-4 w-40 max-w-[60%]" />
            <Bar className="h-3 w-28 max-w-[40%]" />
          </div>
          {action ? <Bar className="h-7 w-20 shrink-0 rounded-md" /> : null}
        </div>
      ))}
    </div>
  );
}

/** Two labelled fields and a button. */
function FormShape() {
  return (
    <div aria-hidden="true" className="grid max-w-xl gap-4 py-2">
      {["a", "b"].map((key) => (
        <div className="grid gap-2" key={key}>
          <Bar className="h-3 w-28" />
          <Bar className="h-11 w-full rounded-md" />
        </div>
      ))}
      <Bar className="h-11 w-40 rounded-md" />
    </div>
  );
}

/** Sentences under a heading: a page of explanation. */
function TextShape() {
  return (
    <div aria-hidden="true" className="grid max-w-xl gap-3">
      <Bar className="h-4 w-full" />
      <Bar className="h-4 w-5/6" />
      <Bar className="h-4 w-2/3" />
    </div>
  );
}

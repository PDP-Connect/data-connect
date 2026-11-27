// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

/**
 * A detail page while it loads, with the page's own trail and a title bar at the
 * title's place and size, so the title does not jump when the page arrives. The
 * trail stops at the steps that do not wait for data; the last step is the name.
 */
export function TitledDetailLoadingSkeleton({
  breadcrumbs,
  label,
  mark = false,
}: {
  breadcrumbs: readonly { href: string; label: string }[];
  label: string;
  /** The page's title starts with a 48 px service mark. */
  mark?: boolean;
}) {
  return (
    <div aria-busy="true" className="min-w-0">
      <span className="sr-only" role="status">Loading {label}…</span>
      <PageHeader
        breadcrumbs={[...breadcrumbs]}
        title={
          <span className="inline-flex items-center gap-2">
            {mark ? <Bar className="size-12 shrink-0 rounded-md" /> : null}
            <Bar className="h-7 w-48 max-w-[60%]" />
          </span>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-md border border-border/70 px-4 py-4">
          <Bar className="h-4 w-32" />
          <Bar className="h-3 w-full max-w-md" />
          <Bar className="h-3 w-2/3 max-w-sm" />
        </div>
      </div>
    </div>
  );
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";

/**
 * Route-level loading state for a single connection's detail page.
 *
 * The detail page fans out to schedule, recent runs, manifests, streams, and
 * device-exporter source instances, so it is one of the heavier dashboard
 * surfaces. Show a stable shell plus a detail skeleton while it resolves.
 */
export default function ConnectorDetailLoading() {
  return (
    <RecordroomShellWithPalette>
      <div aria-busy="true" className="min-w-0">
        <span className="sr-only" role="status">Loading this data source…</span>
        <div className="mb-6 border-border/80 border-b pb-5">
          <Bar className="mb-4 h-3 w-28" />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Bar className="size-12 shrink-0 rounded" />
              <div className="flex min-w-0 flex-col gap-2">
                <Bar className="h-7 w-56 max-w-[70vw]" />
                <Bar className="h-3 w-32" />
                <Bar className="h-3 w-24" />
              </div>
            </div>
            <Bar className="h-8 w-24" />
          </div>
        </div>
        <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <main className="min-w-0 space-y-8">
            <SectionSkeleton rows={3} />
            <SectionSkeleton rows={2} />
          </main>
          <aside className="min-w-0 space-y-8">
            <SectionSkeleton rows={1} />
            <SectionSkeleton rows={1} />
            <SectionSkeleton rows={3} />
          </aside>
        </div>
      </div>
    </RecordroomShellWithPalette>
  );
}

function SectionSkeleton({ rows }: { rows: number }) {
  const rowKeys = Array.from({ length: rows }, (_, index) => `source-detail-skeleton-row-${index}`);

  return (
    <section className="border-border border-t pt-4">
      <Bar className="mb-4 h-5 w-36" />
      <div className="flex flex-col gap-4">
        {rowKeys.map((key) => (
          <div className="flex flex-col gap-2" key={key}>
            <Bar className="h-4 w-40 max-w-[70%]" />
            <Bar className="h-3 w-64 max-w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

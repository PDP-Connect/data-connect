// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { TitledDetailLoadingSkeleton } from "../../../components/titled-detail-loading.tsx";

/**
 * Route-level loading state for a stream's records table.
 *
 * `/sources/[connector]/[stream]` is `force-dynamic` and awaits the
 * connection resolution, a paged `queryRecords` read, and the connector
 * manifests before it can paint — the surface the owner specifically reported
 * as slow. Without its own `loading.tsx` it inherited the connection-detail
 * skeleton (two stacked prose blocks), which is the wrong shape for a dense
 * record table and shifts the layout when the table arrives. A table-shaped
 * skeleton inside the stable shell gives immediate, correctly-shaped feedback.
 */
/**
 * Now drawn with the page's own title and trail so the title does not jump.
 */
export default function StreamRecordsLoading() {
  return (
    <RecordroomShellWithPalette>
      <TitledDetailLoadingSkeleton
        body={
          <div aria-hidden="true" className="divide-y divide-border/70 overflow-hidden rounded-md border border-border/70">
            {["a", "b", "c", "d", "e", "f"].map((key) => (
              <div className="flex items-center justify-between gap-4 px-3 py-3" key={key}>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span className="block h-4 w-40 max-w-full animate-pulse rounded bg-muted" />
                  <span className="block h-3 w-56 max-w-full animate-pulse rounded bg-muted" />
                </span>
                <span className="block h-3 w-16 shrink-0 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        }
        breadcrumbs={[{ href: "/sources", label: "Data sources" }]}
        label="records"
      />
    </RecordroomShellWithPalette>
  );
}

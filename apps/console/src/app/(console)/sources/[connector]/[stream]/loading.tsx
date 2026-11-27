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
              <div className="flex items-center gap-4 px-3 py-3" key={key}>
                <span className="block h-3.5 w-24 animate-pulse rounded bg-muted" />
                <span className="block h-3.5 w-28 animate-pulse rounded bg-muted" />
                <span className="block h-3.5 w-20 flex-1 animate-pulse rounded bg-muted" />
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

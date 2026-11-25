// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import "./sources-view.css";

/**
 * Route-level loading state for the data sources list.
 *
 * `/sources` loads a bounded page of summaries. This placeholder keeps the
 * list shape while that read resolves.
 */
export default function RecordsLoading() {
  return (
    <RecordroomShellWithPalette>
      <ListLoadingSkeleton label="data sources" rows={6} />
    </RecordroomShellWithPalette>
  );
}

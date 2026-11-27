// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/**
 * Route-level loading state for the schedules list.
 *
 * `/schedules` reads connector summaries to render per-connection
 * schedules, which can be slow against a remote reference deployment. Keep the
 * shell stable and animate a list skeleton while the data resolves.
 */
export default function SchedulesLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton label="schedules" rows={6} shape="list" title="Schedules" />
    </RecordroomShellWithPalette>
  );
}

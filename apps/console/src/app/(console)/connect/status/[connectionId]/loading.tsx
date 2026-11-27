// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { FirstSyncLoadingSkeleton } from "./first-sync-loading-skeleton.tsx";

/** Route-level loading state for the first-sync page; without it the page borrowed the neutral one. */
export default function FirstSyncLoading() {
  return (
    <RecordroomShellWithPalette>
      <FirstSyncLoadingSkeleton />
    </RecordroomShellWithPalette>
  );
}

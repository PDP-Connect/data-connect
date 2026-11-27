// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/** Route-level loading state for Settings: its trail, its title and the rows it shows. */
export default function SettingsLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton framed label="settings" rows={6} shape="rows" title="Settings" />
    </RecordroomShellWithPalette>
  );
}

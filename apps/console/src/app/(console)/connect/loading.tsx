// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/** Route-level loading state for Connect an app: its trail, its title and the rows it shows. */
export default function ConnectAppLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton label="Connect an app" shape="text" title="Connect an app" />
    </RecordroomShellWithPalette>
  );
}

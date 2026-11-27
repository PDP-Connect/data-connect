// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/** Route-level loading state for the Server page: its trail, its title and the rows it shows. */
export default function DeploymentLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Server" }]} framed label="server status" shape="rows" title="Server" />
    </RecordroomShellWithPalette>
  );
}

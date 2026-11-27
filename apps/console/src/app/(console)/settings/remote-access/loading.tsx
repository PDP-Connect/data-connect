// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";

/** Route-level loading state for Remote access: its trail, its title and the rows it shows. */
export default function RemoteAccessLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Remote access" }]} framed label="remote access" shape="text" title="Remote access" />
    </RecordroomShellWithPalette>
  );
}

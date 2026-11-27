// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../components/named-page-loading.tsx";

/** Route-level loading state for Collectors on your devices: its trail, its title and the rows it shows. */
export default function DeviceExportersLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Collectors on your devices" }]} framed label="collectors" shape="list" title="Collectors on your devices" />
    </RecordroomShellWithPalette>
  );
}

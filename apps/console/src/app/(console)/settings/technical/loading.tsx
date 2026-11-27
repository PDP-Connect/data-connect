// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";

/** Route-level loading state for Settings technical details: its trail, its title and the rows it shows. */
export default function TechnicalDetailsLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Settings technical details" }]} framed label="technical details" shape="text" title="Settings technical details" />
    </RecordroomShellWithPalette>
  );
}

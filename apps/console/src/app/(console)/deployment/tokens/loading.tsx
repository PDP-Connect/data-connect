// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { NamedPageLoadingSkeleton } from "../../components/named-page-loading.tsx";

/** Route-level loading state for tokens for scripts and tools: its trail, its title and the rows it shows. */
export default function TokensLoading() {
  return (
    <RecordroomShellWithPalette>
      <NamedPageLoadingSkeleton breadcrumbs={[{ href: "/settings", label: "Settings" }, { label: "Tokens for scripts and tools" }]} framed label="tokens" shape="list" title="Tokens for scripts and tools" />
    </RecordroomShellWithPalette>
  );
}

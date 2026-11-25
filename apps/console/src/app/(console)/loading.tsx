// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "./components/route-loading.tsx";

/**
 * Route-level loading state for Home. Next.js also uses it for every console
 * route without its own loading.tsx (connect flows, settings, notifications),
 * so the announced label names no single page.
 */
export default function HomeLoading() {
  return (
    <RecordroomShellWithPalette>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <ListLoadingSkeleton label="this page" rows={4} />
      </div>
    </RecordroomShellWithPalette>
  );
}

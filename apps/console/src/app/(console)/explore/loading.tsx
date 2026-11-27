// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ListLoadingSkeleton } from "../components/route-loading.tsx";
import { EXPLORE_LOADING_MESSAGE } from "./explore-presentation.ts";

/**
 * Route-level loading state for the Records Explorer.
 *
 * `/explore` is `force-dynamic` and, before it can paint, fans out to
 * connector summaries, connector manifests, and either a hybrid/lexical search
 * or an empty-query recency read — one of the heavier dashboard surfaces. Show a
 * stable Ink Carbon shell plus an animated list skeleton instead of a blank
 * frame while it resolves.
 */
export default function ExploreLoading() {
  return (
    <RecordroomShellWithPalette host="this server">
      <div className="mx-auto w-full max-w-5xl">
        <p aria-live="polite" className="mb-4 text-[13px] text-muted-foreground" role="status">
          {EXPLORE_LOADING_MESSAGE}
        </p>
        <ListLoadingSkeleton label="records" rows={8} />
      </div>
    </RecordroomShellWithPalette>
  );
}

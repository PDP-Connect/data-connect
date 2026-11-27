// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { LoadingRegion } from "./components/route-loading.tsx";

const KEYS = ["a", "b", "c", "d"] as const;

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

/**
 * Route-level loading state for Home: a title bar, then a section label and rows with a
 * logo each, as Home draws them. Next.js also uses it for any console route without its
 * own loading file, so the announced name stays "this page" there.
 */
export default function HomeLoading() {
  return (
    <RecordroomShellWithPalette>
      <LoadingRegion className="mx-auto max-w-6xl pb-8" label="this page">
        <header className="mb-8">
          <h1 className="font-semibold text-[23px] leading-tight min-[860px]:text-[26px]">
            <Bar className="h-7 w-56 max-w-[70%]" />
          </h1>
          <Bar className="mt-3 h-4 w-40" />
        </header>
        <div className="mb-2"><Bar className="h-4 w-24" /></div>
        <div aria-hidden="true" className="divide-y divide-border/70">
          {KEYS.map((key) => (
            <div className="flex items-center gap-3 py-3" key={key}>
              <Bar className="size-8 shrink-0 rounded-md" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Bar className="h-4 w-40 max-w-[60%]" />
                <Bar className="h-3 w-56 max-w-[80%]" />
              </div>
            </div>
          ))}
        </div>
      </LoadingRegion>
    </RecordroomShellWithPalette>
  );
}

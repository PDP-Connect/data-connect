"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect } from "react";
import { EXPLORE_FAILED_MESSAGE } from "./explore-presentation.ts";

/**
 * Scoped Explore error boundary (App Router convention).
 *
 * Without this, an Explore render/data failure bubbled to the dashboard-wide
 * boundary and showed a full-page "Something went wrong". The most common
 * trigger is benign: backgrounding the PWA mid-load aborts the in-flight feed
 * fetch (an AbortError / "Failed to fetch" / "load failed"), so coming back
 * surfaced a scary full-dashboard error for what is just an interrupted load.
 *
 * This boundary keeps the failure inside Explore, recognises the
 * interrupted-load class, and leads with "Reload" (re-runs the server
 * component). Self-contained on purpose — no server-only imports (App Router
 * error boundaries are Client Components).
 */
export default function ExploreError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-body max-w-prose text-muted-foreground">{EXPLORE_FAILED_MESSAGE}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className={buttonVariants({ size: "sm", variant: "default" })} onClick={() => reset()} type="button">
          Try again
        </button>
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href="/">
          Back to DataConnect
        </a>
      </div>
    </main>
  );
}

"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useContext } from "react";

const ExploreClockContext = createContext<number | null>(null);

/**
 * One clock for a whole Explore render. The server reads it once and sends it down, so
 * the server draw and the browser's first draw word "5 minutes ago" from the same
 * instant. Two separate `Date.now()` calls can fall either side of a minute and make
 * React report that the text it hydrated is not the text the server drew.
 */
export function ExploreClock({ children, now }: { children: ReactNode; now: number }) {
  return <ExploreClockContext.Provider value={now}>{children}</ExploreClockContext.Provider>;
}

/** The render's shared instant, or the present moment where no clock was given. */
export function useExploreNow(): number {
  return useContext(ExploreClockContext) ?? Date.now();
}

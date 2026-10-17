"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useEffect, useState } from "react";
import { createRetryCounter, nextRetryDelayMs } from "../components/read-resilient-retry.ts";
import { DetailLoadingSkeleton } from "../components/route-loading.tsx";

/**
 * Settings-segment error boundary (App Router convention) — this route had
 * none before, unlike every sibling segment (`sources/error.tsx`,
 * `deployment/error.tsx`, etc.), so an unexpected client-render throw here
 * fell through to the console-wide root boundary instead of a
 * segment-appropriate one, or — if the throw happened above any boundary's
 * mount point — white-screened outright.
 *
 * Confirmed live, 2026-09-19: the actual settings-page hang Tim hit
 * ("Reading the current remote access state…" stuck forever) was NOT a
 * throw this boundary would have caught — the page's own JS chunk 404'd
 * because a live rebuild replaced the console's staged build directory out
 * from under its still-running server process (fixed at the source in
 * `scripts/ensure-console-stack.js`; a failed script load is a browser
 * resource-loading failure, invisible to a React error boundary). This
 * boundary is added anyway, for the DIFFERENT and real risk it does cover: a
 * genuine unhandled throw during render (a derivation bug, a null a
 * component didn't expect) must show a real "something went wrong" state
 * instead of white-screening, matching this codebase's own convention that
 * every other route segment already follows.
 *
 * Modeled on the console-wide root boundary (`(console)/error.tsx`), not the
 * RSC-stream-race boundaries (`sources/error.tsx` and its siblings): this
 * page's remote-access state comes from a `"use client"` component's own
 * `fetch`-in-`useEffect` (`remote-access-setting.tsx`), not an RSC server
 * read, so the "destination stream closed early" transport race those
 * boundaries retry unboundedly does not apply here — that component already
 * resolves its OWN fetch failures into a rendered `loadState === "failed"`
 * message rather than throwing (see `remote-access-setting.tsx`), so a throw
 * that reaches this boundary is presumptively a genuine code fault, not a
 * known-transient race. Retrying a genuine fault forever would hide it, so
 * this boundary retries quietly only a bounded number of times before
 * conceding — the same tradeoff `(console)/error.tsx` makes and explains in
 * its own doc comment.
 */

/** Bounded: absorb a handful of quiet retries before conceding this may be a real fault. */
const MAX_QUIET_ATTEMPTS = 5;

/**
 * Consecutive-failure counter, held at MODULE scope rather than component
 * state — see `read-resilient-retry.ts` for why a `useState` counter would
 * silently reset every catch and never actually back off.
 */
const retryCounter = createRetryCounter();

export default function SettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [gaveUp, setGaveUp] = useState(() => retryCounter.attempts >= MAX_QUIET_ATTEMPTS);

  useEffect(() => {
    // Logged for operator diagnostics only — never surfaced to the owner.
    console.error(error);
  }, [error]);

  useEffect(() => {
    if (gaveUp) {
      return;
    }
    const delay = nextRetryDelayMs(retryCounter.attempts);
    const id = setTimeout(() => {
      retryCounter.attempts += 1;
      if (retryCounter.attempts >= MAX_QUIET_ATTEMPTS) {
        setGaveUp(true);
        return;
      }
      reset();
    }, delay);
    return () => clearTimeout(id);
  }, [gaveUp, reset]);

  if (!gaveUp) {
    return (
      <div data-testid="settings-read-recovering">
        <DetailLoadingSkeleton label="Settings" />
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-[40vh] max-w-xl flex-col items-start justify-center gap-3 px-6 py-16">
      <p className="pdpp-eyebrow text-muted-foreground/60 uppercase tracking-widest">Settings</p>
      <h1 className="pdpp-heading text-foreground">Something went wrong</h1>
      <p className="pdpp-body max-w-prose text-muted-foreground">
        This page ran into an unexpected error. Your settings are unchanged — this is a display failure, not a change.
      </p>
      <button
        className={buttonVariants({ size: "sm", variant: "default" })}
        onClick={() => {
          retryCounter.attempts = 0;
          setGaveUp(false);
          reset();
        }}
        type="button"
      >
        Try again
      </button>
    </main>
  );
}

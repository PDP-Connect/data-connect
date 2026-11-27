// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level loading state for the sign-in helper. The loaded helper is a full-screen
 * browser view with a thin bar on top and no page header or card, so its loading screen
 * is the same: a dark full-screen frame with the bar, and a pulse where the browser goes.
 */
export default function SignInHelperLoading() {
  return (
    <div aria-busy="true" className="fixed inset-0 z-50 flex flex-col bg-black" role="status">
      <div className="flex shrink-0 items-center gap-2 bg-background px-3 py-1.5 text-[13px] text-muted-foreground">
        <span aria-hidden className="block h-3.5 w-24 animate-pulse rounded bg-muted" />
        <span>Loading the sign-in page…</span>
      </div>
      <div aria-hidden className="flex-1 animate-pulse bg-muted/20" />
    </div>
  );
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level loading state for the sign-in helper. The loaded helper is a full-screen
 * browser view with a thin bar on top and the instruction card low on the screen, and no
 * page header: so is its loading screen. The card's title is where the loaded title lands.
 */
export default function SignInHelperLoading() {
  return (
    <div aria-busy="true" className="fixed inset-0 z-50 flex flex-col bg-black" role="status">
      <div className="flex shrink-0 items-center gap-2 bg-background px-3 py-1.5 text-[13px] text-muted-foreground">
        <span aria-hidden className="block h-3.5 w-24 animate-pulse rounded bg-muted" />
        <span>Loading the sign-in page…</span>
      </div>
      <div aria-hidden className="flex-1 animate-pulse bg-muted/20" />
      <div aria-hidden className="absolute inset-x-4 bottom-16 grid gap-3 rounded-lg bg-card p-4 sm:left-auto sm:w-96">
        <h1 className="block h-6 w-48 max-w-full animate-pulse rounded bg-muted"><span className="sr-only">Signing in</span></h1>
        <span className="block h-3 w-32 animate-pulse rounded bg-muted" />
        <span className="block h-3 w-56 max-w-full animate-pulse rounded bg-muted" />
        <span className="block h-11 w-24 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

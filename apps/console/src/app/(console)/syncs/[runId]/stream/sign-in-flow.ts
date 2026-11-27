// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export function setupStatusHref(connectionId: string | null | undefined, runId: string): string {
  if (!connectionId) return "/sources";
  return `/connect/status/${encodeURIComponent(connectionId)}?${new URLSearchParams({ run_id: runId })}`;
}
export function signInDestination(state: "running" | "ended" | "resolved" | "preparing", href: string): string | null {
  return state === "running" || state === "ended" ? href : null;
}
export function scheduleSignInContinuation(href: string, navigate: (href: string) => void): () => void {
  const timer = setTimeout(() => navigate(href), 2000);
  return () => clearTimeout(timer);
}

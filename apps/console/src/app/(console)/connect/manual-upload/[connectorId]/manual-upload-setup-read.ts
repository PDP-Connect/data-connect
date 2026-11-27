// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * True when the server says this connector has no file import: 404 (no such
 * connector) or 409 `manual_upload_unsupported` (the connector exists but
 * declares no import setup). Both mean this page has nothing to show, so the
 * page answers "not found" instead of throwing into the root error boundary,
 * whose quiet retries show a loading skeleton for a fault no retry can fix.
 */
export function isMissingManualUploadSetup(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("status" in err)) return false;
  const { bodyText, status } = err as { bodyText?: unknown; status?: unknown };
  if (status === 404) return true;
  if (status !== 409 || typeof bodyText !== "string") return false;
  try {
    const body = JSON.parse(bodyText) as { error?: { code?: unknown } } | null;
    return body?.error?.code === "manual_upload_unsupported";
  } catch {
    return false;
  }
}

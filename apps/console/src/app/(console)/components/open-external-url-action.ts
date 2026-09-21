"use server"

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { openExternalUrl } from "../lib/open-external-url-client.ts"

export type OpenExternalUrlActionResult = { ok: true } | { ok: false; message: string }

function actionMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected open-external-url request failure."
}

/**
 * Server Action `OpenExternalLink` (`open-external-link.tsx`) calls on
 * click. The console window is loaded via `WebviewUrl::External` and never
 * gets Tauri's `invoke()` bridge (Tauri Discussion #2650), so the browser
 * can't open a system-browser tab through `@tauri-apps/plugin-shell`
 * directly -- see `../lib/open-external-url-client.ts` and
 * `reference-implementation/server/routes/owner-open-external-url.ts` for
 * the full chain. The URL is validated twice more downstream (the HTTP
 * route, then again in Rust before `open::that_detached`) -- this action
 * does no validation of its own, it is just the client-callable entry
 * point.
 */
export async function openExternalUrlAction(url: string): Promise<OpenExternalUrlActionResult> {
  try {
    await openExternalUrl(url)
    return { ok: true }
  } catch (err) {
    return { message: actionMessage(err), ok: false }
  }
}

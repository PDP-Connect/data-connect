// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The browser's side of the remote access transport: a fetch to the console's route handler.
// Each call is its own request, so a slow read never holds up the one behind it. The deadline
// starts when the request is sent, so it measures the request and nothing that came before it.
import { type PublicError, publicError } from "./reachability-errors.ts";

/** How long one request may run, from the moment it is sent. */
export const REQUEST_DEADLINE_MS = 15_000;
const ROUTE = "/api/reachability";

export async function requestReachability(
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | ({ ok: false } & PublicError)> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
  try {
    const response = await fetch(`${ROUTE}${path}`, {
      signal: controller.signal,
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401 && typeof window !== "undefined") {
      // The owner's session ended: sign in again, then come back here.
      const back = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/owner/login?return_to=${encodeURIComponent(back)}`);
    }
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && "ok" in payload) {
      return payload as { ok: true; data: unknown } | ({ ok: false } & PublicError);
    }
    return { ok: false, ...publicError("service_unreachable") };
  } catch {
    // A request that outlived its deadline is slow, not proof the service is down: the owner may try again.
    return { ok: false, ...publicError(controller.signal.aborted ? "reachability_unavailable" : "service_unreachable") };
  } finally {
    clearTimeout(deadline);
  }
}

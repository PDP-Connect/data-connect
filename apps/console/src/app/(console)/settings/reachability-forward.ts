// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The server half of the console's remote access transport. The browser calls the
// route handler at app/api/reachability with fetch; the handler calls this to reach the
// reference server with the owner's bearer, which never leaves the console server.
//
// It is not a Server Action on purpose: Next.js runs one client's Server Actions one at
// a time, so a request waited behind every earlier one, such as the page's own polling.
import { getOwnerToken, getRsInternalUrl } from "../lib/owner-token.ts";
import { type PublicError, publicError } from "./reachability-errors.ts";

export type ReachabilityResult = { ok: true; data: unknown } | ({ ok: false } & PublicError);
export type Forwarded = { status: number; result: ReachabilityResult };

/** How long one request to the reference server may run. It counts from when the request is sent. */
export const FORWARD_DEADLINE_MS = 15_000;
const PREFIX = "/v1/owner/reachability";

export async function forwardReachability(
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Forwarded> {
  if (!path.startsWith("/") || path.includes("..") || path.includes("#")) {
    throw new Error("Invalid remote access path");
  }
  const url = new URL(`${getRsInternalUrl()}${PREFIX}${path}`);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
    throw new Error("Invalid remote access path");
  }
  const controller = new AbortController();
  // The browser gave up: stop the work on its behalf too.
  const gone = () => controller.abort();
  signal?.addEventListener("abort", gone, { once: true });
  if (signal?.aborted) {
    controller.abort();
  }
  let timedOut = false;
  controller.signal.addEventListener("abort", () => {
    timedOut = !signal?.aborted;
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await getOwnerToken();
    // The deadline covers the request to the reference server, not reading the token.
    deadline = setTimeout(() => controller.abort(), FORWARD_DEADLINE_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as { data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) {
      return { status: response.status, result: { ok: false, ...publicError(payload.error?.code, payload.error?.message) } };
    }
    return { status: 200, result: { ok: true, data: payload.data } };
  } catch {
    // A request that outlived its deadline is slow, not proof the service is down: the owner may try again.
    return timedOut
      ? { status: 504, result: { ok: false, ...publicError("reachability_unavailable") } }
      : { status: 502, result: { ok: false, ...publicError("service_unreachable") } };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", gone);
  }
}

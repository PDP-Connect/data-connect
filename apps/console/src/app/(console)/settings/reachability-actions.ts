"use server";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { getOwnerToken, getRsInternalUrl } from "../lib/owner-token.ts";
import { type PublicError, publicError } from "./reachability-errors.ts";

export async function requestReachability(
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | ({ ok: false } & PublicError)> {
  await requireDashboardAccess("/settings");
  if (!path.startsWith("/") || path.includes("..") || path.includes("#")) {
    throw new Error("Invalid remote access path");
  }
  const prefix = "/v1/owner/reachability";
  const url = new URL(`${getRsInternalUrl()}${prefix}${path}`);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new Error("Invalid remote access path");
  }
  const token = await getOwnerToken();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as { data?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) {
      return { ok: false, ...publicError(payload.error?.code, payload.error?.message) };
    }
    return { ok: true, data: payload.data };
  } catch {
    // A request that outlived its deadline is slow, not proof the service is down: the owner may try again.
    return { ok: false, ...publicError(controller.signal.aborted ? "reachability_unavailable" : "service_unreachable") };
  } finally {
    clearTimeout(deadline);
  }
}

"use server";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { getOwnerToken, getRsInternalUrl } from "../lib/owner-token.ts";

export async function requestReachability(
  path: string,
  body?: Record<string, unknown>
): Promise<{ ok: true; data: unknown } | { ok: false; message: string; code: string }> {
  await requireDashboardAccess("/settings");
  if (!path.startsWith("/") || path.includes("..") || path.includes("#")) {
    throw new Error("Invalid reachability path");
  }
  const prefix = "/v1/owner/reachability";
  const url = new URL(`${getRsInternalUrl()}${prefix}${path}`);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    throw new Error("Invalid reachability path");
  }
  const token = await getOwnerToken();
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as { data?: unknown; error?: { code?: string } };
    if (!response.ok) {
      return {
        ok: false,
        code: payload.error?.code ?? "reachability_unavailable",
        message: "Reachability could not complete. Check its current state before retrying.",
      };
    }
    return { ok: true, data: payload.data };
  } catch {
    return {
      ok: false,
      code: "reachability_unavailable",
      message: "Reachability is unavailable. Check that the instance is running.",
    };
  }
}

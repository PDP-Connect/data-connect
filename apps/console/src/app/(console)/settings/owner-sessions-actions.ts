"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { getAsInternalUrl, withOwnerSessionCookie } from "../lib/owner-token.ts";
import { redirectToOwnerLogin } from "../lib/login-redirect.ts";

interface ActionResult {
  ok: boolean;
  message?: string;
}

async function postOwnerSessionAction(path: string): Promise<ActionResult> {
  await requireDashboardAccess("/settings");
  const response = await fetch(
    `${getAsInternalUrl()}${path}`,
    await withOwnerSessionCookie({
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    })
  );
  if (response.status === 401) {
    await redirectToOwnerLogin("/settings");
  }
  if (response.status === 204) {
    revalidatePath("/settings");
    return { ok: true };
  }
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, message: body?.error?.message ?? "Could not update owner sessions." };
}

export async function revokeOwnerSessionAction(id: string): Promise<ActionResult> {
  if (!/^[A-Za-z0-9_-]{16}$/u.test(id)) {
    return { ok: false, message: "Session id is invalid." };
  }
  return await postOwnerSessionAction(`/owner/sessions/${encodeURIComponent(id)}/revoke`);
}

export async function revokeOtherOwnerSessionsAction(): Promise<ActionResult> {
  return await postOwnerSessionAction("/owner/sessions/revoke-others");
}

export async function revokeAllOwnerSessionsAction(): Promise<ActionResult> {
  return await postOwnerSessionAction("/owner/sessions/revoke-all");
}

export async function revokeOwnerBearerAction(id: string): Promise<ActionResult> {
  if (!/^tok_[A-Za-z0-9_-]{43}$/u.test(id)) {
    return { ok: false, message: "Bearer id is invalid." };
  }
  return await postOwnerSessionAction(`/owner/bearers/${encodeURIComponent(id)}/revoke`);
}

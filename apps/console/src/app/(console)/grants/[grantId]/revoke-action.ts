"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server action for the operator-revoke affordance on `/grants/[grantId]`.
 *
 * Mirrors the package revoke action: re-verifies the owner session, requires
 * `confirm_revoke=yes`, POSTs to `/_ref/grants/:id/revoke` via the typed
 * dashboard client, and redirects back to the detail page with a banner.
 */

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { revokeGrant } from "../../lib/ref-client.ts";

function detailHref(grantId: string, params: Record<string, string> = {}): string {
  const sp = new URLSearchParams(params);
  const qs = sp.toString();
  const base = `/grants/${encodeURIComponent(grantId)}`;
  return qs ? `${base}?${qs}` : base;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Error inesperado al revocar la autorización.";
}

export async function revokeGrantAction(formData: FormData): Promise<void> {
  const grantIdRaw = formData.get("grant_id");
  const grantId = typeof grantIdRaw === "string" ? grantIdRaw.trim() : "";
  if (!grantId) {
    redirect("/grants");
  }

  await requireDashboardAccess(detailHref(grantId));

  const confirm = formData.get("confirm_revoke");
  if (typeof confirm !== "string" || confirm !== "yes") {
    redirect(detailHref(grantId, { revoke_error: "Marca la casilla de confirmación antes de revocar." }));
  }

  try {
    await revokeGrant(grantId);
  } catch (err) {
    redirect(detailHref(grantId, { revoke_error: errorMessage(err) }));
  }

  redirect(detailHref(grantId, { revoked: "yes" }));
}

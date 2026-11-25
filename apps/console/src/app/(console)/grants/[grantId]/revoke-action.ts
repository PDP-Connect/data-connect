"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAsInternalUrl, getOwnerToken } from "../../lib/owner-token.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function returnPath(value: string): string {
  if (value === "/connect") return value;
  return /^\/grants\/[^/?#]+$/.test(value) ? value : "/grants";
}

function errorPath(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}remove_error=${encodeURIComponent("Access could not be removed. Try again.")}`;
}

export async function revokeGrantAccessAction(formData: FormData) {
  const path = returnPath(asString(formData.get("return_to")));
  await requireDashboardAccess(path);
  const grantIds = [...new Set(formData.getAll("grant_id").map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
  if (asString(formData.get("confirm_revoke")) !== "yes" || grantIds.length === 0) {
    redirect(path);
  }

  try {
    const token = await getOwnerToken();
    for (const grantId of grantIds) {
      const response = await fetch(
        `${getAsInternalUrl()}/grants/${encodeURIComponent(grantId)}/revoke`,
        {
          body: "{}",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        }
      );
      if (!response.ok) throw new Error("revoke failed");
    }
  } catch {
    redirect(errorPath(path));
  }

  revalidatePath("/grants");
  revalidatePath("/connect");
  redirect(`${path}${path.includes("?") ? "&" : "?"}access_removed=yes`);
}

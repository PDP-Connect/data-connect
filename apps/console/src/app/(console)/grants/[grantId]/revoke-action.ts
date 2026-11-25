"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAsInternalUrl, getOwnerToken } from "../../lib/owner-token.ts";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { revokeGrantPackage } from "../../lib/ref-client.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function returnPath(value: string): string {
  if (value === "/connect") return value;
  return /^\/grants\/[^/?#]+$/.test(value) ? value : "/grants";
}

function formIds(formData: FormData, name: string): string[] {
  return [...new Set(formData.getAll(name).map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
}

function errorPath(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}remove_error=${encodeURIComponent("Access could not be removed. Try again.")}`;
}

export async function revokeGrantAccessAction(formData: FormData) {
  const path = returnPath(asString(formData.get("return_to")));
  await requireDashboardAccess(path);
  // A whole app can hold access inside packages: those are removed through the
  // package revoke, which also ends the package and its tokens. Access outside
  // a package is removed one by one through the per-access revoke.
  const packageIds = formIds(formData, "package_id");
  const grantIds = formIds(formData, "grant_id");
  if (asString(formData.get("confirm_revoke")) !== "yes" || (grantIds.length === 0 && packageIds.length === 0)) {
    redirect(path);
  }

  try {
    for (const packageId of packageIds) {
      // One removal at a time, so a failure stops the rest.
      await revokeGrantPackage(packageId);
    }
    const token = grantIds.length ? await getOwnerToken() : "";
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

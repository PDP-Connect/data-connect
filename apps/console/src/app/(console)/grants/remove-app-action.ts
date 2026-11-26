"use server";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { revalidatePath } from "next/cache";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { removeAppAccess, type RemoveAppAccessInput } from "../lib/ref-client.ts";
export async function removeAppAction(input: RemoveAppAccessInput) {
  await requireDashboardAccess("/grants");
  try {
    const result = await removeAppAccess(input);
    revalidatePath("/grants");
    revalidatePath("/connect");
    revalidatePath("/");
    revalidatePath("/sources", "layout");
    return {
      ok: result.failed_count === 0,
      failedGrantIds: result.failed_grant_ids,
      message: result.failed_count ? "Some access could not be removed. Try again." : null,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Access could not be removed. Try again." };
  }
}

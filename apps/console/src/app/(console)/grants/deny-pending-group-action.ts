"use server";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { denyPendingApproval } from "../lib/operator-approvals.ts";
export async function denyPendingGroupAction(form: FormData) {
  await requireDashboardAccess("/grants#pending-approvals");
  if (form.get("deny_confirmation") !== "yes") {
    redirect("/grants");
  }
  let failed = false;
  let requests: unknown;
  try {
    requests = JSON.parse(String(form.get("requests") || "[]"));
  } catch {
    redirect("/grants?approval_error=failed#pending-approvals");
  }
  if (!(Array.isArray(requests) && requests.length)) {
    redirect("/grants");
  }
  for (const request of requests) {
    if (!request || typeof request.approvalId !== "string" || !["consent", "owner_device"].includes(request.kind)) {
      failed = true;
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Keep denial writes ordered; each request independently reports failure.
      await denyPendingApproval({ approvalId: request.approvalId, kind: request.kind });
    } catch {
      failed = true;
    }
  }
  redirect(failed ? "/grants?approval_error=failed#pending-approvals" : "/grants");
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listAppAccess, listPendingApprovals } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
export async function loadApps(demo?: string) {
  if (process.env.NODE_ENV !== "production" && demo) {
    const { buildAppPractice } = await import("./app-practice.ts");
    return buildAppPractice(demo);
  }
  const [list, approvals] = await Promise.all([listAppAccess(), listPendingApprovals()]);
  return { apps: groupGrantAccessByApp(list.data), approvals: approvals.data };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { listAppAccess, listPendingApprovals } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
import { loadSourceNames } from "./load-source-names.ts";
export async function loadApps(demo?: string) {
  if (process.env.NODE_ENV !== "production" && demo) {
    const { buildAppPractice } = await import("./app-practice.ts");
    return buildAppPractice(demo);
  }
  const [list, approvals, sourceNames] = await Promise.all([
    listAppAccess(),
    listPendingApprovals(),
    loadSourceNames(),
  ]);
  return { apps: groupGrantAccessByApp(list.data, Date.now(), approvals.data, sourceNames), approvals: approvals.data };
}

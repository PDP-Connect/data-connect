// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppAccess, PendingApproval } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
export function buildAppPractice(demo: string) {
  const now = Date.now();
  const data: AppAccess[] = demo === "empty" ? [] : [{ client_id: "practice-chatgpt", client_name: "ChatGPT", return_host: "chatgpt.com", returns_to_this_computer: false, domain_control_verified: true, reads_last_7_days: 2, sources: [{ source: { kind: "connector", id: "gmail", connector_id: "gmail", connection_id: "practice-mail" }, kinds: ["messages", "threads", "labels"], in_force: true, first_issued_at: new Date(now - 30 * 86400000).toISOString(), expires_at: null, stopped_at: null, stopped_reason: null, last_read_at: new Date(now - 3600000).toISOString(), grant_ids: ["practice-access"], active_grant_ids: ["practice-access"], package_ids: [] }] }];
  return { apps: groupGrantAccessByApp(data, now), approvals: [] as PendingApproval[] };
}

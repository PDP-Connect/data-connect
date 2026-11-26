// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AppAccess, PendingApproval } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
export const APP_PRACTICE_STATES = [
  "empty",
  "one",
  "five",
  "forty",
  "waiting-one",
  "waiting-three",
  "stopped-three",
  "stopped-twelve",
  "same-name",
  "thirty",
  "unnamed",
  "no-address",
  "expired",
  "ending",
  "app-one",
  "app-twelve",
  "app-end",
  "app-indefinite",
  "app-never-read",
  "app-removed",
  "app-ended",
  "app-waiting",
  "app-unverified",
  "app-remove-question",
  "app-source-question",
  "app-remove-failed",
] as const;
const names = ["ChatGPT", "Claude", "Claude Code", "Northwind Notes"];
const hosts = ["chatgpt.com", "claude.ai", "localhost", "notes.northwind.example"];
const services = [
  "gmail",
  "spotify",
  "amazon",
  "google-drive",
  "calendar",
  "notion",
  "github",
  "dropbox",
  "slack",
  "figma",
  "trello",
  "airtable",
];
export function buildAppPractice(demo: string) {
  const now = Date.now();
  const at = (days: number) => new Date(now + days * 86400000).toISOString();
  const count =
    demo === "empty"
      ? 0
      : demo === "forty"
        ? 40
        : demo === "five"
          ? 5
          : demo === "stopped-twelve"
            ? 13
            : demo === "stopped-three"
              ? 4
              : demo === "thirty"
                ? 30
                : demo === "same-name" || demo === "several"
                  ? 2
                  : 1;
  const data: AppAccess[] = Array.from({ length: count }, (_, index) => {
    const product = demo === "thirty" || demo === "same-name" ? 0 : index < 4 ? index : 3;
    const stopped =
      ["expired", "app-ended", "app-removed"].includes(demo) || (demo.startsWith("stopped-") && index > 0);
    const ended = demo === "expired" || demo === "app-ended";
    const many = demo === "app-twelve" ? 12 : demo === "thirty" ? 2 : 1;
    const suffix = index === 0 ? "" : `-${index}`;
    return {
      client_id: `practice-${index}`,
      client_name: demo === "unnamed" ? "" : names[product] || "Northwind Notes",
      return_host:
        demo === "no-address"
          ? null
          : demo === "same-name" && index
            ? "chatgpt.lookalike.example"
            : index > 3 && demo !== "thirty"
              ? `notes.team${index}.northwind.example`
              : hosts[product] || null,
      returns_to_this_computer: product === 2,
      domain_control_verified: demo !== "app-unverified" && demo !== "same-name",
      reads_last_7_days: demo === "app-never-read" ? 0 : 2,
      sources: Array.from({ length: many }, (_, sourceIndex) => {
        const service = services[sourceIndex] || "gmail";
        const id = `practice-access${suffix}${sourceIndex ? `-source-${sourceIndex}` : ""}`;
        return {
          source: {
            kind: "connector" as const,
            id: service,
            connector_id: service,
            connection_id: `practice-${service}`,
          },
          kinds: service === "gmail" ? ["messages", "threads", "labels"] : ["records"],
          in_force: !stopped,
          first_issued_at: at(-30),
          expires_at: ended ? at(-1) : demo === "ending" || demo === "app-end" ? at(3) : null,
          stopped_at: stopped ? at(-index - 1) : null,
          stopped_reason: stopped ? (ended ? ("expired" as const) : ("removed" as const)) : null,
          last_read_at: demo === "app-never-read" ? null : at(-1 / 24),
          grant_ids: [id],
          active_grant_ids: stopped ? [] : [id],
          package_ids: [],
        };
      }),
    };
  });
  const pendingCount = demo === "waiting-three" ? 3 : demo === "waiting-one" || demo === "app-waiting" ? 1 : 0;
  if (demo === "app-waiting") for (const row of data) row.sources = [];
  const approvals: PendingApproval[] = Array.from({ length: pendingCount }, (_, index) => ({
    object: "approval",
    approval_id: `practice-request-${index}`,
    batch: false,
    client_id: `practice-${index % Math.max(1, data.length)}`,
    created_at: at(-1 / 24),
    kind: "consent",
    grant_preview: {
      source: { kind: "connector", id: "spotify", connector_id: "spotify", connection_id: "practice-spotify" },
      streams: [{ name: "records" }],
    },
  }));
  const apps = groupGrantAccessByApp(data, now, approvals);
  if (demo === "app-never-read") for (const app of apps) { app.neverRead = true; for (const source of app.sourceAccess) source.neverRead = true; }
  // A pending registration has no past permission to show as stopped.
  return {
    registrations: data,
    apps: apps.filter((app) => app.state === "waiting" || app.grantIds.length > 0),
    approvals,
  };
}

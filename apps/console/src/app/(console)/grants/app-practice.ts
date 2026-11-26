// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { appPractice } from "../history/practice.ts";
import { applyAppReading } from "./app-reading.ts";
import type { AppHistory, AppReadDay } from "../lib/ref-client.ts";
import { APP_PRACTICE_SOURCES } from "../lib/app-practice-sources.ts";
import { mergeAppAccessSources } from "pdpp-reference-implementation/app-access";
import type { AppAccess, PendingApproval } from "../lib/ref-client.ts";
import { groupGrantAccessByApp } from "./app-access.ts";
import { buildAppAccessDemoData } from "./grants-demo-data.ts";
export const APP_PRACTICE_STATES = [
  "app-fifty-six",
  "forty-eight",
  "service-one",
  "service-three",
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
  "web-address",
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
  if (demo === "web-address") {
    const registrations = buildAppAccessDemoData(demo).data;
    return { registrations, apps: groupGrantAccessByApp(registrations), approvals: [] };
  }
  const now = Date.now();
  const at = (days: number) => new Date(now + days * 86_400_000).toISOString();
  const count =
    demo === "empty"
      ? 0
      : demo === "forty-eight"
        ? 48
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
      client_name:
        demo === "unnamed" ? "" : demo === "no-address" ? "Northwind Notes" : names[product] || "Northwind Notes",
      return_host:
        demo === "no-address"
          ? null
          : demo === "same-name" && index
            ? "chatgpt.lookalike.example"
            : index > 3 && demo !== "thirty"
              ? `notes.team${index}.northwind.example`
              : hosts[product] || null,
      returns_to_this_computer: product === 2,
      domain_control_verified: !["app-unverified", "same-name", "no-address"].includes(demo),
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
          first_issued_at: at(demo === "forty-eight" && index >= 14 ? -90 : -30),
          expires_at: ended ? at(-1) : demo === "ending" || demo === "app-end" ? at(3) : null,
          stopped_at: stopped ? at(-index - 1) : null,
          stopped_reason: stopped ? (ended ? ("expired" as const) : ("removed" as const)) : null,
          last_read_at:
            demo === "app-never-read" || (demo === "forty-eight" && index >= 36)
              ? null
              : stopped
                ? at(-index - 2)
                : demo === "forty-eight" && index >= 14
                  ? at(-40 - index)
                  : at(-(index + 1) / 24),
          grant_ids: [id],
          active_grant_ids: stopped ? [] : [id],
          package_ids: [],
        };
      }),
    };
  });
  if (demo === "forty-eight") {
    for (const [index, registration] of data.entries()) {
      if(index < 14) {continue;}
      registration.client_name = new Map([[14,"Codex"],[15,"Claude Code"]]).get(index) ?? `Northwind test ${index+1}`;
    }
  }
  if (["app", "mixed"].includes(demo)) { for (const app of data) {
    const template=app.sources[0]!;
    app.sources=APP_PRACTICE_SOURCES.map(source=>({...structuredClone(template),source:{kind:"connector",id:source.connector,connector_id:source.connector,connection_id:source.id}}));
  } }
  if (demo === "app-fifty-six") {
    const template = data[0]!.sources[0]!;
    const rows = Array.from({ length: 56 }, (_, index) => {
      const source = index % 45;
      const id = `practice-access${index ? `-${index}` : ""}`;
      return {
        ...template,
        source: { ...template.source, connection_id: `practice-source-${source}` },
        kinds: [index >= 45 ? "threads" : "messages"],
        grant_ids: [id],
        active_grant_ids: [id],
      };
    });
    data[0]!.sources = mergeAppAccessSources(rows);
  }
  if (demo === "service-one" || demo === "service-three") {
    const template = data[0]!.sources[0]!;
    const count = demo === "service-one" ? 1 : 3;
    const connections = Array.from({ length: count }, (_, index) => ({
      connector_id: "gmail",
      connector_instance_id: `practice-gmail-${index}`,
    }));
    const rows = [
      { ...template, source: { ...template.source, connection_id: "practice-gmail-0" } },
      {
        ...template,
        source: { ...template.source, connection_id: null },
        grant_ids: ["practice-service"],
        active_grant_ids: ["practice-service"],
        kinds: ["labels"],
      },
    ];
    data[0]!.sources = mergeAppAccessSources(rows, connections);
  }
  const pendingCount = demo === "waiting-three" ? 3 : demo === "waiting-one" || demo === "app-waiting" ? 1 : 0;
  if (demo === "app-waiting") {
    for (const row of data) {
      row.sources = [];
    }
  }
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
  const sourceNames = new Map(
    ["app-fifty-six", "service-one", "service-three"].includes(demo)
      ? data.flatMap((app) =>
          app.sources.flatMap((row) =>
            row.source.connection_id
              ? [
                  [
                    row.source.connection_id,
                    demo === "app-fifty-six"
                      ? `Practice data source ${Number(row.source.connection_id.split("-").at(-1)) + 1}`
                      : demo.startsWith("service-")
                        ? "Gmail personal"
                        : "",
                  ] as [string, string],
                ]
              : []
          )
        )
      : []
  );
  if (demo === "service-three") {
    for (let index=0;index<3;index+=1) { sourceNames.set(`practice-gmail-${index}`, `Gmail account ${index+1}`); }
    sourceNames.set("practice-other", "Spotify");
  }
  const apps = groupGrantAccessByApp(data, now, approvals, sourceNames);
  const kindNames: Record<string,string[]> = {spotify:["Your playlists","Your saved tracks"],amazon:["Your orders"],"google-drive":["Your files"],calendar:["Your events"],notion:["Your pages"],github:["Your repositories"],dropbox:["Your files"],slack:["Your messages"],figma:["Your files"],trello:["Your boards"],airtable:["Your tables"]};
  for (const app of apps) {
    for (const source of app.sourceAccess) {
      if(source.source.connector_id === "google-drive") { source.name = "Google Drive"; }
      source.kindNames = kindNames[source.source.connector_id || ""];
    }
    app.sources=app.sourceAccess.filter(row=>app.state!=="reading" || row.in_force).map(row=>row.name || "Data source");
  }
  if (demo === "app-never-read") {
    for (const app of apps) {
      app.neverRead = true;
      for (const source of app.sourceAccess) {
        source.neverRead = true;
      }
    }
  }
  const readingHistory: AppHistory = {mode:"days", data:apps.flatMap(app=>{
    const history=appPractice(!app.lastRead || demo === "app-never-read" || app.state !== "reading" ? "unread" : "app",-new Date().getTimezoneOffset(),app.lastRead ? Date.parse(app.lastRead) : now,app.sourceAccess);
    return history.mode === "days" ? history.data.map(row=>({...row,client_id:app.clientIds[0] ?? row.client_id})) : [];
  }),changes:[],identities:[],has_more:false,next_cursor:null};
  // A pending registration has no past permission to show as stopped.
  return {
    registrations: data,
    apps: apps.filter((app) => app.state === "waiting" || app.grantIds.length > 0).map(app=>applyAppReading(app,readingHistory.data as AppReadDay[])),
    readingHistory,
    approvals,
  };
}

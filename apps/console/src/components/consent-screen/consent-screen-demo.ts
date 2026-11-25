// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConsentScreenModel } from "./consent-screen-model.ts";

export type ConsentDemoState = "normal" | "verified" | "not-verified" | "many";
export type ConsentDemoPageState = ConsentDemoState | "expired" | "error";

const DEMO_STATES: readonly ConsentDemoPageState[] = ["normal", "verified", "not-verified", "many", "expired", "error"];

export function resolveConsentDemoState(value: unknown, environment: string): ConsentDemoPageState | null {
  if (environment === "production" || typeof value !== "string") return null;
  return DEMO_STATES.includes(value as ConsentDemoPageState) ? (value as ConsentDemoPageState) : null;
}

const DATA_SOURCES = [
  "Spotify",
  "Gmail",
  "Google Drive",
  "Calendar",
  "Notion",
  "GitHub",
  "Dropbox",
  "Linear",
  "Slack",
  "Figma",
  "Trello",
  "Airtable",
] as const;

function sourceModel(name: string, index: number): ConsentScreenModel["sources"][number] {
  const id = `demo:${index}`;
  return {
    account: `${name} - alex@example.com`,
    connectorId: name.toLowerCase().replaceAll(" ", "-"),
    icon: null,
    id,
    name,
    selectionValue: id,
    streams: [
      {
        fields: [
          { name: "record_id", label: "Record identifier", required: true },
          { name: "name", label: "Name", required: false },
          { name: "updated_at", label: "Last updated", required: false },
        ],
        fieldsTotal: 3,
        id: `${id}:records`,
        label: "Records",
        name: "records",
        selectionValue: `${id}:records`,
        selected: false,
        sentence: `Records saved in ${name}.`,
        timePhrase: "Last updated",
      },
      {
        fields: [],
        fieldsTotal: 0,
        id: `${id}:activity`,
        label: "Recent activity",
        name: "activity",
        selectionValue: `${id}:activity`,
        selected: false,
        sentence: `Recent activity from ${name}.`,
      },
    ],
  };
}

export function buildConsentDemoModel(state: ConsentDemoState): ConsentScreenModel {
  const many = state === "many";
  const clientDomain = "assistant.example";
  return {
    accessMode: { supported: ["offline"], value: "offline" },
    challenge: "demo-only",
    client: {
      domain: clientDomain,
      id: "demo-app",
      logo: null,
      monogram: "A",
      name: "Personal Assistant",
      policyLinks: [
        { href: "https://assistant.example/privacy", label: "Privacy policy" },
        { href: "https://assistant.example/terms", label: "Terms of service" },
      ],
      returnTo: "chatgpt.com",
      trust: state === "verified" ? "verified" : state === "not-verified" || many ? "unverified" : "domain",
    },
    grantExpiry: {
      defaultId: "90d",
      options: [
        { days: 90, id: "90d", label: "90 days" },
        { days: 365, id: "1y", label: "1 year" },
        { days: null, id: "never", label: "No end date" },
      ],
    },
    purpose: { code: "personal-assistant", description: "Read your records to answer questions you ask." },
    retention: "This app keeps the data it reads only as long as needed to answer you.",
    reviewDigest: "demo-only",
    sources: (many ? DATA_SOURCES : DATA_SOURCES.slice(0, 2)).map(sourceModel),
  };
}

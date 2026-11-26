// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConsentScreenModel } from "./consent-screen-model.ts";

export type ConsentDemoState = "normal" | "verified" | "not-verified" | "many" | "one" | "some" | "empty" | "kinds-open";
export type ConsentDemoPageState = ConsentDemoState | "expired" | "error" | "answered" | "allowed" | "denied";

const DEMO_STATES: readonly ConsentDemoPageState[] = ["normal", "verified", "not-verified", "many", "one", "some", "empty", "kinds-open", "expired", "error", "answered", "allowed", "denied"];

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

const DEMO_KINDS:Record<string,readonly [string,string,string,string]> = {
  Spotify:["tracks","Your saved tracks","playlists","Your playlists"],
  Gmail:["messages","Your emails","attachments","Your attachments"],
  "Google Drive":["files","Your files","comments","Your comments"],
  Calendar:["events","Your calendar entries","calendars","Your calendars"],
  Notion:["pages","Your pages","databases","Your databases"],
  GitHub:["repositories","Your repositories","issues","Your issues"],
  Dropbox:["files","Your files","folders","Your folders"],
  Linear:["issues","Your issues","projects","Your projects"],
  Slack:["messages","Your messages","channels","Your channels"],
  Figma:["files","Your files","comments","Your comments"],
  Trello:["boards","Your boards","cards","Your cards"],
  Airtable:["bases","Your bases","records","Your records"],
};
function sourceModel(name: string, index: number): ConsentScreenModel["sources"][number] {
  const [firstKind,firstLabel,secondKind,secondLabel]=DEMO_KINDS[name] ?? ["files","Your files","folders","Your folders"];
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
        id: `${id}:${firstKind}`,
        label: firstLabel,
        name: firstKind,
        selectionValue: `${id}:${firstKind}`,
        selected: false,
        sentence: `${firstLabel} from ${name}.`,
        timePhrase: "Last updated",
      },
      {
        fields: [],
        fieldsTotal: 0,
        id: `${id}:${secondKind}`,
        label: secondLabel,
        name: secondKind,
        selectionValue: `${id}:${secondKind}`,
        selected: false,
        sentence: `${secondLabel} from ${name}.`,
      },
    ],
  };
}

export function buildConsentDemoModel(state: ConsentDemoState): ConsentScreenModel {
  const many = state === "many";
  const clientDomain = "chatgpt.com";
  return {
    accessMode: { supported: ["offline"], value: "offline" },
    challenge: "demo-only",
    client: {
      domain: clientDomain,
      id: "demo-app",
      logo: null,
      monogram: "C",
      name: "ChatGPT",
      policyLinks: [
        { href: "https://assistant.example/privacy", label: "Privacy policy" },
        { href: "https://assistant.example/terms", label: "Terms of service" },
      ],
      returnTo: "chatgpt.com",
      trust: state === "verified" ? "domain" : state === "not-verified" || many ? "unverified" : "domain",
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
    sources: (state === "empty" ? [] : many ? DATA_SOURCES : DATA_SOURCES.slice(0, state === "one" ? 1 : 2)).map(sourceModel).map((source, index) => state === "some" && index === 0 ? { ...source, streams: source.streams.map((stream) => ({ ...stream, selected: true })) } : source),
  };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorIcon } from "./connector-icon.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const MONOGRAM_CLASS = /class="pdpp-monogram pdpp-monogram--tinted"/;
const ARIA_HIDDEN_TRUE = /aria-hidden="true"/;
const SPOTIFY_INITIALS_DATA = /data-initials="SP"/;
const HUE_VAR_RE = /--pdpp-monogram-hue:\s*(-?\d+)/;
const ICON_CLASS = /class="pdpp-connector-icon"/;
const SPOTIFY_LIGHT_ICON = "https://cdn.example.test/spotify.svg";
const GITHUB_LIGHT_ICON = "https://cdn.example.test/github.svg";
const GITHUB_DARK_ICON = "https://cdn.example.test/github-dark.svg";
const APPLE_CONTACTS_ICON = "https://cdn.example.test/apple-contacts.svg";

const connectorIndex = {
  brandIcons: {
    github: { darkUrl: GITHUB_DARK_ICON, url: GITHUB_LIGHT_ICON },
    "https://registry.pdpp.dev/connectors/apple_contacts": { url: APPLE_CONTACTS_ICON },
    spotify: { backgroundColor: "#1ED760", url: SPOTIFY_LIGHT_ICON },
  },
};

test("ConnectorIcon with no icon renders the deterministic monogram fallback", () => {
  const html = renderToStaticMarkup(createElement(ConnectorIcon, { connectorId: "spotify", name: "Spotify" }));
  assert.match(html, MONOGRAM_CLASS);
  assert.match(html, ARIA_HIDDEN_TRUE);
  assert.match(html, SPOTIFY_INITIALS_DATA);
});

test("ConnectorIcon fallback is deterministic across renders for the same name", () => {
  const props = { connectorId: "notion", name: "Notion" };
  const first = renderToStaticMarkup(createElement(ConnectorIcon, props));
  const second = renderToStaticMarkup(createElement(ConnectorIcon, props));
  assert.equal(first, second);
});

test("ConnectorIcon fallback derives distinct hues for distinct names", () => {
  const a = renderToStaticMarkup(createElement(ConnectorIcon, { connectorId: "github", name: "GitHub" }));
  const b = renderToStaticMarkup(createElement(ConnectorIcon, { connectorId: "reddit", name: "Reddit" }));
  const hueOf = (html: string) => html.match(HUE_VAR_RE)?.[1];
  assert.notEqual(hueOf(a), hueOf(b));
});

test("ConnectorIcon renders a brand.icon URL declared in the connector index", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { connectorId: "spotify", connectorIndex, name: "Spotify" })
  );
  assert.match(html, ICON_CLASS);
  assert.doesNotMatch(html, MONOGRAM_CLASS);
  assert.match(html, new RegExp(`src="${SPOTIFY_LIGHT_ICON}"`));
  assert.match(html, /background-color:#1ED760/);
});

test("ConnectorIcon falls back to the monogram when connector index has no brand icon", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { connectorId: "slack", connectorIndex, name: "Slack" })
  );
  assert.match(html, MONOGRAM_CLASS);
});

test("ConnectorIcon resolves an underscore connector key against its manifest identity", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { connectorId: "apple_contacts", connectorIndex, name: "Apple Contacts" })
  );
  assert.match(html, new RegExp(`src="${APPLE_CONTACTS_ICON}"`));
});

test("ConnectorIcon falls back to the monogram when brand icon has no light URL", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, {
      connectorId: "slack",
      connectorIndex: { brandIcons: { slack: { darkUrl: "https://cdn.example.test/slack-dark.svg" } } },
      name: "Slack",
    })
  );
  assert.match(html, MONOGRAM_CLASS);
});

test("ConnectorIcon renders a brand.dark_icon URL when the active theme is dark", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html data-theme=dark><body></body></html>");
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const html = renderToStaticMarkup(
      createElement(ConnectorIcon, { connectorId: "github", connectorIndex, name: "GitHub" })
    );
    assert.match(html, new RegExp(`src="${GITHUB_DARK_ICON}"`));
  } finally {
    globalThis.document = previousDocument;
    dom.window.close();
  }
});

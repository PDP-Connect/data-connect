// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/consent?challenge=example",
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "self",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: name === "window" || name === "self" ? dom.window : dom.window[name],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
const React = await import("react");
globalThis.React = React;
const { act, createElement } = React;
const { render, fireEvent, within, cleanup } = await import("@testing-library/react");
const { ConsentScreen, ConsentUnavailable } = await import("./consent-screen-client.tsx");
const { buildConsentDemoModel, resolveConsentDemoState } = await import("./consent-screen-demo.ts");
const { buildHostedMcpConsentChallengeModel } = await import(
  "../../../../../reference-implementation/server/routes/as-consent-ui-helpers.ts"
);
const { resolveStreamScopeSelection } = await import(
  "../../../../../reference-implementation/server/hosted-mcp-stream-scope.ts"
);
const { readShippedManifests } = await import(
  "../../../../../reference-implementation/test/helpers/shipped-manifests.ts"
);
const manifest = readShippedManifests().find((entry) => entry.file === "spotify.json").manifest;
const model = await buildHostedMcpConsentChallengeModel(
  "challenge",
  "owner",
  {
    canonicalConnectorKey: () => "spotify",
    encodeHostedMcpSelection: () => "source",
    encodeHostedMcpStreamSelection: ({ streamName }) => streamName,
    getConnectorManifest: async () => manifest,
    hostedMcpSourceKey: () => "spotify:account",
    isInternalConnectorId: () => false,
    listActiveBindingsForGrant: async () => [{ connectorInstanceId: "account" }],
    listRegisteredConnectorIds: async () => [manifest.connector_id],
    listStreamsWithRecords: async () => [],
    projectBindingForWire: () => ({ display_name: "Spotify - owner", connection_id: "account" }),
  },
  {},
  null,
);

afterEach(cleanup);
after(() => dom.window.close());

function assertPlainCopy(root) {
  const copy = [root.textContent ?? ""];
  for (const element of root.querySelectorAll("[aria-label], [placeholder], [title]")) {
    copy.push(element.getAttribute("aria-label") ?? "");
    copy.push(element.getAttribute("placeholder") ?? "");
    copy.push(element.getAttribute("title") ?? "");
  }
  const renderedCopy = copy.join(" ");
  assert.doesNotMatch(renderedCopy, /\b(?:grant|client|scope|stream|token|oauth|pkce|challenge)\b/i);
  assert.doesNotMatch(renderedCopy, /\b[a-z]+_[a-z]+\b/i, "raw field names must stay off the screen");
  // Lead review: the product is DataConnect; no protocol name on this screen.
  assert.doesNotMatch(renderedCopy, /\bPDPP\b/i);
}

test("verified state uses one trust line and plain consumer actions", () => {
  const verifiedModel = structuredClone(model);
  verifiedModel.client.trust = "verified";
  verifiedModel.client.domain = "spotify.example";
  const view = render(createElement(ConsentScreen, { acceptAction: async () => "", model: verifiedModel, rejectAction: async () => "" }));
  assert.ok(view.getByRole("heading", { name: `${verifiedModel.client.name} wants to read your data` }));
  assert.ok(view.getByText("Anything you leave unchecked stays private."));
  assert.ok(view.getByText("Verified"));
  assert.ok(view.getByText("spotify.example ·"));
  assert.ok(view.getByRole("button", { name: "What does this mean?" }));
  assert.ok(view.getByRole("button", { name: "Allow" }));
  assert.ok(view.getByRole("button", { name: "Don't allow" }));
  assertPlainCopy(view.container);
});

test("not verified state names the website without a trust chip", () => {
  const unverifiedModel = structuredClone(model);
  unverifiedModel.client.trust = "unverified";
  unverifiedModel.client.domain = "spotify.example";
  const view = render(createElement(ConsentScreen, { acceptAction: async () => "", model: unverifiedModel, rejectAction: async () => "" }));
  assert.ok(view.getByText("spotify.example (not verified)"));
  assertPlainCopy(view.container);
});

test("many-source state keeps search and filters the source rows", () => {
  const template = model.sources[0];
  const manyModel = structuredClone(model);
  manyModel.sources = Array.from({ length: 12 }, (_, index) => ({
    ...template,
    id: `spotify:account-${index + 1}`,
    name: `Source ${index + 1}`,
    account: `Source ${index + 1} - person${index + 1}@example.com`,
    streams: template.streams.map((stream) => ({
      ...stream,
      id: `spotify:account-${index + 1}:${stream.name}`,
      selected: false,
    })),
  }));
  const view = render(createElement(ConsentScreen, { acceptAction: async () => "", model: manyModel, rejectAction: async () => "" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Source 1" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Source 2" }));
  // Consent brief: the count names every selected data source before the decisions.
  assert.ok(view.getByText("It will read 8 kinds of records from Source 1 and Source 2."));
  const search = view.getByRole("searchbox", { name: "Search data sources" });
  fireEvent.change(search, { target: { value: "Source 12" } });
  assert.ok(view.getByText("1 of 12 data sources match"));
  assert.ok(view.getByRole("checkbox", { name: "Share data from Source 12" }));
  assertPlainCopy(view.container);
});

test("the demo model provides stable normal, trust, and many-source render states", () => {
  const normal = buildConsentDemoModel("normal");
  const verified = buildConsentDemoModel("verified");
  const unverified = buildConsentDemoModel("not-verified");
  const many = buildConsentDemoModel("many");
  assert.equal(normal.client.trust, "domain");
  assert.equal(verified.client.trust, "verified");
  assert.equal(unverified.client.trust, "unverified");
  assert.equal(many.sources.length, 12);
  for (const demoModel of [normal, verified, unverified, many]) {
    const view = render(createElement(ConsentScreen, {
      acceptAction: async () => "",
      demoOnly: true,
      model: demoModel,
      rejectAction: async () => "",
    }));
    assertPlainCopy(view.container);
  }
});

test("production ignores every consent demo query", () => {
  assert.equal(resolveConsentDemoState("many", "production"), null);
  assert.equal(resolveConsentDemoState("expired", "production"), null);
  assert.equal(resolveConsentDemoState("many", "development"), "many");
  assert.equal(resolveConsentDemoState("unknown", "development"), null);
});

test("demo decisions never call a server action", () => {
  let accepted = false;
  let rejected = false;
  const view = render(createElement(ConsentScreen, {
    acceptAction: async () => { accepted = true; return ""; },
    demoOnly: true,
    model: buildConsentDemoModel("normal"),
    rejectAction: async () => { rejected = true; return ""; },
  }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Spotify" }));
  fireEvent.click(view.getByRole("button", { name: "Allow" }));
  fireEvent.click(view.getByRole("button", { name: "Don't allow" }));
  assert.equal(accepted, false);
  assert.equal(rejected, false);
});

test("expired state gives one plain next step", () => {
  const view = render(createElement(ConsentUnavailable, { kind: "expired" }));
  assert.ok(view.getByRole("heading", { name: "This request is no longer available. Go back to ChatGPT and try again." }));
  assertPlainCopy(view.container);
});

test("load-error state offers a retry and plain next step", () => {
  let retried = false;
  const view = render(createElement(ConsentUnavailable, { kind: "error", onRetry: () => { retried = true; } }));
  assert.ok(view.getByRole("heading", { name: "This request could not be loaded. Go back to ChatGPT and try again." }));
  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  assert.equal(retried, true);
  assertPlainCopy(view.container);
});

test("normal state renders Spotify's declared record label and description", async () => {
  const { view } = await journey();
  assert.ok(view.getByRole("checkbox", { name: "Share Your playlists from Spotify" }));
  const playlists = manifest.streams.find((stream) => stream.name === "playlists");
  assert.ok(view.getByText(playlists.display.detail));
  // Consent brief: show the selected record count before the two decisions.
  assert.ok(view.getByText("It will read 4 kinds of records from Spotify."));
  assertPlainCopy(view.container);
});

test("the screen marks itself hydrated only once effects run", async () => {
  const { renderToString } = await import("react-dom/server");
  const props = { acceptAction: async () => "", model, rejectAction: async () => "" };
  assert.match(renderToString(createElement(ConsentScreen, props)), /data-hydrated="false"/);
  const view = render(createElement(ConsentScreen, props));
  assert.equal(view.container.querySelector("[data-hydrated]")?.getAttribute("data-hydrated"), "true");
});

test("field titles label controls without exposing raw names", async () => {
  const titledModel = structuredClone(model);
  titledModel.sources[0].streams[0].fields = [
    { name: "owner_id", label: "Playlist owner", description: "Who owns this playlist.", required: false },
    { name: "snapshot_id", required: false },
  ];
  const props = {
    connectorIndex: {},
    model: titledModel,
    acceptAction: async () => "",
    rejectAction: async () => "",
  };
  const view = render(createElement(ConsentScreen, props));
  const source = view.getByRole("checkbox", { name: "Share data from Spotify" });
  fireEvent.click(source);
  await act(async () => {
    source.closest("details").open = true;
    fireEvent(source.closest("details"), new dom.window.Event("toggle"));
  });
  const stream = titledModel.sources[0].streams[0];
  const panel = view
    .getByRole("checkbox", { name: `Share ${stream.label} from Spotify` })
    .parentElement.querySelector("details");
  await act(async () => {
    panel.open = true;
  });
  assert.ok(within(panel).getByRole("checkbox", { name: /Playlist owner/ }));
  assert.ok(within(panel).getByText("Playlist owner"));
  assert.equal(within(panel).queryByText("owner_id"), null);
  assert.equal(within(panel).getAllByText("Who owns this playlist.").length, 1);
  assert.ok(within(panel).getByRole("checkbox", { name: "Snapshot Identifier" }));
});

async function journey() {
  let decision;
  const props = {
    connectorIndex: {},
    model,
    acceptAction: async (value) => {
      decision = value;
      // Capture at the action boundary without navigating JSDOM away.
      throw new Error("Decision captured");
    },
    rejectAction: async () => "",
  };
  const view = render(createElement(ConsentScreen, props));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Spotify" }));
  const sourceDetails = view.getByRole("checkbox", { name: "Share data from Spotify" }).closest("details");
  await act(async () => {
    sourceDetails.open = true;
    fireEvent(sourceDetails, new dom.window.Event("toggle"));
  });
  const saved = model.sources[0].streams.find((stream) => stream.name === "saved_tracks");
  const panel = view
    .getByRole("checkbox", { name: `Share ${saved.label} from Spotify` })
    .parentElement.querySelector("details");
  await act(async () => {
    panel.open = true;
  });
  return {
    view,
    panel,
    updateModel(nextModel) {
      view.rerender(createElement(ConsentScreen, { ...props, model: nextModel }));
    },
    async submit() {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Allow" }));
      });
      assert.ok(decision);
      return decision;
    },
  };
}

test("bulk dates apply only to selected time-capable streams and resolve against the real declaration", async () => {
  const { view, panel, submit } = await journey();
  fireEvent.change(within(panel).getByLabelText("added since"), { target: { value: "2026-03-01" } });
  fireEvent.change(within(panel).getByLabelText("added until"), { target: { value: "2026-03-31" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Apply to all selected kinds of records" }));
  const decision = await submit();
  assert.deepEqual(decision.streamRanges["spotify:account:saved_tracks"], { since: "2026-03-01", until: "2026-03-31" });
  for (const stream of model.sources[0].streams) {
    assert.deepEqual(
      decision.streamRanges[stream.id],
      stream.timePhrase ? { since: "2026-03-01", until: "2026-03-31" } : undefined,
    );
    const declaration = manifest.streams.find((candidate) => candidate.name === stream.name);
    const result = resolveStreamScopeSelection(declaration, decision.streamRanges[stream.id] ?? {});
    assert.equal(result.error, undefined, JSON.stringify(result.error));
  }
  assert.ok(view.getByRole("alert"));
});

test("until-only dates are summarized and preserved in the submitted decision", async () => {
  const { panel, submit } = await journey();
  fireEvent.change(within(panel).getByLabelText("added until"), { target: { value: "2026-03-31" } });
  assert.ok(within(panel).getByText("Data through Mar 31, 2026"));
  assert.equal(within(panel).queryByText("All dates"), null);
  const range = (await submit()).streamRanges["spotify:account:saved_tracks"];
  assert.deepEqual(range, { until: "2026-03-31" });
  const declaration = manifest.streams.find((stream) => stream.name === "saved_tracks");
  assert.deepEqual(resolveStreamScopeSelection(declaration, range).selection.timeRange, {
    until: "2026-04-01T00:00:00.000Z",
  });
});

test("serialization drops a stale date when the current model no longer declares a time capability", async () => {
  const { panel, updateModel, submit } = await journey();
  fireEvent.change(within(panel).getByLabelText("added until"), { target: { value: "2026-03-31" } });
  updateModel({
    ...model,
    sources: model.sources.map((source) => ({
      ...source,
      streams: source.streams.map((stream) => ({ ...stream, timePhrase: undefined })),
    })),
  });
  assert.deepEqual((await submit()).streamRanges, {});
});

test("cleared dates and dates on deselected streams are omitted", async () => {
  const { view, panel, submit } = await journey();
  fireEvent.change(within(panel).getByLabelText("added until"), { target: { value: "2026-03-31" } });
  fireEvent.change(within(panel).getByLabelText("added until"), { target: { value: "" } });
  assert.deepEqual((await submit()).streamRanges, {});
  fireEvent.change(within(panel).getByLabelText("added until"), { target: { value: "2026-03-31" } });
  const saved = model.sources[0].streams.find((stream) => stream.name === "saved_tracks");
  fireEvent.click(view.getByRole("checkbox", { name: `Share ${saved.label} from Spotify` }));
  assert.deepEqual((await submit()).streamRanges, {});
});

test("connector marks use resolved connector identity without changing consent selection", async () => {
  const source = model.sources[0];
  assert.equal(source.connectorId, manifest.connector_id);
  assert.equal(source.id, "spotify:account");
  assert.equal(source.selectionValue, "source");
  const view = render(createElement(ConsentScreen, {
    connectorIndex: {}, model, acceptAction: async () => "", rejectAction: async () => "",
  }));
  assert.ok(view.container.querySelector(".pdpp-connector-icon svg"), "the connector mark should not depend on an optional manifest icon");
});

test("older consent models without connector provenance keep the genuine fallback", () => {
  const legacy = structuredClone(model);
  for (const source of legacy.sources) {
    delete source.connectorId;
    source.icon = null;
  }
  const view = render(createElement(ConsentScreen, {
    connectorIndex: {}, model: legacy, acceptAction: async () => "", rejectAction: async () => "",
  }));
  assert.ok(view.container.querySelector(".pdpp-connector-icon .pdpp-monogram"));
  assert.equal(view.container.querySelector(".pdpp-connector-icon svg"), null, "do not infer a brand from a source ID or account name");
});

const whiteGlyph = '<svg viewBox="0 0 24 24"><path fill="#ffffff" d="M3 3h18v18H3z"/></svg>';

function buildModelFor(connectorManifest) {
  return buildHostedMcpConsentChallengeModel(
    "challenge",
    "owner",
    {
      canonicalConnectorKey: () => "spotify",
      encodeHostedMcpSelection: () => "source",
      encodeHostedMcpStreamSelection: ({ streamName }) => streamName,
      getConnectorManifest: async () => connectorManifest,
      hostedMcpSourceKey: () => "spotify:account",
      isInternalConnectorId: () => false,
      listActiveBindingsForGrant: async () => [{ connectorInstanceId: "account" }],
      listRegisteredConnectorIds: async () => [manifest.connector_id],
      listStreamsWithRecords: async () => [],
      projectBindingForWire: () => ({ display_name: "Spotify - owner", connection_id: "account" }),
    },
    {},
    null,
  );
}

function renderModel(consentModel) {
  return render(createElement(ConsentScreen, {
    model: consentModel, acceptAction: async () => "", rejectAction: async () => "",
  }));
}

test("a white-glyph connector mark keeps its declared brand background on the consent screen", async () => {
  const whiteGlyphModel = await buildModelFor({
    ...manifest,
    brand: { background_color: "#1DB954" },
    icon: { kind: "inline_svg", svg: whiteGlyph },
  });
  const tile = renderModel(whiteGlyphModel).container.querySelector(".pdpp-connector-icon");
  assert.ok(tile?.querySelector("svg path"), "the manifest's glyph renders, not a fallback mark");
  assert.equal(
    dom.window.getComputedStyle(tile).backgroundColor,
    "rgb(29, 185, 84)",
    "a white glyph needs the connector's declared brand background to be visible",
  );
});

// brand.background_color is not covered by validateManifestIcon, so the consent
// model must reject anything that is not a hex color before it reaches the tile.
for (const [label, value] of [
  ["a CSS keyword that paints nothing", "transparent"],
  ["a color the glyph cannot contrast against", "white"],
  ["a CSS function", "rgb(0 0 0 / 0)"],
  ["a declaration break-out", "#fff; background-image: url(//x/y)"],
  ["a number", 0xffffff],
  ["an empty string", ""],
]) {
  test(`an invalid brand background (${label}) falls back to the default tile`, async () => {
    const invalidModel = await buildModelFor({
      ...manifest,
      brand: { background_color: value },
      icon: { kind: "inline_svg", svg: whiteGlyph },
    });
    assert.equal(invalidModel.sources[0].icon.backgroundColor, null);
    const tile = renderModel(invalidModel).container.querySelector(".pdpp-connector-icon");
    assert.ok(tile?.querySelector("svg path"), "the glyph still renders");
    assert.equal(tile.style.backgroundColor, "", "no inline background: the default tile shows");
  });
}

test("a short hex brand background is accepted", async () => {
  const shortHexModel = await buildModelFor({
    ...manifest,
    brand: { background_color: "#1db" },
    icon: { kind: "inline_svg", svg: whiteGlyph },
  });
  assert.equal(shortHexModel.sources[0].icon.backgroundColor, "#1db");
});

test("a brand background without a manifest glyph is not applied to the resolved identity mark", async () => {
  const noGlyphModel = await buildModelFor({ ...manifest, brand: { background_color: "#1DB954" }, icon: undefined });
  assert.equal(noGlyphModel.sources[0].icon, null, "the background only travels with a manifest glyph");
  const tile = renderModel(noGlyphModel).container.querySelector(".pdpp-connector-icon");
  assert.ok(tile?.querySelector("svg"), "the resolved identity mark still renders");
  assert.notEqual(tile.style.backgroundColor, "rgb(29, 185, 84)", "the mark keeps its own background, not the manifest's");
});

test("the screen signs as DataConnect and shows the end date as plain text with Change", () => {
  // Lead review of the consent pictures: DataConnect mark instead of "Secured by
  // PDPP"; the access end date reads as second text, its controls behind "Change".
  const view = render(createElement(ConsentScreen, { acceptAction: async () => "", model, rejectAction: async () => "" }));
  assert.ok(view.getByText("DataConnect"));
  assert.ok(view.container.querySelector('img[src="/icon"]'));
  assert.equal(view.container.querySelector('a[href="https://pdpp.dev"]'), null);
  const summary = view.container.querySelector("aside summary");
  assert.match(summary?.textContent ?? "", /^(Access ends .+|No end date) Change$/);
  assertPlainCopy(view.container);
});

test("a failed decision names the requesting app, not a fixed one", async () => {
  const view = render(createElement(ConsentScreen, {
    acceptAction: async () => { throw new Error("raw server text"); },
    model,
    rejectAction: async () => { throw new Error("raw server text"); },
  }));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Don't allow" }));
  });
  const alert = view.getByRole("alert");
  assert.equal(alert.textContent, `This request could not be completed. Go back to ${model.client.name} and try again.`);
  assertPlainCopy(view.container);
});

test("no connected data sources says to connect one, then return to the app", () => {
  const empty = structuredClone(model);
  empty.sources = [];
  const view = render(createElement(ConsentScreen, { acceptAction: async () => "", model: empty, rejectAction: async () => "" }));
  assert.ok(view.getByText(`No data sources are connected yet. Connect one, then go back to ${model.client.name} and try again.`));
  assert.equal(view.getByRole("button", { name: "Allow" }).disabled, true);
});

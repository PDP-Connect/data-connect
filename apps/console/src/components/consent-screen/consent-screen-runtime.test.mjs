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

function assertPlainCopy(original) {
  const root = original.cloneNode(true);
  for (const details of root.querySelectorAll("details")) if (details.querySelector("summary")?.textContent === "Technical details") details.remove();
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
  verifiedModel.client.trust = "domain";
  verifiedModel.client.domain = "spotify.example";
  const view = render(createElement(ConsentScreen, { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model: verifiedModel, rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.ok(view.getByRole("heading", { name: `${verifiedModel.client.name} wants to read your data` }));
  assert.ok(view.getByText("Anything you leave unticked stays private."));
  assert.ok(view.getByText("Verified"));
  assert.ok(view.getByText("Verified"));
  assert.equal(view.queryByRole("button", { name: "What does this mean?" }), null);
  assert.ok(view.getByRole("button", { name: "Allow" }));
  assert.ok(view.getByRole("button", { name: "Don't allow" }));
  assertPlainCopy(view.container);
});

test("not verified state names the website without a trust chip", () => {
  const unverifiedModel = structuredClone(model);
  unverifiedModel.client.trust = "unverified";
  unverifiedModel.client.domain = "spotify.example";
  const view = render(createElement(ConsentScreen, { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model: unverifiedModel, rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.ok(view.getByText("not verified"));
  assertPlainCopy(view.container);
});

test("domain proof does not say the website is unverified", () => {
  const domainModel = structuredClone(model);
  domainModel.client.trust = "domain";
  domainModel.client.domain = "spotify.example";
  const view = render(createElement(ConsentScreen, { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model: domainModel, rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.match(view.container.textContent ?? "", /spotify\.example/);
  assert.doesNotMatch(view.container.textContent ?? "", /not verified/i);
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
  const view = render(createElement(ConsentScreen, { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model: manyModel, rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Source 1" }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Source 2" }));
  // Consent brief: the count names every selected data source before the decisions.
  assert.match(view.container.querySelector("aside").textContent, /will be able to read 2 data sources/);
  const search = view.getByRole("searchbox", { name: "Find a data source" });
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
  assert.equal(verified.client.trust, "domain");
  assert.equal(unverified.client.trust, "unverified");
  assert.equal(many.sources.length, 12);
  for (const demoModel of [normal, verified, unverified, many]) {
    const view = render(createElement(ConsentScreen, {
      acceptAction: async () => ({ ok: true, redirectUrl: "" }),
      demoOnly: true,
      model: demoModel,
      rejectAction: async () => ({ ok: true, redirectUrl: "" }),
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
    acceptAction: async () => { accepted = true; return { ok: true, redirectUrl: "" }; },
    demoOnly: true,
    model: buildConsentDemoModel("normal"),
    rejectAction: async () => { rejected = true; return { ok: true, redirectUrl: "" }; },
  }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Spotify" }));
  fireEvent.click(view.getByRole("button", { name: "Allow" }));
  fireEvent.click(view.getByRole("button", { name: "Don't allow" }));
  assert.equal(accepted, false);
  assert.equal(rejected, false);
});

test("expired state gives one plain next step", () => {
  const view = render(createElement(ConsentUnavailable, { kind: "expired" }));
  assert.ok(view.getByRole("heading", { name: "This request has run out." }));
  assert.doesNotMatch(view.container.textContent ?? "", /ChatGPT/);
  assertPlainCopy(view.container);
});

test("load-error state offers a retry and plain next step", () => {
  let retried = false;
  const view = render(createElement(ConsentUnavailable, { kind: "error", onRetry: () => { retried = true; } }));
  assert.ok(view.getByRole("heading", { name: "This request couldn’t be loaded." }));
  assert.doesNotMatch(view.container.textContent ?? "", /ChatGPT/);
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
  assert.match(view.container.querySelector("aside").textContent, /will be able to read 1 data source/);
  assertPlainCopy(view.container);
});

test("the screen marks itself hydrated only once effects run", async () => {
  const { renderToString } = await import("react-dom/server");
  const props = { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model, rejectAction: async () => ({ ok: true, redirectUrl: "" }) };
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
    acceptAction: async () => ({ ok: true, redirectUrl: "" }),
    rejectAction: async () => ({ ok: true, redirectUrl: "" }),
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
    .parentElement;
  await act(async () => {
    fireEvent.click(within(panel).getByRole("button", { name: "Limit what it sees" }));
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
    rejectAction: async () => ({ ok: true, redirectUrl: "" }),
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
    .parentElement;
  await act(async () => {
    fireEvent.click(within(panel).getByRole("button", { name: "Limit what it sees" }));
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
    connectorIndex: {}, model, acceptAction: async () => ({ ok: true, redirectUrl: "" }), rejectAction: async () => ({ ok: true, redirectUrl: "" }),
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
    connectorIndex: {}, model: legacy, acceptAction: async () => ({ ok: true, redirectUrl: "" }), rejectAction: async () => ({ ok: true, redirectUrl: "" }),
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
    model: consentModel, acceptAction: async () => ({ ok: true, redirectUrl: "" }), rejectAction: async () => ({ ok: true, redirectUrl: "" }),
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
    // Add-page decision 5: a single-colour glyph with no valid brand tile is
    // drawn as a text-colour mask (a white glyph would vanish on the light
    // theme), so the glyph renders as the mask image, not as an inline <svg>.
    const tileStyle = tile?.getAttribute("style") ?? "";
    assert.ok(tile?.classList.contains("bg-foreground"), "the glyph is filled with the text colour");
    assert.ok(
      tileStyle.includes(encodeURIComponent('d="M3 3h18v18H3z"')),
      "the glyph still renders, as the manifest's own glyph",
    );
    assert.equal(tile.style.backgroundColor, "", "no inline background: the invalid brand colour is not applied");
    assert.doesNotMatch(tileStyle, /\/\/x\/y|background-image/, "nothing from the rejected value reaches the tile");
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
  const view = render(createElement(ConsentScreen, { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model, rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.ok(view.getByText("DataConnect"));
  assert.ok(view.container.querySelector('img[src="/icon"]'));
  assert.equal(view.container.querySelector('a[href="https://pdpp.dev"]'), null);
  assert.ok(view.getByRole("heading", { name: "How long" }));
  assert.ok(view.getByRole("button", { name: "Until I remove it" }));
  assertPlainCopy(view.container);
});

for (const button of ["Allow", "Don't allow"]) test(`a successful ${button} follows its own returned redirect`, async () => {
  const originalWindow = globalThis.window;
  let destination = null;
  globalThis.window = new Proxy(originalWindow, {
    get(target, property) {
      if (property === "location") return { replace: (url) => { destination = url; } };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const view = render(createElement(ConsentScreen, {
      acceptAction: async () => ({ ok: true, redirectUrl: "https://app.example/return?code=allowed" }),
      model,
      rejectAction: async () => ({ ok: true, redirectUrl: "https://app.example/return?error=access_denied" }),
    }));
    fireEvent.click(view.getByRole("checkbox", { name: "Share data from Spotify" }));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: button }));
    });
    assert.equal(
      destination,
      button === "Allow" ? "https://app.example/return?code=allowed" : "https://app.example/return?error=access_denied",
    );
  } finally {
    cleanup();
    globalThis.window = originalWindow;
  }
});

test("a failed decision gives a plain next step and leaves both decisions usable", async () => {
  let accepted = 0;
  let rejected = 0;
  const failure = { ok: false, message: "Choose an end date in the future." };
  const view = render(createElement(ConsentScreen, {
    acceptAction: async () => { accepted++; return failure; },
    model,
    rejectAction: async () => { rejected++; return failure; },
  }));
  fireEvent.click(view.getByRole("checkbox", { name: "Share data from Spotify" }));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Allow" }));
  });
  assert.match(view.getByRole("alert").textContent, /Go back to .* and try again/);
  assert.equal(view.getByRole("button", { name: "Allow" }).disabled, false);
  assert.equal(view.getByRole("button", { name: "Don't allow" }).disabled, false);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Don't allow" }));
  });
  assert.match(view.getByRole("alert").textContent, /Go back to .* and try again/);
  assert.deepEqual({ accepted, rejected }, { accepted: 1, rejected: 1 });
  assertPlainCopy(view.container);
});

test("no connected data sources says to connect one, then return to the app", () => {
  const empty = structuredClone(model);
  empty.sources = [];
  const view = render(createElement(ConsentScreen, { acceptAction: async () => ({ ok: true, redirectUrl: "" }), model: empty, rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.ok(view.getByText(/You have no data sources yet/));
  assert.equal(view.queryByRole("button", { name: "Allow" }), null);
});

test("Everything below posts the same decision as ticking each data source", async () => {
  async function decide(bulk) {
    let posted;
    const view = render(createElement(ConsentScreen, { model: buildConsentDemoModel("normal"), acceptAction: async (decision) => { posted = decision; return { ok: false, message: "Saved for comparison" }; }, rejectAction: async () => ({ ok: false, message: "unused" }) }));
    if (bulk) fireEvent.click(view.getByRole("checkbox", { name: "Everything below" }));
    else for (const name of ["Spotify", "Gmail"]) fireEvent.click(view.getByRole("checkbox", { name: `Share data from ${name}` }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: "Allow" })));
    cleanup(); return posted;
  }
  assert.deepEqual(await decide(true), await decide(false));
});

test("operator registration alone cannot borrow the domain-control mark", () => {
  const registered = buildConsentDemoModel("normal");
  registered.client.trust = "verified"; registered.client.domain = "app.example";
  const view = render(createElement(ConsentScreen, { model: registered, acceptAction: async () => ({ ok: true, redirectUrl: "" }), rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.equal(view.queryByText("Verified"), null); assert.ok(view.getByText("not verified"));
});
test("a missing retention promise is omitted instead of attributed to the app", () => {
  const missing = buildConsentDemoModel("normal");
  missing.retention = `${missing.client.name} did not say how long it keeps the data it receives.`;
  const view = render(createElement(ConsentScreen, { model: missing, acceptAction: async () => ({ ok: true, redirectUrl: "" }), rejectAction: async () => ({ ok: true, redirectUrl: "" }) }));
  assert.equal(view.queryByText(/It says it keeps what it reads/), null);
});

test("no data sources keeps denial and add-source actions without duration or a tick prompt", async()=>{
 const empty=buildConsentDemoModel("empty");let denied=0;
 const view=render(createElement(ConsentScreen,{model:empty,acceptAction:async()=>assert.fail("cannot allow empty data"),rejectAction:async()=>{denied++;return {ok:true,redirectUrl:""};}}));
 assert.equal(view.queryByRole("button",{name:"Allow"}),null);
 assert.equal(view.queryByRole("heading",{name:"How long"}),null);
 assert.equal(view.queryByText("Tick at least one data source."),null);
 assert.ok(view.getByRole("link",{name:"Add a data source"}).className.includes("pdpp-btn"));
 await act(async()=>fireEvent.click(view.getByRole("button",{name:"Don't allow"})));
 assert.equal(denied,1);
 assert.ok(view.getByText("DataConnect"));
});
test("Limit what it sees hides narrowing until pressed and preserves the decision for unchanged ticks",async()=>{
 const sample=structuredClone(model); sample.sources=sample.sources.slice(0,1);sample.sources[0].streams=sample.sources[0].streams.slice(0,1);sample.sources[0].streams[0].selected=true; sample.sources[0].streams[0].fields=[{name:"id",required:true,label:"Record identifier"},{name:"title",required:false,label:"Title"}]; const decisions=[];
 const view=render(createElement(ConsentScreen,{model:sample,openKinds:true,acceptAction:async value=>{decisions.push(value);return {ok:false,message:"Try again."};},rejectAction:async()=>({ok:true,redirectUrl:""})}));
 const controls=view.getAllByRole("button",{name:"Limit what it sees"});
 assert.equal(view.queryByText("Choose fields to share"),null);
 await act(async()=>fireEvent.click(view.getByRole("button",{name:"Allow"})));
 await act(async()=>fireEvent.click(controls[0]));
 assert.ok(view.getByText("Choose fields to share"));
 assert.equal(view.queryByText("Record identifier"),null);
 await act(async()=>fireEvent.click(view.getByRole("button",{name:"Allow"})));
 assert.equal(JSON.stringify(decisions[0]),JSON.stringify(decisions[1]));
});

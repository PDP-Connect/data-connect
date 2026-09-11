// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { ConsentScreen } = await import("./consent-screen-client.tsx");
const { buildHostedMcpConsentChallengeModel } = await import(
  "../../../../../reference-implementation/server/routes/as-consent-ui-helpers.ts"
);
const { resolveStreamScopeSelection } = await import(
  "../../../../../reference-implementation/server/hosted-mcp-stream-scope.ts"
);
const manifest = JSON.parse(
  readFileSync(
    new URL("../../../../../node_modules/@pdpp/polyfill-connectors/manifests/spotify.json", import.meta.url),
    "utf8",
  ),
);
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

test("the screen renders Spotify's declared playlist label and scope details", async () => {
  const { view } = await journey();
  assert.ok(view.getByRole("checkbox", { name: "Share Your playlists from Spotify" }));
  const playlists = manifest.streams.find((stream) => stream.name === "playlists");
  assert.ok(view.getByText(playlists.display.detail));
});

test("field titles label the controls while descriptions appear once and raw names remain available", async () => {
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
  assert.ok(within(panel).getByText("owner_id"));
  assert.equal(within(panel).getAllByText("Who owns this playlist.").length, 1);
  assert.ok(within(panel).getByRole("checkbox", { name: "snapshot_id" }));
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
        fireEvent.click(view.getByRole("button", { name: "Allow access" }));
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
  fireEvent.click(within(panel).getByRole("button", { name: "Apply to all selected streams" }));
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

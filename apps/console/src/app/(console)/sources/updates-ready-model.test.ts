// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorInstallSnapshot } from "../lib/connector-install-contract.ts";
import { buildUpdatesReadyDemo, buildUpdatesReadyModel, formatUpdateResult } from "./updates-ready-model.ts";

function snapshot(connectorIds: readonly string[]): ConnectorInstallSnapshot {
  return {
    catalog: connectorIds.map((connectorId) => ({
      bindings: {},
      connector_id: connectorId,
      connector_key: connectorId,
      digest: `sha256:${"b".repeat(64)}`,
      latest: true,
      version: "2.0.0",
    })),
    status: connectorIds.map((connectorId) => ({
      activated_at: "2026-11-20T00:00:00Z",
      bindings: {},
      config_digest: "sha256:config",
      connector_id: connectorId,
      digest: `sha256:${"a".repeat(64)}`,
      entrypoint_sha256: "sha256:entrypoint",
      manifest_sha256: "sha256:manifest",
      provenance_sha256: "sha256:provenance",
      registry: "registry.example",
      repository: `library/${connectorId}`,
      version: "1.0.0",
    })),
  };
}

function sourcesByConnector(connectorIds: readonly string[]) {
  return Object.fromEntries(connectorIds.map((connectorId, index) => [
    connectorId,
    [{ displayName: `Data source ${index + 1}` }],
  ]));
}

// DIRECTION.md, “Data sources /sources”: one available update counts one kind and uses the singular button label.
test("one update names its data source and links to its Add page entry", () => {
  const model = buildUpdatesReadyModel(snapshot(["alpha"]), sourcesByConnector(["alpha"]));
  assert.ok(model);
  assert.equal(model.buttonLabel, "Update");
  assert.equal(model.namesText, "Data source 1");
  assert.equal(model.seeChangesHref, "/sources/add?source_q=alpha");
});

// DIRECTION.md, “Data sources /sources”: two update kinds use Update both and count kinds, not data sources.
test("two update kinds use the two-kind label and the Add page", () => {
  const model = buildUpdatesReadyModel(snapshot(["alpha", "beta"]), sourcesByConnector(["alpha", "beta"]));
  assert.ok(model);
  assert.equal(model.buttonLabel, "Update both");
  assert.equal(model.seeChangesHref, "/sources/add");
  assert.equal(model.kinds.length, 2);
});

// DIRECTION.md, “Data sources /sources”: three or more update kinds use Update all.
test("four update kinds use Update all", () => {
  const model = buildUpdatesReadyModel(snapshot(["alpha", "beta", "gamma", "delta"]), sourcesByConnector(["alpha", "beta", "gamma", "delta"]));
  assert.ok(model);
  assert.equal(model.buttonLabel, "Update all");
  assert.equal(model.kinds.length, 4);
});

// DIRECTION.md, “Data sources /sources”: failures are named in plain words, with each data source identified.
test("update results say which data sources succeeded and failed", () => {
  assert.equal(
    formatUpdateResult([
      { ok: true, sourceNames: ["Calendar"] },
      { ok: false, sourceNames: ["Mail"] },
    ]),
    "Updated data source Calendar. Could not update data source Mail."
  );
});

// DIRECTION.md, “Data sources /sources”: demo scenarios cover one, two, four, and one failed update result.
test("update demos seed each requested count and the finished failure result", () => {
  assert.equal(buildUpdatesReadyDemo("update-one").model.buttonLabel, "Update");
  assert.equal(buildUpdatesReadyDemo("update-two").model.buttonLabel, "Update both");
  assert.equal(buildUpdatesReadyDemo("update-four").model.buttonLabel, "Update all");
  const finished = buildUpdatesReadyDemo("update-finished-one-failure");
  assert.equal(finished.model.buttonLabel, "Update both");
  assert.equal(finished.initialResult, "Updated data source Calendar. Could not update data source Email.");
});

// Phone walk: seventeen names in one sentence is unreadable; a long list becomes a count.
test("a long list of data sources reads as a count, a short one keeps the names", () => {
  const many = Array.from({ length: 17 }, (_, index) => `kind${index}`);
  const model = buildUpdatesReadyModel(snapshot(many), sourcesByConnector(many));
  assert.ok(model);
  assert.equal(model.namesText, "17 data sources");
  assert.equal(model.buttonLabel, "Update all");
  const three = buildUpdatesReadyModel(snapshot(["a", "b", "c"]), sourcesByConnector(["a", "b", "c"]));
  assert.equal(three?.namesText, "Data source 1, Data source 2, and Data source 3");
});

// Review: the count is of sources, not of distinct labels.
test("five affected accounts count as five even when two share a name", () => {
  const model = buildUpdatesReadyModel(snapshot(["a", "b", "c", "d"]), {
    a: [{ displayName: "Amazon" }, { displayName: "Amazon" }],
    b: [{ displayName: "Chase" }],
    c: [{ displayName: "Mail" }],
    d: [{ displayName: "Photos" }],
  });
  assert.equal(model?.namesText, "5 data sources");
  assert.deepEqual(model?.names, ["Amazon · account 1", "Amazon · account 2", "Chase", "Mail", "Photos"]);
});

test("seventeen accounts all named Amazon read as 17 data sources, each listed apart", () => {
  const model = buildUpdatesReadyModel(snapshot(["a"]), { a: Array.from({ length: 17 }, () => ({ displayName: "Amazon" })) });
  assert.equal(model?.namesText, "17 data sources");
  assert.equal(new Set(model?.names).size, 17);
  assert.equal(model?.names[0], "Amazon · account 1");
});

test("two accounts with the same name stay apart in the short list", () => {
  const model = buildUpdatesReadyModel(snapshot(["a"]), { a: [{ displayName: "Amazon" }, { displayName: "Amazon" }] });
  assert.equal(model?.namesText, "Amazon · account 1 and Amazon · account 2");
});

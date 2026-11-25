// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as React from "react";
import { createElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectorUpdatesRead } from "../updates-ready-model.ts";
import type { ConnectorInstallSnapshot } from "../../lib/connector-install-contract.ts";
import { buildSourceUpdateModel } from "./source-update-view-model.ts";

Object.assign(globalThis, { React });

mock.module("next/navigation", {
  namedExports: {
    usePathname: () => "/sources",
    useRouter: () => ({ refresh() {} }),
  },
});
mock.module(new URL("../add/connector-install-actions.ts", import.meta.url).href, {
  namedExports: { updateConnectorAction: async () => ({ ok: true }) },
});

const sourceUpdateSection = import("./source-update-section.tsx").then(({ SourceUpdateSlot }) => SourceUpdateSlot);

const SNAPSHOT: ConnectorInstallSnapshot = {
  catalog: [{
    bindings: {},
    connector_id: "claude_code",
    connector_key: "claude-code",
    digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    latest: true,
    version: "1.5.0",
  }],
  status: [{
    activated_at: null,
    bindings: {},
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    connector_id: "claude-code",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    entrypoint_sha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    manifest_sha256: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    provenance_sha256: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    registry: "https://registry.example.test",
    repository: "https://example.test/claude-code",
    version: "1.4.0",
  }],
};

function updateRead(overrides: Partial<ConnectorUpdatesRead> = {}): ConnectorUpdatesRead {
  return {
    existingSources: {
      byConnector: {
        "claude-code": [
          { displayName: "Claude Code workstation" },
          { displayName: "Claude Code personal" },
          { displayName: "Claude Code work" },
        ],
      },
      truncated: false,
    },
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

test("the update read uses connector identity and names only other data sources", async () => {
  const model = await buildSourceUpdateModel("claude_code", "Claude Code workstation", async () => updateRead());
  assert.deepEqual(model, {
    connectorKey: "claude-code",
    currentVersion: "1.4.0",
    otherSources: ["Claude Code personal", "Claude Code work"],
    targetVersion: "1.5.0",
  });
});

test("a failed, truncated, ambiguous, or current update read produces no update", async () => {
  const catalogEntry = SNAPSHOT.catalog[0];
  const installedEntry = SNAPSHOT.status[0];
  assert.ok(catalogEntry);
  assert.ok(installedEntry);

  assert.equal(await buildSourceUpdateModel("claude-code", "Current", async () => { throw new Error("offline"); }), null);
  assert.equal(await buildSourceUpdateModel("claude-code", "Current", async () => updateRead({
    existingSources: { byConnector: {}, truncated: true },
  })), null);
  assert.equal(await buildSourceUpdateModel("claude-code", "Current", async () => updateRead({ snapshot: null })), null);
  assert.equal(await buildSourceUpdateModel("other", "Current", async () => updateRead()), null);
  assert.equal(await buildSourceUpdateModel("claude-code", "Current", async () => updateRead({
    snapshot: {
      ...SNAPSHOT,
      catalog: [...SNAPSHOT.catalog, {
        ...catalogEntry,
        connector_id: "claude-code",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      }],
    },
  })), null);
  assert.equal(await buildSourceUpdateModel("claude-code", "Current", async () => updateRead({
    snapshot: { ...SNAPSHOT, status: [{ ...installedEntry, digest: catalogEntry.digest }] },
  })), null);
});

test("Update is outlined and the shared-source copy names both other sources", async () => {
  const SourceUpdateSlot = await sourceUpdateSection;
  const html = renderToStaticMarkup(createElement(SourceUpdateSlot, {
    demoModel: {
      connectorKey: "claude-code",
      currentVersion: "1.4.0",
      otherSources: ["Claude Code personal", "Claude Code work"],
      targetVersion: "1.5.0",
    },
    displayName: "Claude Code workstation",
    version: "1.4.0",
  }));
  assert.match(html, /Version 1\.5\.0 is ready \(you have 1\.4\.0\)\./);
  assert.match(html, /It also updates Claude Code personal and Claude Code work\./);
  assert.match(html, /<button[^>]*class="[^"]*pdpp-btn--ghost[^"]*"[^>]*aria-label="Update Claude Code workstation"[^>]*>Update<\/button>/);
});

test("a failed update read falls back to the plain version line", async () => {
  const SourceUpdateSlot = await sourceUpdateSection;
  const model = await buildSourceUpdateModel("claude-code", "Current", async () => { throw new Error("offline"); });
  const html = renderToStaticMarkup(createElement(SourceUpdateSlot, {
    demoModel: model,
    displayName: "Claude Code",
    version: "1.4.0",
  }));
  // DIRECTION.md, one data source Version: the version line must not claim newness without proof.
  assert.match(html, /Version 1\.4\.0\./);
  assert.doesNotMatch(html, /newest/);
  assert.doesNotMatch(html, /Version 1\.5\.0 is ready/);
});

test("an update read that never resolves leaves the version fallback visible", async () => {
  const SourceUpdateSlot = await sourceUpdateSection;
  const never = new Promise<null>(() => {});
  const html = renderToStaticMarkup(createElement(Suspense, {
    fallback: createElement("p", null, "Version 1.4.0."),
  }, createElement(SourceUpdateSlot, {
    demoModel: null,
    displayName: "Claude Code",
    updates: never,
    version: "1.4.0",
  })));
  // DIRECTION.md, one data source Version: an unresolved update check cannot prove newness.
  assert.match(html, /Version 1\.4\.0\./);
  assert.doesNotMatch(html, /newest/);
  assert.doesNotMatch(html, /Update 1\.5\.0/);
});

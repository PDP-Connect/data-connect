// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Behavior-preservation gate for connector tuning knobs. Each key below was a
// static platform key: the runtime copied it from the reference server's
// environment into every connector child. The keys are now connector-declared
// data. This test drives the REAL shipped manifest of each owning connector,
// with the connector identity the runtime uses at spawn, and proves that every
// key still reaches its owner with the same value.

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import { composeConnectorChildEnvironment } from "../runtime/connector-child-environment.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";

const OWNED_TUNING_KEYS: Readonly<Record<string, readonly string[]>> = {
  "amazon.json": ["PDPP_AMAZON_YEARS", "PDPP_AMAZON_SKIP_DETAIL"],
  "apple_photos.json": ["PDPP_APPLE_PHOTOS_MAX_PHOTO_BYTES"],
  "chatgpt.json": [
    "PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS",
    "PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER",
    "PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN",
    "PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS",
    "PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN",
    "PDPP_CHATGPT_PACING_BURST_TOLERANCE_MS",
    "PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS",
    "PDPP_CHATGPT_PACING_MAX_INTERVAL_MS",
    "PDPP_CHATGPT_PACING_MIN_INTERVAL_MS",
    "PDPP_CHATGPT_PACING_RECOVERY_GAIN",
    "PDPP_CHATGPT_RETRY_BUDGET_CAPACITY",
    "PDPP_CHATGPT_RETRY_BUDGET_INITIAL_TOKENS",
    "PDPP_CHATGPT_CIRCUIT_BREAKER",
    "PDPP_CHATGPT_PUSH_APPROVAL_TIMEOUT_MS",
    "PDPP_CHATGPT_BROWSER_LOGIN_TIMEOUT_MS",
  ],
  "codex.json": ["PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS"],
  "gmail.json": [
    "PDPP_GMAIL_ATTACHMENT_BACKFILL_PAGE_BYTES",
    "PDPP_GMAIL_ATTACHMENT_BACKFILL_WINDOW_UIDS",
    "PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_BYTES",
    "PDPP_GMAIL_ATTACHMENT_PROGRESS_MIN_INTERVAL_MS",
    "PDPP_GMAIL_ATTACHMENT_RECOVERY_PAGE_BYTES",
    "PDPP_GMAIL_ATTACHMENT_STALL_TIMEOUT_MS",
    "PDPP_GMAIL_MAX_ATTACHMENT_BYTES",
  ],
  "google_takeout.json": ["PDPP_GOOGLE_TAKEOUT_MAX_PHOTO_BYTES"],
  "imessage.json": ["PDPP_IMESSAGE_MAX_ATTACHMENT_BYTES"],
};

interface ShippedConnector {
  readonly connectorId: string;
  readonly manifest: unknown;
}

function shippedConnector(file: string): ShippedConnector {
  const entry = readPolyfillManifests().find((candidate) => candidate.file === file);
  if (!entry) {
    throw new Error(`no polyfill manifest found for ${file}`);
  }
  const rawConnectorId = (entry.manifest as { connector_id?: unknown }).connector_id;
  if (typeof rawConnectorId !== "string") {
    throw new Error(`${file} has no connector_id`);
  }
  // Same identity derivation as runConnector (runtime/index.ts).
  return { connectorId: canonicalConnectorKey(rawConnectorId) ?? rawConnectorId, manifest: entry.manifest };
}

function childEnvironment(connector: ShippedConnector, sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  return composeConnectorChildEnvironment({
    connectorId: connector.connectorId,
    explicitRunEnv: {},
    manifest: connector.manifest,
    platform: "linux",
    sourceEnv,
  });
}

test("the preservation table covers exactly the 28 tuning keys of 7 connectors", () => {
  const keys = Object.values(OWNED_TUNING_KEYS).flat();
  assert.equal(Object.keys(OWNED_TUNING_KEYS).length, 7);
  assert.equal(keys.length, 28);
  assert.equal(new Set(keys).size, 28);
});

for (const [file, keys] of Object.entries(OWNED_TUNING_KEYS)) {
  for (const key of keys) {
    test(`${key} reaches the ${file} connector child with the operator's value`, () => {
      const value = `operator-value-for-${key}`;
      const env = childEnvironment(shippedConnector(file), { [key]: value, PATH: "/usr/bin" });
      assert.equal(env[key], value);
      assert.equal(env.PATH, "/usr/bin");
    });

    test(`${key} stays absent from the ${file} connector child when the operator does not set it`, () => {
      const env = childEnvironment(shippedConnector(file), { PATH: "/usr/bin" });
      assert.equal(Object.hasOwn(env, key), false);
    });

    test(`${key} does not reach any other shipped connector child`, () => {
      const others = readPolyfillManifests()
        .map((entry) => entry.file)
        .filter((candidate) => candidate !== file);
      assert.ok(others.length > 7, "every shipped manifest is checked, not only the owners");
      for (const other of others) {
        const env = childEnvironment(shippedConnector(other), { [key]: "leaked" });
        assert.equal(Object.hasOwn(env, key), false, `${key} leaked into ${other}`);
      }
    });
  }
}

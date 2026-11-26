// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Binding features the reference runtime supplies, and what it still refuses
 * (Collection Profile section 3.3.8).
 *
 * A required binding that declares `features` is placed only when this runtime
 * supplies every one. The supply of each advertised feature is proven against a
 * real browser in `collection-profile-binding-features-browser.test.ts`; this
 * file pins the placement decision: what is advertised, what is refused, and
 * what the signed catalog's connectors get as a result.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  BindingPlacementError,
  normalizeBindingDeclarations,
  planBindingPlacement,
  RUNTIME_BINDING_SUPPORT,
  startBindingsFor,
} from "../runtime/binding-declarations.ts";
import manifestSchema from "../runtime/connector-manifest.schema.json" with { type: "json" };
import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { inspectActiveConnector } from "../server/connector-install/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { fakeAdmitRunConnection } from "./helpers/fake-admit-run-connection.ts";
import catalogFeatureBindings from "./fixtures/collection-profiles/catalog-feature-bindings.json" with { type: "json" };
import { installCollectionProfiles, readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";

// runConnector reads detail-gap state from the DB before spawn, so it needs one.
before(() => {
  initDb(":memory:");
});

after(() => {
  closeDb();
});

/** The kind each feature belongs to (section 3.3.8). `host_http_request` is also valid on `browser`. */
const NETWORK_FEATURES: ReadonlySet<string> = new Set(["same_origin_page_fetch", "host_http_request"]);

const ADVERTISED_FEATURES = [
  "host_http_request",
  "page_condition_wait",
  "page_content_read",
  "page_navigation",
  "page_script_evaluation",
  "same_origin_page_fetch",
] as const;

function kindOf(feature: string): "browser" | "network" {
  return NETWORK_FEATURES.has(feature) ? "network" : "browser";
}

function plan(bindings: unknown) {
  return planBindingPlacement(normalizeBindingDeclarations(bindings));
}

/**
 * A required declaration of one feature on its own kind. A browser is placed
 * beside it, so a page-context feature on `network` has a page to run in.
 */
function declaring(feature: string): Record<string, unknown> {
  return { browser: { required: true }, [kindOf(feature)]: { features: [feature], required: true } };
}

// ---------------------------------------------------------------------------
// 1. What the runtime advertises, and what it refuses
// ---------------------------------------------------------------------------

test("the advertised feature set is exactly the features the browser test proves", () => {
  assert.deepEqual([...RUNTIME_BINDING_SUPPORT.features].sort(), [...ADVERTISED_FEATURES].sort());
});

test("constraints are still not enforced, so no kind advertises constraint support", () => {
  assert.equal(RUNTIME_BINDING_SUPPORT.constraintKinds.size, 0);
});

for (const feature of ADVERTISED_FEATURES) {
  test(`placement: a required ${kindOf(feature)} binding that declares ${feature} is placed`, () => {
    const placement = plan(declaring(feature));
    assert.ok(placement.placed.some((instance) => instance.key === kindOf(feature)));
    assert.equal(placement.omitted.length, 0);
  });
}

test("placement: host_http_request is also placed on browser, its legacy placement", () => {
  const placement = plan({ browser: { features: ["host_http_request"], required: true } });
  assert.deepEqual(
    placement.placed.map((instance) => instance.key),
    ["browser"]
  );
});

const UNADVERTISED_FEATURES: readonly string[] = manifestSchema.$defs.bindingFeature.enum.filter(
  (feature) => !RUNTIME_BINDING_SUPPORT.features.has(feature)
);

test("the schema lists features this runtime does not advertise", () => {
  // Guards the two loops below from running over an empty list.
  assert.ok(UNADVERTISED_FEATURES.length >= 6, UNADVERTISED_FEATURES.join(", "));
});

for (const feature of UNADVERTISED_FEATURES) {
  test(`placement: a required binding that declares ${feature} is refused before spawn`, () => {
    const kind = kindOf(feature);
    assert.throws(
      () => plan({ [kind]: { features: [feature], required: true } }),
      (error: unknown) =>
        error instanceof BindingPlacementError &&
        error.bindingKeys.includes(kind) &&
        error.message.includes(`features ${feature} are not provided by this runtime`)
    );
  });

  test(`placement: an optional binding that declares ${feature} is omitted, not advertised`, () => {
    const kind = kindOf(feature);
    const instances = normalizeBindingDeclarations({ [kind]: { features: [feature], required: false } });
    const placement = planBindingPlacement(instances);
    assert.equal(placement.placed.length, 0);
    assert.equal(placement.omitted.length, 1);
    assert.equal(Object.hasOwn(startBindingsFor(instances, placement), kind), false);
  });
}

test("placement: one unadvertised feature refuses the whole binding, even beside advertised ones", () => {
  assert.throws(
    () => plan({ browser: { features: ["page_navigation", "page_input"], required: true } }),
    (error: unknown) => error instanceof BindingPlacementError && error.message.includes("page_input")
  );
});

test("placement: a page-context fetch needs a browser placed in the same plan", () => {
  const network = { features: ["same_origin_page_fetch"], required: true };
  for (const bindings of [{ network }, { browser: { features: ["page_input"], required: false }, network }]) {
    assert.throws(
      () => plan(bindings),
      (error: unknown) =>
        error instanceof BindingPlacementError &&
        error.bindingKeys.join() === "network" &&
        error.message.includes("need a browser binding placed with it")
    );
  }
});

// Browser-only features cannot reach placement on a network binding: the schema
// gives each feature one kind (section 3.3.8), so normalization rejects them.
// Placement therefore needs no kind check for them.
for (const feature of ["page_navigation", "page_script_evaluation", "page_content_read", "page_condition_wait"]) {
  for (const required of [true, false]) {
    test(`normalization: a ${required ? "required" : "optional"} network binding cannot declare browser-only ${feature}`, () => {
      assert.throws(
        () => normalizeBindingDeclarations({ network: { features: [feature], required } }),
        /network\.features\.0 must be equal to one of the allowed values/
      );
    });
  }
}

test("placement: a host-side request does not need a browser", () => {
  const placement = plan({ network: { features: ["host_http_request"], required: true } });
  assert.deepEqual(
    placement.placed.map((instance) => instance.key),
    ["network"]
  );
});

test("placement: constraints are still refused until the runtime enforces them", () => {
  assert.throws(
    () =>
      plan({
        browser: { required: true },
        network: { constraints: { hosts: ["example.com"] }, features: ["same_origin_page_fetch"], required: true },
      }),
    (error: unknown) =>
      error instanceof BindingPlacementError &&
      error.bindingKeys.join() === "network" &&
      error.message.includes("does not enforce them")
  );
});

// ---------------------------------------------------------------------------
// 2. The signed whatsapp-web 0.1.10 catalog manifest
// ---------------------------------------------------------------------------

test("whatsapp-web 0.1.10 from the signed catalog installs and passes placement", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-binding-features-whatsapp-"));
  try {
    const profile = readCollectionProfileFixture("whatsapp-web");
    assert.equal(profile.version, "0.1.10");
    const { store } = await installCollectionProfiles(dataDir, [profile]);
    const inspection = await inspectActiveConnector(store, "whatsapp-web");
    assert.equal(inspection.status, "active");
    if (inspection.status !== "active") {
      return;
    }
    const manifest = inspection.record.manifest as { runtime_requirements?: { bindings?: unknown } };
    const instances = normalizeBindingDeclarations(manifest.runtime_requirements?.bindings);
    const placement = planBindingPlacement(instances);
    assert.deepEqual(placement.placed.map((instance) => instance.key).sort(), ["browser", "network"]);
    assert.deepEqual(Object.keys(startBindingsFor(instances, placement)).sort(), ["browser", "filesystem", "network"]);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a run of the whatsapp-web 0.1.10 manifest is no longer refused before spawn", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-binding-features-run-"));
  try {
    const startPath = join(tmpDir, "start.json");
    const connectorPath = join(tmpDir, "connector.mjs");
    // Writes the START it receives, then succeeds. It stands in for the connector's code.
    writeFileSync(
      connectorPath,
      `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  writeFileSync(${JSON.stringify(startPath)}, JSON.stringify(msg));
  process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 }) + "\\n");
  process.exit(0);
});
`
    );
    const manifest = readCollectionProfileFixture("whatsapp-web");
    await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: "whatsapp-web",
      connectorPath,
      manifest,
      onInteraction: async () => ({ data: {}, request_id: "unused", status: "success", type: "INTERACTION_RESPONSE" }),
      ownerToken: "test",
      persistState: true,
      rsUrl: "http://localhost:9999",
      state: null,
    } as unknown as RuntimeRunConnectorOptions);
    assert.ok(existsSync(startPath), "the connector was spawned and received START");
    const start = JSON.parse(readFileSync(startPath, "utf8")) as { bindings: Record<string, unknown> };
    assert.deepEqual(Object.keys(start.bindings).sort(), ["browser", "filesystem", "network"]);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The pinned snapshot of catalog connectors that declare features
// ---------------------------------------------------------------------------

/** Connectors whose declarations this runtime still refuses, with the unmet reason. */
const REFUSED_BY_CATALOG_CONNECTOR: Readonly<Record<string, string>> = {
  // Declares constraints (recorded-only until the runtime enforces them).
  character_ai: "constraints are declared, and this runtime does not enforce them",
  // The export connector needs a host-side download seam and archive extraction.
  anthropic: "features host_download_capture, host_archive_extraction, host_archive_entry_chunk_read",
  mountain_project: "constraints are declared, and this runtime does not enforce them",
  perplexity: "constraints are declared, and this runtime does not enforce them",
  polar_flow: "constraints are declared, and this runtime does not enforce them",
};

test("every connector in the refusal map is in the pinned snapshot", () => {
  const connectors = Object.keys(catalogFeatureBindings.connectors);
  for (const key of Object.keys(REFUSED_BY_CATALOG_CONNECTOR)) {
    assert.ok(connectors.includes(key), `${key} is not in the snapshot`);
  }
});

for (const [key, entry] of Object.entries(catalogFeatureBindings.connectors)) {
  const refusal = REFUSED_BY_CATALOG_CONNECTOR[key];
  if (refusal === undefined) {
    test(`catalog ${key} ${entry.version}: every declared binding is placed`, () => {
      const instances = normalizeBindingDeclarations(entry.bindings);
      const placement = planBindingPlacement(instances);
      assert.equal(placement.omitted.length, 0);
      assert.deepEqual(
        placement.placed.map((instance) => instance.key),
        instances.map((instance) => instance.key)
      );
    });
  } else {
    test(`catalog ${key} ${entry.version}: still refused before spawn, because ${refusal}`, () => {
      assert.throws(
        () => plan(entry.bindings),
        (error: unknown) => error instanceof BindingPlacementError && error.message.includes(refusal)
      );
    });
  }
}

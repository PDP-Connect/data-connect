// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collection Profile binding declarations, one canonical validator for every
 * entry point (data-connectors a87edcdc099284e8582d24a60c9630474bd2af8b).
 *
 * Three entry points are covered: the registration and stored-manifest gate
 * (`validateConnectorManifest`), the direct `runConnector` path before spawn,
 * and raw manifest JSON text (duplicate keys). A spawn is proven absent by a
 * capture file that only the spawned connector writes.
 *
 * What passing means: a declaration is well formed, or the runtime can supply
 * its required contract. It never means the runtime enforces an authority.
 * Section 3.3.10 keeps every channel's coverage separate from this check.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  BindingDeclarationError,
  BindingPlacementError,
  normalizeBindingDeclarations,
  parseManifestJsonText,
  startBindingsFor,
} from "../runtime/binding-declarations.ts";
import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { validateConnectorManifest } from "../server/connector-manifest-validation.ts";
import { closeDb, initDb } from "../server/db.ts";

const MINIMAL_MANIFEST = {
  connector_id: "test",
  display_name: "Test Connector",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

function withBindings(bindings: unknown): Record<string, unknown> {
  return { ...MINIMAL_MANIFEST, runtime_requirements: { bindings } };
}

// Assertion patterns, hoisted to module scope.
const REQUIRED_FLAG = /required/;
const INTERACTIVE_INSTANCE = /interactive/;
const SHORTHAND_KIND_FORBIDDEN = /browser must NOT be valid/;
const INSTANCE_KIND = /kind/;
const UNKNOWN_SHORTHAND = /scanner/;
const BINDINGS_OBJECT = /bindings/;
const EXTERNAL_TOOLS = /external_tools/;
const INTERFACE_SHAPE = /interface/;
const CANONICAL_NAVIGATION_HOST = /navigate\.0 must match pattern/;
const RATIONALE_REQUIRED = /rationale/;

// runConnector reads detail-gap state from the DB before spawn, so it needs one.
before(() => {
  initDb(":memory:");
});

after(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// 1. Registration and stored-manifest gate: validateConnectorManifest
// ---------------------------------------------------------------------------

test("registration gate: a required binding must state a boolean required flag", () => {
  // Canonical 3.3: `required` is REQUIRED. Old gate accepted an absent flag.
  assert.throws(() => validateConnectorManifest(withBindings({ browser: {} })), REQUIRED_FLAG);
});

test("registration gate: `interactive` is removed as a binding and is not accepted", () => {
  // Canonical 3.3 removed-name table. Old gate accepted it as a registry name.
  assert.throws(
    () => validateConnectorManifest(withBindings({ interactive: { required: true } })),
    INTERACTIVE_INSTANCE
  );
  assert.throws(
    () => validateConnectorManifest(withBindings({ interactive: { required: false } })),
    INTERACTIVE_INSTANCE
  );
});

test("registration gate: a shorthand key must not carry kind; a named instance must", () => {
  assert.throws(
    () => validateConnectorManifest(withBindings({ browser: { kind: "network", required: false } })),
    SHORTHAND_KIND_FORBIDDEN
  );
  assert.throws(() => validateConnectorManifest(withBindings({ chase_site: { required: true } })), INSTANCE_KIND);
});

test("registration gate: a named instance with an explicit kind is valid", () => {
  assert.doesNotThrow(() =>
    validateConnectorManifest(withBindings({ chase_site: { kind: "browser", required: true } }))
  );
});

test("registration gate: an unqualified unknown optional shorthand is rejected", () => {
  assert.throws(() => validateConnectorManifest(withBindings({ scanner: { required: false } })), UNKNOWN_SHORTHAND);
});

test("registration gate: a canonical namespaced extension is shape-valid", () => {
  // Shape-valid only. Placement, not validation, refuses it when required.
  assert.doesNotThrow(() => validateConnectorManifest(withBindings({ "example.com/scanner": { required: true } })));
});

test("registration gate: null bindings is rejected, since the canonical map is an object", () => {
  // Canonical schema: `bindings` is type object. Old gate treated null as absent.
  assert.throws(() => validateConnectorManifest(withBindings(null)), BINDINGS_OBJECT);
});

test("registration gate: external_tools is validated even when bindings is absent", () => {
  // Old gate returned early on absent bindings and skipped external_tools.
  const manifest = { ...MINIMAL_MANIFEST, runtime_requirements: { external_tools: "not-an-array" } };
  assert.throws(() => validateConnectorManifest(manifest), EXTERNAL_TOOLS);
});

test("registration gate: interface must match the resolved kind, with no leading zero", () => {
  assert.throws(
    () =>
      validateConnectorManifest(
        withBindings({ chase_site: { interface: "browser@01", kind: "browser", required: true } })
      ),
    INTERFACE_SHAPE
  );
  assert.throws(
    () =>
      validateConnectorManifest(
        withBindings({ chase_site: { interface: "network@1", kind: "browser", required: true } })
      ),
    INTERFACE_SHAPE
  );
  assert.doesNotThrow(() =>
    validateConnectorManifest(withBindings({ chase_site: { interface: "browser@2", kind: "browser", required: true } }))
  );
});

test("registration gate: a web host constraint must be in canonical form", () => {
  assert.throws(
    () =>
      validateConnectorManifest(
        withBindings({ browser: { constraints: { navigate: ["https://Secure.Chase.com"] }, required: true } })
      ),
    CANONICAL_NAVIGATION_HOST
  );
});

test("registration gate: a desktop_session item is an exceptional grant and needs a rationale", () => {
  const item = { operations: ["unwrap"], selector: "signal-safestorage", service: "os_keyring" };
  assert.throws(
    () =>
      validateConnectorManifest(
        withBindings({ signal_keyring: { constraints: { items: [item] }, kind: "desktop_session", required: true } })
      ),
    RATIONALE_REQUIRED
  );
  assert.doesNotThrow(() =>
    validateConnectorManifest(
      withBindings({
        signal_keyring: {
          constraints: { items: [item] },
          kind: "desktop_session",
          rationale: "Keyring unwraps the local database key.",
          required: true,
        },
      })
    )
  );
});

test("registration gate: a valid shorthand manifest keeps its meaning (baseline)", () => {
  assert.doesNotThrow(() => validateConnectorManifest(withBindings({ network: { required: true } })));
  assert.doesNotThrow(() => validateConnectorManifest(withBindings({ filesystem: { required: false } })));
});

// ---------------------------------------------------------------------------
// 2. Direct runConnector before spawn: the same validator, no child process
// ---------------------------------------------------------------------------

function fakeAdmitRunConnection(): NonNullable<RuntimeRunConnectorOptions["admitRunConnection"]> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
    const owner = ownerSubjectId || "owner_binding_test";
    const exactId = connectorInstanceId ?? `cin_${owner}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId: owner });
  };
}

/** A connector that writes the START it receives to `capturePath`, then succeeds. */
function startCaptureConnector(capturePath: string): { cleanup: () => void; connectorPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-binding-start-capture-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(`${capturePath}.spawned`)}, 'spawned');
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(msg, null, 2));
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf-8"
  );
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

interface DirectRunResult {
  error: Error | null;
  spawned: boolean;
  start: Record<string, unknown> | null;
}

async function runWithBindings(bindings: unknown): Promise<DirectRunResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-binding-direct-"));
  const capturePath = join(tmpDir, "start.json");
  const { cleanup, connectorPath } = startCaptureConnector(capturePath);
  let error: Error | null = null;
  try {
    await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: "test",
      connectorPath,
      manifest: withBindings(bindings),
      onInteraction: async () => ({ data: {}, request_id: "unused", status: "success", type: "INTERACTION_RESPONSE" }),
      ownerToken: "test",
      persistState: true,
      rsUrl: "http://localhost:9999",
      state: null,
    } as unknown as RuntimeRunConnectorOptions);
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  // The launch marker is independent of START; a failure before START cannot hide a spawn.
  const spawned = existsSync(`${capturePath}.spawned`);
  const start = existsSync(capturePath)
    ? (JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>)
    : null;
  cleanup();
  rmSync(tmpDir, { force: true, recursive: true });
  return { error, spawned, start };
}

test("direct run: a malformed binding (missing required) is refused before spawn", async () => {
  const result = await runWithBindings({ browser: {} });
  assert.ok(result.error instanceof BindingDeclarationError);
  assert.match(result.error.message, REQUIRED_FLAG);
  assert.equal(result.spawned, false);
});

test("direct run: `interactive` is refused before spawn", async () => {
  const result = await runWithBindings({ interactive: { required: true } });
  assert.ok(result.error instanceof BindingDeclarationError);
  assert.match(result.error.message, INTERACTIVE_INSTANCE);
  assert.equal(result.spawned, false);
});

test("direct run: a required unsupported feature is refused before spawn", async () => {
  // Old direct path ignored features and spawned the connector.
  const result = await runWithBindings({ browser: { features: ["page_navigation"], required: true } });
  assert.ok(result.error instanceof BindingPlacementError);
  assert.deepEqual(result.error.bindingKeys, ["browser"]);
  assert.ok(result.error.message.includes("features page_navigation are not provided"));
  assert.equal(result.spawned, false);
});

test("direct run: a required unsupported constraint is refused before spawn", async () => {
  const result = await runWithBindings({
    filesystem: {
      constraints: { outputs: [{ access: "write", slot: "statements" }] },
      required: true,
    },
  });
  assert.ok(result.error instanceof BindingPlacementError);
  assert.deepEqual(result.error.bindingKeys, ["filesystem"]);
  assert.ok(result.error.message.includes("does not enforce them"));
  assert.equal(result.spawned, false);
});

test("direct run: a required unsupported interface version is refused before spawn", async () => {
  const result = await runWithBindings({ chase_site: { interface: "browser@2", kind: "browser", required: true } });
  assert.ok(result.error instanceof BindingPlacementError);
  assert.deepEqual(result.error.bindingKeys, ["chase_site"]);
  assert.ok(result.error.message.includes("interface browser@2 is not implemented"));
  assert.equal(result.spawned, false);
});

test("direct run: a required namespaced extension is refused before spawn", async () => {
  const result = await runWithBindings({ "example.com/scanner": { required: true } });
  assert.ok(result.error instanceof BindingPlacementError);
  assert.deepEqual(result.error.bindingKeys, ["example.com/scanner"]);
  assert.ok(result.error.message.includes("kind example.com/scanner is not implemented"));
  assert.equal(result.spawned, false);
});

test("direct run: an optional unsupported extension is omitted and START does not advertise it", async () => {
  const result = await runWithBindings({ "example.com/scanner": { required: false } });
  assert.equal(result.error, null);
  assert.equal(result.spawned, true);
  assert.equal(Object.hasOwn(result.start?.bindings as object, "example.com/scanner"), false);
});

test("direct run: a required named instance is refused until the runtime supplies per-instance handles", async () => {
  const result = await runWithBindings({ chase_site: { kind: "browser", required: true } });
  assert.ok(result.error instanceof BindingPlacementError);
  assert.deepEqual(result.error.bindingKeys, ["chase_site"]);
  assert.ok(result.error.message.includes("per-instance handles"));
  assert.equal(result.spawned, false);
});

test("START encoding keeps resolved instance keys and omits a same-kind instance separately", () => {
  // Encoder-only test with a supplied plan. This is not evidence that native
  // execution can resolve these handles; the direct-run refusal above proves
  // that this runtime currently cannot.
  const instances = normalizeBindingDeclarations({
    optional_page: { features: ["page_navigation"], kind: "browser", required: false },
    provider_page: { kind: "browser", required: true },
  });
  const placed = instances.filter((instance) => instance.key === "provider_page");
  const optional = instances.find((instance) => instance.key === "optional_page");
  assert.ok(optional);
  const bindings = startBindingsFor(instances, {
    omitted: [{ instance: optional, reason: "unsupported feature" }],
    placed,
  });
  assert.deepEqual(bindings.provider_page, {});
  assert.equal(Object.hasOwn(bindings, "optional_page"), false);
  assert.equal(Object.hasOwn(bindings, "browser"), false);
});

test("direct run: an omitted optional browser with unsupported features is not advertised in START", async () => {
  const result = await runWithBindings({ browser: { features: ["page_navigation"], required: false } });
  assert.equal(result.error, null);
  assert.equal(result.spawned, true);
  assert.equal(Object.hasOwn(result.start?.bindings as object, "browser"), false);
});

test("direct run: a valid shorthand baseline spawns and advertises the static kinds", async () => {
  const result = await runWithBindings({ network: { required: true } });
  assert.equal(result.error, null);
  assert.equal(result.spawned, true);
  const bindings = result.start?.bindings as Record<string, unknown>;
  assert.ok(Object.hasOwn(bindings, "network"));
  assert.ok(Object.hasOwn(bindings, "browser"));
  assert.ok(Object.hasOwn(bindings, "filesystem"));
  assert.equal(Object.hasOwn(bindings, "interactive"), false);
});

// ---------------------------------------------------------------------------
// 3. Raw manifest JSON text: duplicate keys are rejected before last-wins
// ---------------------------------------------------------------------------

test("raw JSON: a repeated instance key is rejected, not last-wins", () => {
  const text = '{"runtime_requirements":{"bindings":{"browser":{"required":true},"browser":{"required":false}}}}';
  assert.throws(
    () => parseManifestJsonText(text),
    (error: unknown) => (error as { code?: string }).code === "duplicate_json_key"
  );
});

test("raw JSON: an escaped spelling of the same key is a duplicate", () => {
  const text = '{"bindings":{"browser":{"required":true},"\\u0062rowser":{"required":false}}}';
  assert.throws(
    () => parseManifestJsonText(text),
    (error: unknown) => (error as { code?: string }).code === "duplicate_json_key"
  );
});

test("raw JSON: a repeated nested member is rejected anywhere in the text", () => {
  const text = '{"runtime_requirements":{"bindings":{"network":{"required":true,"required":false}}}}';
  assert.throws(
    () => parseManifestJsonText(text),
    (error: unknown) => (error as { code?: string }).code === "duplicate_json_key"
  );
});

test("raw JSON: a text without duplicate keys parses to its value (baseline)", () => {
  const parsed = parseManifestJsonText('{"runtime_requirements":{"bindings":{"network":{"required":true}}}}');
  assert.deepEqual(parsed, { runtime_requirements: { bindings: { network: { required: true } } } });
});

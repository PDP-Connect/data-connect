// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for connector `runtime_requirements.bindings`.
 *
 * These declarations are reference/polyfill deployment metadata. The
 * registry should reject malformed requirements so operators do not discover
 * missing runtime capabilities only after a connector has started.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BindingDeclarationError } from "../runtime/binding-declarations.ts";
import { getConnectorManifest } from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";

const DUPLICATE_OBJECT_KEY = /repeats object key/;

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn: (harness: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface RegisterResult {
  body: ErrorBody | string | null;
  status: number;
}

function hasErrorBody(body: RegisterResult["body"]): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

async function registerConnectorManifest(asUrl: string, manifest: unknown): Promise<RegisterResult> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  let body: RegisterResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

function makeManifest(runtimeRequirements: unknown) {
  return withFixtureSourceDeclaration({
    connector_id: "runtime-requirements-fixture",
    connector_key: "runtime-requirements-fixture",
    display_name: "Runtime requirements fixture",
    protocol_version: "0.1.0",
    runtime_requirements: runtimeRequirements,
    streams: [
      {
        cursor_field: "received_at",
        name: "notes",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            received_at: { format: "date-time", type: "string" },
          },
          required: ["id", "received_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  });
}

test("valid browser runtime binding is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ bindings: { browser: { required: true }, network: { required: true } } })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("unsupported runtime binding is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ bindings: { toaster: { required: true } } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /toaster must have required property 'kind'/u);
  });
});

test("runtime binding required flag must be boolean", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ bindings: { browser: { required: "yes" } } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /browser\.required must be boolean/u);
  });
});

const RAW_KEY_CONNECTOR = "raw-binding-keys";

/**
 * Valid registration for the raw-key tests: the operational key is a slug and
 * the source identity is a distinct absolute URI. A URI-only `connector_id`
 * registers with a source-declaration error (sourceId must be an absolute URI)
 * or stores a URL connector_key that the read path rejects, so neither is a
 * usable control.
 */
function makeRawBindingKeysManifest() {
  return withFixtureSourceDeclaration({
    ...makeManifest({ bindings: { network: { required: false } } }),
    connector_id: RAW_KEY_CONNECTOR,
    connector_key: RAW_KEY_CONNECTOR,
    manifest_uri: `https://registry.pdpp.test/connectors/${RAW_KEY_CONNECTOR}`,
  });
}

test("registration rejects duplicate binding keys in the raw HTTP body before persistence", async () => {
  await withHarness(async ({ asUrl }) => {
    const manifest = makeRawBindingKeysManifest();
    const valid = JSON.stringify(manifest);
    const duplicate = valid.replace(
      '"network":{"required":false}',
      '"network":{"required":true},"network":{"required":false}'
    );
    assert.notEqual(duplicate, valid, "the request must retain both raw object keys");
    const response = await fetch(`${asUrl}/connectors`, {
      body: duplicate,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), DUPLICATE_OBJECT_KEY);
    assert.equal(await getConnectorManifest(manifest.connector_id), null, "a rejected declaration is not persisted");
    const baseline = await registerConnectorManifest(asUrl, manifest);
    assert.equal(baseline.status, 201, "the same declaration without duplicate keys must register");
  });
});

test("stored manifest reads reject duplicate raw keys before JSON parsing loses them", async () => {
  await withHarness(async ({ asUrl }) => {
    const manifest = makeRawBindingKeysManifest();
    const registered = await registerConnectorManifest(asUrl, manifest);
    assert.equal(registered.status, 201);
    try {
      assert.ok(await getConnectorManifest(manifest.connector_id));
    } catch (error: unknown) {
      assert.fail(
        `valid stored fixture must load: ${error instanceof Error ? String(error.cause ?? error) : String(error)}`
      );
    }
    const valid = JSON.stringify(manifest);
    const duplicate = valid.replace(
      '"network":{"required":false}',
      '"network":{"required":true},"network":{"required":false}'
    );
    assert.notEqual(duplicate, valid);
    getDb().prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?").run(duplicate, manifest.connector_id);
    await assert.rejects(
      () => getConnectorManifest(manifest.connector_id),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof BindingDeclarationError);
        assert.equal(error.cause.code, "duplicate_json_key");
        return true;
      }
    );
  });
});

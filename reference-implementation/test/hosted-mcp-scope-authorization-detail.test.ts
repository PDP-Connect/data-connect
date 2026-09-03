// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The picker's narrowing reaches the issued grant.
 *
 * `hosted-mcp-stream-scope.test.ts` proves the validation rules in isolation.
 * This proves the join: that a submitted narrowing survives
 * `buildHostedMcpAuthorizationDetailForConnector` and resolves, through the
 * real `resolveCoreSelection`, into a grant stream carrying the narrowed
 * `fields` and a `time_constraint` stamped with the manifest's own
 * `consent_time_field`.
 *
 * Without this, both halves could be individually correct and still not meet:
 * the scope map could be built and silently dropped at the detail builder, and
 * every unit test would still pass. The end of this chain is what the resource
 * server enforces, so it is the thing worth pinning.
 *
 * The fixtures are the real ChatGPT manifest, so the capability signals under
 * test (`selection.fields`, `consent_time_field`) are the shipped ones rather
 * than a shape invented to make the test pass.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveCoreSelection } from "../server/core-source-authorization.ts";
import {
  parseSubmittedStreamScopes,
  resolveStreamScopeSelection,
  scopeFieldsInputName,
  scopeSinceInputName,
  type StreamScopeSelection,
} from "../server/hosted-mcp-stream-scope.ts";
import { sourceDeclarationFromLegacyConnectorManifest } from "../server/source-declaration-legacy-collection.ts";
import { buildHostedMcpAuthorizationDetailForConnector } from "../server/routes/as-consent-ui-helpers.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/chatgpt";
const SOURCE_KEY = JSON.stringify([CONNECTOR_ID, ""]);

const MANIFEST = JSON.parse(
  readFileSync(`${import.meta.dirname}/../../packages/polyfill-connectors/manifests/chatgpt.json`, "utf8")
) as { streams: Array<Record<string, unknown> & { name: string }> };

const DECLARATION = sourceDeclarationFromLegacyConnectorManifest(MANIFEST as never, {
  connectorImplementationId: CONNECTOR_ID,
  declarationVersion: "1",
  publisherId: "https://registry.pdpp.dev",
  sourceId: CONNECTOR_ID,
});

function manifestStream(name: string) {
  const stream = MANIFEST.streams.find((candidate) => candidate.name === name);
  assert.ok(stream, `expected the real manifest to declare ${name}`);
  return stream;
}

/** Resolve a submitted form body into the scope map the route builds. */
function scopesFrom(body: Record<string, unknown>, streamNames: string[]): Map<string, StreamScopeSelection> {
  const submitted = parseSubmittedStreamScopes(body, SOURCE_KEY);
  const scopes = new Map<string, StreamScopeSelection>();
  for (const name of streamNames) {
    const entry = submitted.get(name);
    if (!entry) {
      continue;
    }
    const resolved = resolveStreamScopeSelection(manifestStream(name) as never, entry);
    assert.ok("selection" in resolved, `expected ${name} to resolve`);
    if (resolved.selection.fields || resolved.selection.timeRange) {
      scopes.set(name, resolved.selection);
    }
  }
  return scopes;
}

test("a narrowed submission reaches the issued grant stream", () => {
  const body = {
    [scopeFieldsInputName(SOURCE_KEY, "messages")]: ["content"],
    [scopeSinceInputName(SOURCE_KEY, "messages")]: "2026-03-01",
  };
  const detail = buildHostedMcpAuthorizationDetailForConnector(
    CONNECTOR_ID,
    ["messages"],
    "continuous",
    null,
    { id: CONNECTOR_ID, kind: "connector" },
    scopesFrom(body, ["messages"])
  );

  // The request the resolver will consume carries the narrowing.
  assert.deepEqual(detail.streams, [
    {
      fields: ["content", "conversation_id", "id"],
      name: "messages",
      time_range: { since: "2026-03-01T00:00:00.000Z" },
    },
  ]);

  const resolved = resolveCoreSelection({ streams: detail.streams }, DECLARATION);

  assert.equal(resolved.length, 1);
  // The consent floor survived: `id` and `conversation_id` are schema-required
  // (spec-core.md:764) and are present even though the owner checked only
  // `content`.
  assert.deepEqual(resolved[0]?.fields, ["content", "conversation_id", "id"]);
  // The grant carries `time_constraint` stamped with the manifest's own
  // consent_time_field — not the `time_range` the request used.
  assert.deepEqual(resolved[0]?.time_constraint, {
    field: "create_time",
    since: "2026-03-01T00:00:00.000Z",
  });
});

test("an unnarrowed submission still grants everything, unchanged", () => {
  // The default path must not regress: no scope inputs means the same detail
  // this flow produced before per-stream narrowing existed.
  const detail = buildHostedMcpAuthorizationDetailForConnector(
    CONNECTOR_ID,
    ["messages", "memories"],
    "continuous",
    null,
    { id: CONNECTOR_ID, kind: "connector" },
    scopesFrom({}, ["messages", "memories"])
  );

  assert.deepEqual(detail.streams, [{ name: "messages" }, { name: "memories" }]);

  const resolved = resolveCoreSelection({ streams: detail.streams }, DECLARATION);
  const messages = resolved.find((stream) => stream.name === "messages");

  assert.equal(messages?.time_constraint, undefined, "no bound requested, none applied");
  // Every declared field, which is what an omitted `fields` asks for.
  const declared = Object.keys((manifestStream("messages").schema as { properties: object }).properties).sort();
  assert.deepEqual(messages?.fields, declared);
});

test("narrowing one stream leaves its siblings untouched", () => {
  const body = { [scopeSinceInputName(SOURCE_KEY, "messages")]: "2026-03-01" };
  const detail = buildHostedMcpAuthorizationDetailForConnector(
    CONNECTOR_ID,
    ["messages", "memories"],
    "continuous",
    null,
    { id: CONNECTOR_ID, kind: "connector" },
    scopesFrom(body, ["messages", "memories"])
  );

  assert.deepEqual(detail.streams, [
    { name: "messages", time_range: { since: "2026-03-01T00:00:00.000Z" } },
    { name: "memories" },
  ]);
});

test("a pinned connection and a narrowed scope coexist on the same stream", () => {
  // instance_ids and the scope keys are set by different code paths; a
  // regression in either would silently drop the other.
  const body = { [scopeFieldsInputName(SOURCE_KEY, "messages")]: ["content"] };
  const detail = buildHostedMcpAuthorizationDetailForConnector(
    CONNECTOR_ID,
    ["messages"],
    "continuous",
    "conn_01HXYZ",
    { id: CONNECTOR_ID, kind: "connector" },
    scopesFrom(body, ["messages"])
  );

  assert.deepEqual(detail.streams, [
    {
      fields: ["content", "conversation_id", "id"],
      instance_ids: ["conn_01HXYZ"],
      name: "messages",
    },
  ]);
});

test("a wildcard selection carries no scope, and still resolves", () => {
  // There is no named stream to attach a scope to until the wildcard is
  // expanded against the retained snapshot.
  const detail = buildHostedMcpAuthorizationDetailForConnector(
    CONNECTOR_ID,
    null,
    "continuous",
    null,
    { id: CONNECTOR_ID, kind: "connector" },
    scopesFrom({ [scopeFieldsInputName(SOURCE_KEY, "messages")]: ["content"] }, [])
  );

  assert.deepEqual(detail.streams, [{ name: "*" }]);
  // The wildcard expands to every declared stream, as it did before.
  const resolved = resolveCoreSelection({ streams: detail.streams }, DECLARATION);
  assert.equal(resolved.length, MANIFEST.streams.length);
});

test("every real ChatGPT stream can be narrowed on both axes", () => {
  // Guards the premise of the feature against a manifest revision: if a
  // stream loses `selection.fields` or `consent_time_field`, the picker must
  // stop offering that control rather than 400 at issuance.
  for (const stream of MANIFEST.streams) {
    const body = {
      [scopeFieldsInputName(SOURCE_KEY, stream.name)]: [
        ...((stream.schema as { required?: string[] }).required ?? []),
      ],
      [scopeSinceInputName(SOURCE_KEY, stream.name)]: "2026-01-01",
    };
    const detail = buildHostedMcpAuthorizationDetailForConnector(
      CONNECTOR_ID,
      [stream.name],
      "continuous",
      null,
      { id: CONNECTOR_ID, kind: "connector" },
      scopesFrom(body, [stream.name])
    );
    const resolved = resolveCoreSelection({ streams: detail.streams }, DECLARATION);

    assert.equal(resolved.length, 1, stream.name);
    assert.equal(
      resolved[0]?.time_constraint?.field,
      stream.consent_time_field,
      `${stream.name} must bind its own consent_time_field`
    );
    assert.ok((resolved[0]?.fields?.length ?? 0) > 0, `${stream.name} must resolve a non-empty field list`);
  }
});

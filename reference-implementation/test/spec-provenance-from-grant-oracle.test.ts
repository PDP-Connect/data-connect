// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Spec oracle — provenance is derived by the AS and read back from the issued grant.
 *
 * Exercises spec-core.md (pdpp `spec/int0902-12v3-source-kind-request-field`):
 *
 *   "A selection request does not carry `source.kind`. The authorization server
 *    derives the provenance class from the declaration it accepted for
 *    `source.id`, and records it in consent evidence and any issued grant, where
 *    a client reads it back through introspection."
 *
 * and the request-parameter row for `source`:
 *
 *   "A request carries `id` alone: provenance is derived by the authorization
 *    server from the accepted declaration, not asserted by the client."
 *
 * The interoperability claim this pins down is that a client with a
 * provenance-sensitive policy can evaluate that policy from the issued grant
 * before it touches any resource, across both provenance classes the spec
 * defines (`connector` and `provider_native`). Existing coverage
 * (b3-introspection-resources-conformance.test.ts) only ever asserts
 * `kind === "connector"`, and always sends `kind` in the request, so neither the
 * id-only request shape nor the `provider_native` class is covered today.
 *
 * A real server on ephemeral ports with in-memory SQLite; no mocks of the server
 * under test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Database from "better-sqlite3";
import { seedPreRegisteredClients } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { basicIntrospectionAuthorization } from "../server/introspection-http.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { createSqliteAcceptedSourceDeclarationRevisionStore } from "../server/source-declaration-trust/revision-store.ts";
import { retrieveAndAcceptProviderNativeDeclaration } from "../server/source-declaration-trust/service.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import {
  TEST_INTROSPECTION_SERVER_OPTS,
  TEST_RS_INTROSPECTION_CREDENTIALS,
} from "./helpers/introspection-test-credentials.ts";

const CONNECTOR_SOURCE_ID = "https://registry.pdpp.dev/connectors/spotify";
const NATIVE_POINTER = "https://declarations.example.test/northstar/current.json";
const NATIVE_AUTHORITY = "metadata:https://northstar.example/pdpp";
const CLIENT_ID = "provenance_oracle_client";
const UNKNOWN_SOURCE_RE = /Unknown source/;
const INTROSPECTION_AUTHORIZATION = basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS);

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http servers, so `closeAllConnections` and the
// single-argument `close` callback genuinely exist. Same pattern as
// b3-introspection-resources-conformance.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: {
    close: (cb: (err?: Error) => void) => void;
    closeAllConnections: () => void;
  };
  rsServer: {
    close: (cb: (err?: Error) => void) => void;
    closeAllConnections: () => void;
  };
};

interface JsonResult {
  body: Record<string, unknown>;
  status: number;
}

interface ValidatedTestDeclaration extends Record<string, unknown> {
  declaration_version: string;
  source: { id: string; kind: string };
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResult> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
    method: "POST",
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — surface it verbatim so assertion messages stay readable.
  }
  return {
    body: (parsed ?? {}) as Record<string, unknown>,
    status: response.status,
  };
}

function streamBody(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function readManifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/seed-manifests/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * A connector-backed grant needs an eligible connector instance before consent
 * can resolve any stream. Mirrors `seedDefaultGrantInstance` in the b3 test.
 */
async function seedDefaultGrantInstance(connectorId: string, ownerSubjectId: string): Promise<void> {
  const store = createRequestConnectorInstanceStore();
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorKey);
  if (await store.get(connectorInstanceId)) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId,
    sourceBinding: { fixture: "provenance-oracle-default-account" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

/**
 * Stage a PAR request carrying `source: { id }` with no `kind`, approve it, and
 * return the issued token plus grant. Fails loudly at whichever step rejects, so
 * a regression names the step rather than surfacing as a downstream type error.
 */
async function issueGrantFromIdOnlyRequest(
  asUrl: string,
  subjectId: string,
  params: { purposeCode: string; sourceId: string; streamName: string }
): Promise<{ grant: Record<string, unknown>; token: string }> {
  const par = await jsonPost(`${asUrl}/oauth/par`, {
    authorization_details: [
      {
        access_mode: "continuous",
        purpose_code: params.purposeCode,
        purpose_description: "Provenance-from-grant oracle",
        // The spec sentence under test: no `kind` key at all.
        source: { id: params.sourceId },
        streams: [{ name: params.streamName }],
        type: "https://pdpp.dev/data-access",
      },
    ],
    client_id: CLIENT_ID,
  });
  assert.equal(par.status, 201, `PAR must accept an id-only source binding: ${JSON.stringify(par.body)}`);

  const review = await jsonPost(`${asUrl}/consent/review`, {
    request_uri: par.body.request_uri,
    subject_id: subjectId,
  });
  assert.equal(review.status, 200, `consent review: ${JSON.stringify(review.body)}`);

  const approved = await jsonPost(`${asUrl}/consent/approve`, {
    approval_review_revision: review.body.approval_review_revision,
    request_uri: par.body.request_uri,
  });
  assert.equal(approved.status, 200, `consent approve: ${JSON.stringify(approved.body)}`);
  return {
    grant: approved.body.grant as Record<string, unknown>,
    token: approved.body.token as string,
  };
}

interface IntrospectedDetail {
  source?: { id?: string; kind?: string };
}

/** The single RFC 9396 authorization detail the AS projects for a one-source grant. */
function soleAuthorizationDetail(introspection: Record<string, unknown>): IntrospectedDetail {
  const details = introspection.authorization_details as IntrospectedDetail[] | undefined;
  assert.ok(Array.isArray(details), "introspection projects authorization_details");
  const [detail] = details;
  assert.ok(detail, "introspection projects one authorization detail");
  return detail;
}

async function introspect(asUrl: string, token: string): Promise<JsonResult> {
  return await jsonPost(`${asUrl}/introspect`, { token }, { Authorization: INTROSPECTION_AUTHORIZATION });
}

/**
 * The client-side half of the interoperability claim: a provenance-sensitive
 * policy that reads `kind` out of the introspected grant and refuses to proceed
 * when it is absent or unexpected. This deliberately consults only the grant —
 * it never reads a resource, and never consults the request the client sent.
 */
function provenancePolicyDecision(
  introspection: Record<string, unknown>,
  allowedKinds: readonly string[]
): { allowed: boolean; observedKind: string | null } {
  const pdpp = introspection.pdpp as { source?: { kind?: unknown } } | undefined;
  const observed = typeof pdpp?.source?.kind === "string" ? pdpp.source.kind : null;
  return {
    allowed: observed !== null && allowedKinds.includes(observed),
    observedKind: observed,
  };
}

test("provenance oracle: a connector grant carries derived provenance from an id-only request", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const subjectId = "provenance_connector_owner";
  try {
    const manifest = readManifest("spotify.json");
    const registration = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registration.status, 201, "register the spotify connector");
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        client_name: "Provenance oracle",
        registration_mode: "pre_registered_public",
      },
    ]);
    await seedDefaultGrantInstance(manifest.connector_id as string, subjectId);

    const { grant, token } = await issueGrantFromIdOnlyRequest(asUrl, subjectId, {
      purposeCode: "https://pdpp.dev/purpose/personalization",
      sourceId: CONNECTOR_SOURCE_ID,
      streamName: "top_artists",
    });

    // The AS derived the class the client never asserted, and recorded it on the grant.
    assert.deepEqual(
      grant.source,
      { id: CONNECTOR_SOURCE_ID, kind: "connector" },
      "issued grant records the derived connector provenance"
    );

    const introspection = await introspect(asUrl, token);
    assert.equal(introspection.status, 200, "introspection succeeds");
    assert.equal(introspection.body.active, true, "issued token is active");

    const detail = soleAuthorizationDetail(introspection.body);
    assert.equal(detail.source?.kind, "connector", "authorization_details carries the derived provenance");
    assert.equal(detail.source?.id, CONNECTOR_SOURCE_ID, "authorization_details carries the requested source id");

    // A client reads provenance back through introspection and decides *before*
    // any resource read. The RS call below only proves the ordering is real:
    // the decision above did not need it.
    const decision = provenancePolicyDecision(introspection.body, ["connector"]);
    assert.equal(decision.observedKind, "connector", "policy observes the connector class from the grant");
    assert.equal(decision.allowed, true, "a connector-accepting policy admits this grant");

    const denial = provenancePolicyDecision(introspection.body, ["provider_native"]);
    assert.equal(denial.allowed, false, "a provider-native-only policy refuses this grant from the grant alone");

    const records = await fetch(
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(manifest.connector_id as string)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(records.status, 200, "first resource use happens only after the provenance decision");
  } finally {
    await closeServer(server);
  }
});

test("provenance oracle: a provider-native grant carries derived provenance from an id-only request", async () => {
  const revisionDatabase = new Database(":memory:");
  const revisionStore = createSqliteAcceptedSourceDeclarationRevisionStore(revisionDatabase);
  const nativeManifest = readManifest("northstar-hr.json");
  const declaration = structuredClone(nativeManifest.source_declaration) as ValidatedTestDeclaration;
  declaration.declaration_version = "provenance-oracle:northstar:a";
  const sourceId = declaration.source.id;

  const accepted = await retrieveAndAcceptProviderNativeDeclaration(
    {
      acceptedPointer: NATIVE_POINTER,
      authorityBinding: NATIVE_AUTHORITY,
      expectedSourceId: sourceId,
    },
    {
      fetch: () =>
        Promise.resolve({
          body: streamBody(JSON.stringify(declaration)),
          status: 200,
        }),
      resolveDns: () => Promise.resolve(["203.0.113.4"]),
      revisionStore,
      validateAddress: () => Promise.resolve(true),
      validateDeclaration: (value: unknown) => ({
        declaration: value as typeof declaration,
        ok: true as const,
      }),
    },
    { maxAddresses: 4, maxBytes: 65_536, maxRedirects: 1, timeoutMs: 1000 }
  );
  assert.equal(accepted.ok, true, "the provider-native declaration is accepted before any request");
  if (!accepted.ok) {
    assert.fail("provider-native declaration was not accepted");
  }

  const server = (await startServer({
    acceptedProviderNativeRevision: {
      acceptedRevisionReference: accepted.acceptedRevisionReference,
      revisionStore,
      sourceId,
    },
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest: { ...nativeManifest, source_declaration: declaration },
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        client_name: "Provenance oracle",
        registration_mode: "pre_registered_public",
      },
    ]);

    const { grant, token } = await issueGrantFromIdOnlyRequest(asUrl, "owner_local", {
      purposeCode: "https://pdpp.dev/purpose/financial_planning",
      sourceId,
      streamName: "pay_statements",
    });

    // The class the AS derived here is the one it accepted for this source id —
    // not the `"connector"` fallback that the derivation chain ends in.
    assert.deepEqual(
      grant.source,
      { id: sourceId, kind: "provider_native" },
      "issued grant records the derived provider-native provenance"
    );

    const introspection = await introspect(asUrl, token);
    assert.equal(introspection.status, 200, "introspection succeeds");
    assert.equal(introspection.body.active, true, "issued token is active");

    const detail = soleAuthorizationDetail(introspection.body);
    assert.equal(detail.source?.kind, "provider_native", "authorization_details carries the derived provenance");
    assert.equal(detail.source?.id, sourceId, "authorization_details carries the requested source id");

    const decision = provenancePolicyDecision(introspection.body, ["provider_native"]);
    assert.equal(decision.observedKind, "provider_native", "policy observes the provider-native class from the grant");
    assert.equal(decision.allowed, true, "a provider-native-accepting policy admits this grant");

    const denial = provenancePolicyDecision(introspection.body, ["connector"]);
    assert.equal(denial.allowed, false, "a connector-only policy refuses this grant from the grant alone");
  } finally {
    await closeServer(server);
    revisionDatabase.close();
  }
});

test("provenance oracle: an unresolvable source id is refused rather than defaulted to connector", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        client_name: "Provenance oracle",
        registration_mode: "pre_registered_public",
      },
    ]);

    // No declaration was ever accepted for this id, so there is no provenance to
    // derive. Deriving one anyway — the `|| "connector"` tail of the derivation
    // chain in `resolveAuthorizationDetailBindings` — would record a provenance
    // the AS never accepted, which is exactly what a provenance-sensitive client
    // policy would then rely on.
    const par = await jsonPost(`${asUrl}/oauth/par`, {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: "https://unknown.example/never-declared" },
          streams: [{ name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    });
    assert.equal(par.status, 400, `an undeclared source must not yield a grant: ${JSON.stringify(par.body)}`);
    const error = par.body.error as { message?: string } | undefined;
    assert.match(
      String(error?.message ?? ""),
      UNKNOWN_SOURCE_RE,
      "the refusal names the unresolvable source rather than defaulting its provenance"
    );
  } finally {
    await closeServer(server);
  }
});

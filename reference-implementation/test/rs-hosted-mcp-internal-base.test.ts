// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// F1 wiring regression — the hosted-MCP package adapter must forward its
// child-grant self-calls to the configured INTERNAL resource-server base,
// while the advertised `resource`, discovery metadata, and
// `mcpServerOptions.providerUrl` stay the PUBLIC origin.
//
// Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
//
// Background (F1): `handleHostedMcp` built the child RsClient fetch base from
// `resolvePublicUrl(...)` (the public origin). Server-internal self-calls could
// therefore hairpin through an external edge with a narrower method policy.
// The fix passes the EXPLICITLY-configured internal base (`opts.rsInternalUrl`
// or the operator's `PDPP_RS_URL`, plumbed by `startServer` — NOT the bare
// `referenceTopology` default `http://localhost:7663`, which is intentionally
// skipped) to `createPackageProfile` as the child fetch base, falling back to
// the public resource when no internal base is configured. Advertised identity
// stays public. (`INTERNAL_BASE` below is an explicitly-configured value, as a
// real deployment's `PDPP_RS_URL` would be.)
//
// This test drives `handleHostedMcp` through `mountRsHostedMcp` against a
// hand-built fake app + context. It captures the `providerUrl` that reaches
// `createPackageProfile` and the `providerUrl` advertised on
// `mcpServerOptions`. PRE-fix both equal the public resource (this test fails
// on `assertEqual(internal)`); POST-fix the child base is the internal base
// and the advertised value remains public.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { GrantPackageAccess, GrantPackageMember, MountRsHostedMcpContext } from "../server/routes/rs-hosted-mcp.ts";
import { mountRsHostedMcp } from "../server/routes/rs-hosted-mcp.ts";

type RouteHandler = (req: unknown, res: unknown) => unknown | Promise<unknown>;
type HostedMcpApp = Parameters<typeof mountRsHostedMcp>[0];
interface FakeApp extends HostedMcpApp {
  routes: Record<string, RouteHandler[]>;
}

const PUBLIC_RESOURCE = "https://pdpp.test"; // advertised; edge 405s PATCH
const INTERNAL_BASE = "http://localhost:7663"; // configured internal RS base

// Minimal fake app that records the handlers mounted for each verb so the test
// can invoke the final handler (`handleHostedMcp`) directly, skipping the auth
// middleware chain (auth posture is exercised by hosted-mcp-oauth.test.js).
function makeFakeApp(): FakeApp {
  const routes: Record<string, RouteHandler[]> = {};
  const register =
    (verb: string): HostedMcpApp["get"] =>
    (path, ...handlers) => {
      routes[`${verb} ${path}`] = handlers as unknown as RouteHandler[];
      return app;
    };
  const app: FakeApp = { delete: register("delete"), get: register("get"), post: register("post"), routes };
  return app;
}

// Minimal shape rs-hosted-mcp.ts consumes for a request's `get`/`headers` etc.
interface FakeRequest {
  body?: unknown;
  get: (name: string) => string | undefined;
  headers: Record<string, string>;
  method: string;
  path: string;
  protocol: string;
  raw: { url: string };
  tokenInfo: { grant_id?: string; grant_package_id?: string; pdpp_token_kind: string };
}

interface FakeResponse {
  end: () => void;
  headers: Record<string, string>;
  locals: Record<string, unknown>;
  send: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => FakeResponse;
  statusCode: number | null;
  payload?: unknown;
}

// Fake request mirroring the shape rs-hosted-mcp.ts consumes. With a
// non-loopback `explicitResource` and no x-forwarded-* headers, resolvePublicUrl
// returns the explicit URL verbatim — a deterministic public origin.
function makePackageRequest(body?: unknown): FakeRequest {
  return {
    ...(body === undefined ? {} : { body }),
    get(name: string) {
      const lc = name.toLowerCase();
      return lc === "host" ? "pdpp.test" : undefined;
    },
    headers: { authorization: "Bearer pkg_inbound_token", host: "pdpp.test" },
    method: "POST",
    path: "/mcp",
    protocol: "https",
    raw: { url: "/mcp" },
    tokenInfo: { grant_package_id: "gp_1", pdpp_token_kind: "mcp_package" },
  };
}

// Single-grant (`client`-token) request — exercises the `else` branch.
function makeClientRequest(): FakeRequest {
  return {
    get(name: string) {
      const lc = name.toLowerCase();
      return lc === "host" ? "pdpp.test" : undefined;
    },
    headers: { authorization: "Bearer client_inbound_token", host: "pdpp.test" },
    method: "POST",
    path: "/mcp",
    protocol: "https",
    raw: { url: "/mcp" },
    tokenInfo: { grant_id: "grant_single", pdpp_token_kind: "client" },
  };
}

function makeFakeResponse(): FakeResponse {
  return {
    end() {
      /* intentionally empty */
    },
    headers: {},
    locals: {
      protectedResourceMetadataUrl: `${PUBLIC_RESOURCE}/.well-known/oauth-protected-resource/mcp`,
    },
    send(body) {
      this.payload = body;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    statusCode: null,
  };
}

interface Seen {
  advertisedProviderUrl: string | null;
  childProviderUrl: string | null;
  packageStatusCode: number | null;
  receivedMembers: readonly GrantPackageMember[] | null;
  singleGrantProviderUrl: string | null;
}

// Build a context whose `createPackageProfile` records the providerUrl it
// receives, and whose `handleStreamableHttpRequest` records the providerUrl it
// is advertised. `internalResource` is the fix's injected internal base.
function packageAccess(active = true): GrantPackageAccess {
  return {
    members: ["grant_A", "grant_B"].map((grant_id, index) => ({
      access_mode: "continuous",
      active: index === 0 ? active : false,
      connection_id: `pairwise-${grant_id}`,
      grant: {
        purpose: "personal records",
        streams: [{ name: "notes", instance_ids: [`pairwise-${grant_id}`] }],
      },
      grant_id,
      package_id: "package_public",
      source: {
        connection_id: `pairwise-${grant_id}`,
        display_name: `Source ${index}`,
        id: `source-${index}`,
        kind: "connector" as const,
      },
      token: `child-token-${index}`,
    })),
    package: { package_id: "package_public" },
  };
}

function makeContext({ internalResource, active = true, legacy = false, packageOverride }: { internalResource: string | null | undefined; active?: boolean; legacy?: boolean; packageOverride?: unknown }): {
  ctx: MountRsHostedMcpContext;
  seen: Seen;
} {
  const seen: Seen = {
    advertisedProviderUrl: null,
    childProviderUrl: null,
    packageStatusCode: null,
    receivedMembers: null,
    singleGrantProviderUrl: null,
  };
  return {
    ctx: {
      createPackageProfile({ members, providerUrl }) {
        seen.childProviderUrl = providerUrl;
        seen.receivedMembers = members;
        return { __fakePackageProfile: true };
      },
      createRsClient({ providerUrl }) {
        seen.singleGrantProviderUrl = providerUrl;
        return { __fakeRsClient: true };
      },
      dispatchApp: {
        async inject() {
          return { headers: {}, payload: "{}", statusCode: 200 };
        },
      },
      explicitResource: PUBLIC_RESOURCE,
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async getGrantPackageAccess() {
        const frozen = packageAccess(active);
        if (packageOverride !== undefined) return packageOverride as GrantPackageAccess;
        if (!legacy) return frozen;
        return {
          ...frozen,
          members: frozen.members.map((member) => ({
            connection_id: member.connection_id,
            grant: { ...member.grant, access_mode: member.access_mode },
            grant_id: member.grant_id,
            package_id: member.package_id,
            source: member.source,
            token: member.token,
          })),
        };
      },
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async handleStreamableHttpRequest(_request, options) {
        seen.advertisedProviderUrl = options.providerUrl;
        return new Response("{}", { headers: { "content-type": "application/json" }, status: 200 });
      },
      // `exactOptionalPropertyTypes` forbids assigning `undefined` directly to
      // an optional `string | null` property; spread the key in only when a
      // value (including explicit `undefined` from the fallback test) needs
      // representing, matching the "key omitted" shape the fallback exercises.
      ...(internalResource === undefined ? {} : { internalResource }),
      pdppError(res, status, code, message) {
        res.status(status).send({ error: { code, message } });
      },
      referenceRevision: "test-rev",
      requireClientOrMcpPackage: (_req, _res, next) => next(),
      requireToken: (_req, _res, next) => next(),
      trustedMetadataHosts: null,
    },
    seen,
  };
}

async function driveHandler({
  internalResource,
  legacy = false,
  makeRequest = makePackageRequest,
}: {
  internalResource: string | null | undefined;
  legacy?: boolean;
  makeRequest?: () => FakeRequest;
}): Promise<Seen> {
  const app = makeFakeApp();
  const { ctx, seen } = makeContext({ internalResource, legacy });
  mountRsHostedMcp(app, ctx);
  // The handler is the last entry in the mounted chain for POST /mcp.
  const chain = app.routes["post /mcp"];
  assert.ok(chain, "post /mcp route must be mounted");
  const handler = chain.at(-1);
  assert.ok(handler, "post /mcp handler chain must not be empty");
  const res = makeFakeResponse();
  await handler(makeRequest(), res);
  seen.packageStatusCode = res.statusCode;
  return seen;
}

test("F1 wiring: package adapter forwards child self-calls to the internal base; advertised stays public", async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE });
  // Child RsClient fetch base is the INTERNAL base (the fix).
  assert.equal(seen.childProviderUrl, INTERNAL_BASE, "child RsClient fetch base must be the internal RS base");
  // Advertised providerUrl on the MCP server stays the PUBLIC origin.
  assert.equal(seen.advertisedProviderUrl, PUBLIC_RESOURCE, "advertised providerUrl must remain the public origin");
});

test("F1 wiring fallback: with no internal base configured, child self-calls fall back to the public resource", async () => {
  const seenNull = await driveHandler({ internalResource: null });
  assert.equal(
    seenNull.childProviderUrl,
    PUBLIC_RESOURCE,
    "fallback: child base is the public resource when internal base is unset"
  );
  assert.equal(
    seenNull.advertisedProviderUrl,
    PUBLIC_RESOURCE,
    "advertised providerUrl remains public in the fallback path"
  );

  const seenUndef = await driveHandler({ internalResource: undefined });
  assert.equal(
    seenUndef.childProviderUrl,
    PUBLIC_RESOURCE,
    "fallback: undefined internal base also yields the public resource"
  );
});

test("hosted adapter normalizes the current legacy package-member shape", async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE, legacy: true });
  assert.equal(seen.packageStatusCode, 200);
  assert.deepEqual(
    seen.receivedMembers?.map(({ grant_id, access_mode, active, connection_id, source }) => ({
      access_mode,
      active,
      connection_id,
      grant_id,
      sourceConnectionId: source?.connection_id,
    })),
    [
      {
        access_mode: "continuous",
        active: true,
        connection_id: "pairwise-grant_A",
        grant_id: "grant_A",
        sourceConnectionId: "pairwise-grant_A",
      },
      {
        access_mode: "continuous",
        active: true,
        connection_id: "pairwise-grant_B",
        grant_id: "grant_B",
        sourceConnectionId: "pairwise-grant_B",
      },
    ],
  );
});

test("hosted adapter preserves explicit active and inactive members from the frozen shape", async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE });
  assert.deepEqual(
    seen.receivedMembers?.map(({ grant_id, active }) => ({ grant_id, active })),
    [
      { grant_id: "grant_A", active: true },
      { grant_id: "grant_B", active: false },
    ],
  );
  assert.equal(seen.packageStatusCode, 200, "one active child keeps the package MCP endpoint available");
});

test("hosted adapter rejects a package when every frozen member is inactive", async () => {
  const app = makeFakeApp();
  const { ctx, seen } = makeContext({ internalResource: INTERNAL_BASE, active: false });
  mountRsHostedMcp(app, ctx);
  const handler = app.routes["post /mcp"]?.at(-1);
  assert.ok(handler);
  const res = makeFakeResponse();
  await handler(makePackageRequest(), res);
  assert.equal(res.statusCode, 401);
  const challenge = Object.entries(res.headers).find(([name]) => name.toLowerCase() === "www-authenticate")?.[1];
  assert.match(challenge ?? "", /Bearer error="invalid_token"/);
  assert.equal(seen.receivedMembers, null, "inactive package never constructs an MCP profile");
});

test("hosted adapter fails closed on malformed package-member lists", async (t) => {
  const base = packageAccess(true);
  const [first, second] = base.members;
  assert.ok(first && second);
  const legacyFirst = {
    ...first,
    grant: { ...first.grant, access_mode: first.access_mode },
  } as Record<string, unknown>;
  delete legacyFirst.active;
  delete legacyFirst.access_mode;
  const missingGrantId = { ...first } as Record<string, unknown>;
  delete missingGrantId.grant_id;

  const cases: Array<[string, unknown]> = [
    ["mixed legacy and frozen shapes", { ...base, members: [legacyFirst, second] }],
    ["conflicting member and grant access modes", {
      ...base,
      members: [{ ...first, grant: { ...first.grant, access_mode: "snapshot" } }, second],
    }],
    ["active null", { ...base, members: [{ ...first, active: null }, second] }],
    ["duplicate grant ids", { ...base, members: [first, { ...second, grant_id: first.grant_id }] }],
    ["missing grant id", { ...base, members: [missingGrantId, second] }],
    ["non-boolean active", { ...base, members: [{ ...first, active: "true" }, second] }],
  ];

  for (const [label, packageOverride] of cases) {
    await t.test(label, async () => {
      const app = makeFakeApp();
      const { ctx, seen } = makeContext({ internalResource: INTERNAL_BASE, packageOverride });
      mountRsHostedMcp(app, ctx);
      const handler = app.routes["post /mcp"]?.at(-1);
      assert.ok(handler);
      for (const body of [
        { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "list_package_children" } },
        { id: 2, jsonrpc: "2.0", method: "tools/call", params: { arguments: { grant_id: "grant_A" }, name: "schema" } },
      ]) {
        const res = makeFakeResponse();
        await handler(makePackageRequest(body), res);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.payload, {
          error: { code: "api_error", message: "Unable to resolve package access" },
        });
      }
      assert.equal(seen.receivedMembers, null, "malformed members never reach the data adapter");
      assert.equal(seen.advertisedProviderUrl, null, "malformed members never reach MCP dispatch");
    });
  }
});

test("F1 wiring (single-grant): client-token self-calls use the internal base; advertised stays public", async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE, makeRequest: makeClientRequest });
  // The single-grant RsClient uses the INTERNAL base for its provider URL.
  assert.equal(
    seen.singleGrantProviderUrl,
    INTERNAL_BASE,
    "single-grant RsClient fetch base must be the internal RS base"
  );
  // Advertised providerUrl on the MCP server stays the PUBLIC origin.
  assert.equal(
    seen.advertisedProviderUrl,
    PUBLIC_RESOURCE,
    "advertised providerUrl must remain the public origin (single-grant)"
  );
  // The package-only recorder was not touched on the client path.
  assert.equal(seen.childProviderUrl, null, "package createPackageProfile must not be invoked for a client token");
});

test("F1 wiring (single-grant) fallback: no internal base → client self-calls use the public resource", async () => {
  const seen = await driveHandler({ internalResource: null, makeRequest: makeClientRequest });
  assert.equal(
    seen.singleGrantProviderUrl,
    PUBLIC_RESOURCE,
    "fallback: single-grant base is the public resource when internal base is unset"
  );
  assert.equal(
    seen.advertisedProviderUrl,
    PUBLIC_RESOURCE,
    "advertised providerUrl remains public in the single-grant fallback"
  );
});

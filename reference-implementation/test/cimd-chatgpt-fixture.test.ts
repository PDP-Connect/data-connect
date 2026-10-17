// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CIMD handling proven against ChatGPT's real client-metadata document.
 *
 * `cimd.test.ts` covers the draft's rules with synthetic documents. This file
 * covers the same rules with the actual bytes ChatGPT serves, captured once
 * from `https://chatgpt.com/oauth/Dyp26IIu2iQg/client.json?token_endpoint_auth_method=none`
 * and stored at `fixtures/chatgpt-client-metadata-document.json`. The
 * distinction matters because the live document has a property no synthetic
 * fixture in the suite had: **its `client_id` carries a query string**, and
 * it is the query-bearing form that must match byte-for-byte. A comparison
 * that normalized URLs, compared origins, or dropped the query would pass
 * every synthetic test here and still reject the one real client we care
 * about — or worse, accept a document that named a different client_id.
 *
 * The fixture is a snapshot, not a live fetch: the suite must not depend on
 * chatgpt.com being reachable, and a third party must not be able to change
 * what our tests assert by editing their document.
 *
 * These tests assert the identity chain end to end — fetch, byte-exact
 * client_id match, redirect_uri membership, and the resulting trust decision
 * — so that "ChatGPT shows up as a verified domain with its real name" is a
 * property under test rather than something observed once in a browser.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CIMD_MAX_BODY_BYTES,
  buildCimdRegisteredClient,
  type FetchCimdOptions,
  type FetchCimdResult,
  fetchCimdDocument,
  invalidateCimdCache,
  isCimdClientId,
  validateCimdRedirectUris,
  validateCimdUrl,
} from "../server/cimd.ts";
import {
  isLogoFetchAllowed,
  resolveClientTrust,
} from "../server/client-trust-registry.ts";
import { requireRegisteredRedirectUri } from "../server/routes/as-consent-ui-helpers.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/chatgpt-client-metadata-document.json", import.meta.url));
const RAW_FIXTURE = readFileSync(FIXTURE_PATH, "utf8");
const CHATGPT_DOC = JSON.parse(RAW_FIXTURE) as Record<string, unknown>;
const CHATGPT_CLIENT_ID = CHATGPT_DOC.client_id as string;
const CHATGPT_REDIRECT_URI = (CHATGPT_DOC.redirect_uris as string[])[0] as string;

const publicDns: NonNullable<FetchCimdOptions["dnsLookupImpl"]> = () => Promise.resolve([{ address: "93.184.216.34" }]);

function fetchCimd(clientId: string, options: FetchCimdOptions): Promise<FetchCimdResult> {
  return fetchCimdDocument(clientId, options);
}

/** Serve a body as chatgpt.com would, so only the document content varies. */
function serve(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

/** Each test starts from a cold cache; `fetchCimdDocument` caches by client_id. */
function freshFetch(clientId: string, options: FetchCimdOptions): Promise<FetchCimdResult> {
  invalidateCimdCache(clientId);
  return fetchCimd(clientId, options);
}

test("the captured fixture is the real document shape, query string and all", () => {
  // Guards the premise of every test below: if the fixture is ever re-captured
  // and loses these properties, the suite should say so rather than silently
  // testing something weaker.
  assert.equal(isCimdClientId(CHATGPT_CLIENT_ID), true);
  assert.equal(new URL(CHATGPT_CLIENT_ID).search, "?token_endpoint_auth_method=none");
  assert.equal(CHATGPT_DOC.client_name, "ChatGPT");
  assert.equal(CHATGPT_DOC.token_endpoint_auth_method, "none");
  assert.ok(RAW_FIXTURE.length < CIMD_MAX_BODY_BYTES, "the real document fits well inside the size cap");
  // No policy_uri or tos_uri: ChatGPT publishes neither, so the consent
  // surface has nothing to link and must not invent it.
  assert.equal(CHATGPT_DOC.policy_uri, undefined);
  assert.equal(CHATGPT_DOC.tos_uri, undefined);
  // The URL passes the pre-fetch safety checks unchanged.
  validateCimdUrl(CHATGPT_CLIENT_ID);
});

test("the real document resolves to a domain-verified ChatGPT identity", async () => {
  const result = await freshFetch(CHATGPT_CLIENT_ID, {
    dnsLookupImpl: publicDns,
    fetchImpl: async () => serve(RAW_FIXTURE),
  });

  assert.equal(result.doc.client_id, CHATGPT_CLIENT_ID);
  assert.equal(result.doc.client_name, "ChatGPT");

  const client = buildCimdRegisteredClient(CHATGPT_CLIENT_ID, result.doc);
  assert.equal(client.registration_mode, "client_id_metadata_document");
  assert.equal(client.metadata.client_name, "ChatGPT");

  const trust = resolveClientTrust(client);
  assert.equal(trust.isTrusted, true);
  assert.equal(trust.basis, "domain_verified");
  // The proven claim, and only the proven claim.
  assert.equal(trust.verifiedDomain, "chatgpt.com");
});

test("the request redirect_uri must be one the document lists", async () => {
  const result = await freshFetch(CHATGPT_CLIENT_ID, {
    dnsLookupImpl: publicDns,
    fetchImpl: async () => serve(RAW_FIXTURE),
  });
  const client = buildCimdRegisteredClient(CHATGPT_CLIENT_ID, result.doc);

  // The real callback is accepted.
  requireRegisteredRedirectUri(client, CHATGPT_REDIRECT_URI);

  // An attacker-supplied callback on the same origin is not, even though the
  // origin itself is the verified one — membership is the rule, not origin.
  assert.throws(
    () => requireRegisteredRedirectUri(client, "https://chatgpt.com/connector/oauth/attacker"),
    /does not match a registered redirect URI/
  );
  assert.throws(
    () => requireRegisteredRedirectUri(client, "https://evil.example/callback"),
    /does not match a registered redirect URI/
  );
});

test("a document naming a different client_id is rejected, query string included", async () => {
  // The document is otherwise byte-identical and served from the right URL;
  // only the client_id inside it differs, by exactly its query string. This is
  // the case a URL-normalizing comparison would wrongly accept.
  const withoutQuery = CHATGPT_CLIENT_ID.split("?")[0] as string;
  const tampered = JSON.stringify({ ...CHATGPT_DOC, client_id: withoutQuery });

  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl: async () => serve(tampered) }),
    /client_id mismatch/
  );
});

test("a document claiming someone else's client_id is rejected", async () => {
  const impostor = JSON.stringify({ ...CHATGPT_DOC, client_id: "https://evil.example/client.json" });

  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl: async () => serve(impostor) }),
    /client_id mismatch/
  );
});

test("a document listing an off-origin redirect_uri is rejected at fetch time", async () => {
  // Defence in depth ahead of the per-request membership check: a document
  // that points its callbacks at another origin never becomes a client at all.
  const offOrigin = JSON.stringify({
    ...CHATGPT_DOC,
    redirect_uris: ["https://evil.example/steal"],
  });

  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl: async () => serve(offOrigin) }),
    /does not share origin/
  );
  // The same rule, applied directly to the parsed document.
  assert.throws(
    () => validateCimdRedirectUris({ redirect_uris: ["https://evil.example/steal"] }, CHATGPT_CLIENT_ID),
    /does not share origin/
  );
});

test("an unreachable document yields no client, so the surface falls back to unverified", async () => {
  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, {
      dnsLookupImpl: publicDns,
      fetchImpl: async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { code: "ENOTFOUND" })),
    }),
    /CIMD fetch failed/
  );

  // With no document there is no CIMD registration mode, so trust resolution
  // returns the unverified state the monogram path renders.
  const trust = resolveClientTrust({ client_id: CHATGPT_CLIENT_ID, registration_mode: "pre_registered_public" });
  assert.equal(trust.isTrusted, false);
  assert.equal(trust.verifiedDomain, null);
});

test("a 404 or a redirect is treated as unreachable rather than followed", async () => {
  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl: async () => serve("{}", { status: 404 }) }),
    /returned 404/
  );

  // Following a redirect would let the document be served from a host the
  // client never proved control of.
  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, {
      dnsLookupImpl: publicDns,
      fetchImpl: async () =>
        new Response("", { headers: { Location: "https://evil.example/client.json" }, status: 302 }),
    }),
    /rejected redirect/
  );
});

test("an oversized document is refused rather than parsed", async () => {
  // A real client_name padded past the cap: the failure must come from the
  // size guard, before any of the document is trusted.
  const oversized = JSON.stringify({ ...CHATGPT_DOC, client_name: "C".repeat(CIMD_MAX_BODY_BYTES + 1) });

  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl: async () => serve(oversized) }),
    /exceeds 5 KB size limit/
  );
});

test("a slow document is abandoned on the timeout, not awaited indefinitely", async () => {
  await assert.rejects(
    freshFetch(CHATGPT_CLIENT_ID, {
      dnsLookupImpl: publicDns,
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          // Mirror what a real fetch does when the caller aborts it.
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }))
          );
        }),
    }),
    /CIMD fetch failed/
  );
});

test("the second resolution is served from cache rather than refetched", async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return serve(RAW_FIXTURE);
  };

  const first = await freshFetch(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl });
  const second = await fetchCimd(CHATGPT_CLIENT_ID, { dnsLookupImpl: publicDns, fetchImpl });

  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(fetches, 1, "a consent render must not refetch the client's document every time");
});

test("ChatGPT's domain-verified metadata logo is eligible for the approved cache", async () => {
  const result = await freshFetch(CHATGPT_CLIENT_ID, {
    dnsLookupImpl: publicDns,
    fetchImpl: async () => serve(RAW_FIXTURE),
  });
  const client = buildCimdRegisteredClient(CHATGPT_CLIENT_ID, result.doc);
  const trust = resolveClientTrust(client);
  const logoUri = client.metadata.logo_uri as string;

  assert.equal(new URL(logoUri).hostname, "persistent.oaistatic.com");
  assert.equal(isLogoFetchAllowed(logoUri, CHATGPT_CLIENT_ID, trust), true);
});

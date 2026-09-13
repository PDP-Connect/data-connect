// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the approved-client-logo fetch and cache.
 *
 * `spec-core.md:676` permits rendering a client-supplied logo only when the
 * client is verified, or the asset has been proxied, cached, and approved
 * under local policy. This module is the proxy-and-cache half, and these
 * tests pin the properties that make it safe rather than merely functional:
 *
 *   - the bytes are fetched server-side and re-served, so the consent page
 *     never emits the client's URL to the owner's browser;
 *   - the fetch is treated as hostile input — SSRF-guarded, size-capped,
 *     redirect-refusing, and restricted to raster image types;
 *   - every failure falls back to null, because a missing logo has an obvious
 *     fallback (the monogram) and a consent screen must never fail to render
 *     because someone else's CDN is down.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_LOGO_MAX_BYTES,
  fetchAndCacheClientLogo,
  invalidateClientLogo,
  readCachedClientLogo,
} from "../server/client-logo-cache.ts";

const LOGO_URI = "https://persistent.oaistatic.com/sonic/misc/openai-logo.png";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const publicDns = () => Promise.resolve([{ address: "93.184.216.34" }]);

/** Minimal undici-shaped response. */
function imageResponse(
  bytes: Uint8Array = PNG_BYTES,
  { contentType = "image/png", statusCode = 200 }: { contentType?: string; statusCode?: number } = {}
) {
  return {
    body: (async function* () {
      yield bytes;
    })(),
    headers: { "content-type": contentType },
    statusCode,
  };
}

let counter = 0;
/** A distinct cache key per test, since the cache is module-level. */
function freshKey(): string {
  counter += 1;
  const key = `test-logo-${counter}`;
  invalidateClientLogo(key);
  return key;
}

test("an approved logo is fetched once and served from cache after that", async () => {
  const key = freshKey();
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return imageResponse();
  }) as never;

  const first = await fetchAndCacheClientLogo(key, LOGO_URI, { dnsLookupImpl: publicDns, fetchImpl });
  const second = await fetchAndCacheClientLogo(key, LOGO_URI, { dnsLookupImpl: publicDns, fetchImpl });

  assert.ok(first);
  assert.equal(first.mediaType, "image/png");
  assert.deepEqual([...first.bytes], [...PNG_BYTES]);
  assert.deepEqual(second, first);
  assert.equal(fetches, 1, "a consent render must not refetch the logo every time");
});

test("the cached record keeps the source URL for audit, not for rendering", async () => {
  const key = freshKey();
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => imageResponse()) as never,
  });

  assert.equal(logo?.sourceUri, LOGO_URI);
  // The bytes are what gets served; the URL is evidence of where they came
  // from, never something the owner's browser is asked to fetch.
  assert.ok(logo?.bytes instanceof Uint8Array);
});

test("a non-image response is refused rather than served", async () => {
  const key = freshKey();
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => imageResponse(PNG_BYTES, { contentType: "text/html" })) as never,
  });

  assert.equal(logo, null);
});

test("SVG is refused even though it is an image type", async () => {
  const key = freshKey();
  // SVG is an executable document; serving one from this server's own origin
  // would place client-controlled script inside the consent page's origin.
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => imageResponse(PNG_BYTES, { contentType: "image/svg+xml" })) as never,
  });

  assert.equal(logo, null);
});

test("a body over the size cap is abandoned, not buffered", async () => {
  const key = freshKey();
  const oversized = new Uint8Array(CLIENT_LOGO_MAX_BYTES + 1);
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => imageResponse(oversized)) as never,
  });

  assert.equal(logo, null);
  assert.equal(readCachedClientLogo(key), null, "a refused fetch must not populate the cache");
});

test("a redirect is refused rather than followed", async () => {
  const key = freshKey();
  // Following one would let the bytes come from a host the client never
  // proved control of and the operator never allow-listed.
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => ({
      body: (async function* () {})(),
      headers: { location: "https://evil.example/logo.png" },
      statusCode: 302,
    })) as never,
  });

  assert.equal(logo, null);
});

test("a host resolving to a private address is never fetched", async () => {
  const key = freshKey();
  let fetched = false;
  const logo = await fetchAndCacheClientLogo(key, "https://internal.example/logo.png", {
    dnsLookupImpl: () => Promise.resolve([{ address: "127.0.0.1" }]),
    fetchImpl: (async () => {
      fetched = true;
      return imageResponse();
    }) as never,
  });

  assert.equal(logo, null);
  assert.equal(fetched, false, "the SSRF guard must reject before any request is issued");
});

test("non-https and malformed URLs are refused before any lookup", async () => {
  const key = freshKey();
  let looked = false;
  const dnsLookupImpl = () => {
    looked = true;
    return Promise.resolve([{ address: "93.184.216.34" }]);
  };

  for (const bad of ["http://chatgpt.com/logo.png", "not-a-url", "data:image/png;base64,AAAA"]) {
    assert.equal(await fetchAndCacheClientLogo(key, bad, { dnsLookupImpl }), null, bad);
  }
  assert.equal(looked, false, "an unusable URL is rejected before DNS");
});

test("a transport failure falls back to null instead of throwing", async () => {
  const key = freshKey();
  // A consent screen must still render when a third party's CDN is down.
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => Promise.reject(new Error("connect ECONNREFUSED"))) as never,
  });

  assert.equal(logo, null);
});

test("an empty body is not cached as a valid logo", async () => {
  const key = freshKey();
  const logo = await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl: (async () => imageResponse(new Uint8Array(0))) as never,
  });

  assert.equal(logo, null);
});

test("an invalidated logo is refetched, so a withdrawn approval takes effect", async () => {
  const key = freshKey();
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return imageResponse();
  }) as never;

  await fetchAndCacheClientLogo(key, LOGO_URI, { dnsLookupImpl: publicDns, fetchImpl });
  invalidateClientLogo(key);
  await fetchAndCacheClientLogo(key, LOGO_URI, { dnsLookupImpl: publicDns, fetchImpl });

  assert.equal(fetches, 2);
});

test("a stale cache entry is refetched rather than served", async () => {
  const key = freshKey();
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return imageResponse();
  }) as never;

  await fetchAndCacheClientLogo(key, LOGO_URI, { dnsLookupImpl: publicDns, fetchImpl, nowMs: 0 });
  // A day and a second later.
  await fetchAndCacheClientLogo(key, LOGO_URI, {
    dnsLookupImpl: publicDns,
    fetchImpl,
    nowMs: 24 * 60 * 60 * 1000 + 1000,
  });

  assert.equal(fetches, 2, "the cache must expire so an operator's withdrawal is not defeated by it");
});

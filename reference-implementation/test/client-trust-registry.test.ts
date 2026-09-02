// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for client trust resolution.
 *
 * `spec-core.md:675` requires a positive trust signal to be rendered
 * distinctly, and requires a client without one to be treated as unverified.
 * Before this module the consent surface hardcoded `isUnverified: true` on
 * every path, so "Unverified app" was a badge no client could ever escape —
 * and a marker every client wears carries no signal at all.
 *
 * The signal implemented here is domain control, established automatically:
 * a client whose `client_id` is an https URL serving a valid client-metadata
 * document has proven it controls that domain (`validateCimdUrl` requires
 * https, the fetch is SSRF-guarded, and `validateCimdRedirectUris` pins every
 * redirect target to the client_id origin). These tests pin two things about
 * that: it is automatic for any conforming client rather than a list, and the
 * claim never widens beyond the domain that was actually proven.
 *
 * They also pin the logo rules, which are the part most likely to erode:
 * an unverified client never gets an image, and a verified one only gets one
 * from its own domain or a host the operator allow-listed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_OPERATOR_TRUST_CONFIG,
  isLogoFetchAllowed,
  resolveClientTrust,
  resolveOperatorTrustConfig,
} from "../server/client-trust-registry.ts";

const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/Dyp26IIu2iQg/client.json";
const CHATGPT_LOGO = "https://persistent.oaistatic.com/sonic/misc/openai-logo.png";

/** A client that completed CIMD resolution — the shape `buildCimdRegisteredClient` returns. */
function cimdClient(clientId = CHATGPT_CLIENT_ID) {
  return { client_id: clientId, registration_mode: "client_id_metadata_document" };
}

/** A client registered without proving a domain. */
function preRegisteredClient(clientId = "pdpp_cli") {
  return { client_id: clientId, registration_mode: "pre_registered_public" };
}

test("a valid CIMD client is domain-verified automatically, with no operator action", () => {
  const trust = resolveClientTrust(cimdClient(), EMPTY_OPERATOR_TRUST_CONFIG);

  assert.equal(trust.isTrusted, true, "publishing a valid metadata document is itself the signal");
  assert.equal(trust.basis, "domain_verified");
  // The claim is exactly what was proven: control of this domain. Not that the
  // app is safe, honest, or endorsed.
  assert.equal(trust.verifiedDomain, "chatgpt.com");
});

test("domain verification applies to any conforming client, not a blessed list", () => {
  const someoneElse = resolveClientTrust(cimdClient("https://notion.so/oauth/client.json"));

  assert.equal(someoneElse.isTrusted, true, "any client that publishes a valid document earns the signal");
  assert.equal(someoneElse.verifiedDomain, "notion.so");
});

test("a client that never proved a domain stays unverified", () => {
  const trust = resolveClientTrust(preRegisteredClient(), EMPTY_OPERATOR_TRUST_CONFIG);

  assert.equal(trust.isTrusted, false, "self-asserted registration is not domain control");
  assert.equal(trust.basis, "none");
  assert.equal(trust.verifiedDomain, null);
});

test("an absent or malformed client resolves to unverified rather than throwing", () => {
  assert.equal(resolveClientTrust(null).isTrusted, false);
  assert.equal(resolveClientTrust({ client_id: "   ", registration_mode: "client_id_metadata_document" }).isTrusted, false);
  // A non-URL client_id cannot yield a verified domain even if it claims CIMD.
  const opaque = resolveClientTrust({ client_id: "not-a-url", registration_mode: "client_id_metadata_document" });
  assert.equal(opaque.isTrusted, false, "no parseable domain means nothing was verified");
});

test("an operator override can vouch for a client that proved no domain", () => {
  const config = resolveOperatorTrustConfig({
    trustedClients: [{ client_id: "pdpp_cli", client_name: "PDPP CLI" }],
  });
  const trust = resolveClientTrust(preRegisteredClient("pdpp_cli"), config);

  assert.equal(trust.isTrusted, true);
  assert.equal(trust.basis, "operator_registered", "the basis names how trust was established");
  assert.equal(trust.verifiedDomain, null, "an operator vouching for a client does not prove a domain");
  assert.equal(trust.operatorDisplayName, "PDPP CLI");
});

test("an override never widens to a client_id it does not exactly name", () => {
  const config = resolveOperatorTrustConfig({
    trustedClients: [{ client_id: CHATGPT_CLIENT_ID, client_name: "ChatGPT" }],
  });
  // A sibling path on the same trusted origin is a different client.
  const sibling = resolveClientTrust(preRegisteredClient("https://chatgpt.com/oauth/someone-else/client.json"), config);

  assert.equal(sibling.isTrusted, false, "trust must not leak across client_ids sharing an origin");
});

test("malformed override entries are dropped rather than trusted", () => {
  const config = resolveOperatorTrustConfig({
    trustedClients: [{ client_id: "   ", client_name: "Blank" }, { client_id: "ok", client_name: "Fine" }],
  });

  assert.deepEqual(
    config.trustedClients.map((entry) => entry.client_id),
    ["ok"],
    "a config typo must not become a trusted client"
  );
  assert.equal(resolveClientTrust({ client_id: "", registration_mode: "pre_registered_public" }, config).isTrusted, false);
});

// ─── Logo policy (spec-core.md:676) ──────────────────────────────────────────

test("an unverified client never gets a logo, whatever it declares", () => {
  const trust = resolveClientTrust(preRegisteredClient());

  assert.equal(
    isLogoFetchAllowed("https://evil.example/logo.png", "pdpp_cli", trust),
    false,
    "spec-core.md:676 — no remote logo for an unverified client"
  );
});

test("a verified client may use a logo served from its own domain", () => {
  const trust = resolveClientTrust(cimdClient());

  assert.equal(isLogoFetchAllowed("https://chatgpt.com/logo.png", CHATGPT_CLIENT_ID, trust), true);
});

test("a verified client may not launder a third-party logo host by default", () => {
  const trust = resolveClientTrust(cimdClient());

  // Controlling chatgpt.com proves nothing about oaistatic.com.
  assert.equal(
    isLogoFetchAllowed(CHATGPT_LOGO, CHATGPT_CLIENT_ID, trust, EMPTY_OPERATOR_TRUST_CONFIG),
    false,
    "a host the client never proved control of requires an operator decision"
  );
});

test("an operator can allow-list a logo host, which is how ChatGPT's logo renders", () => {
  const trust = resolveClientTrust(cimdClient());
  // ChatGPT's logo is served from persistent.oaistatic.com — the exact host.
  const config = resolveOperatorTrustConfig({ logoHosts: ["persistent.oaistatic.com"] });

  assert.equal(isLogoFetchAllowed(CHATGPT_LOGO, CHATGPT_CLIENT_ID, trust, config), true);
  // The allow-list is per-host, not a blanket pass for the verified client.
  assert.equal(isLogoFetchAllowed("https://elsewhere.example/logo.png", CHATGPT_CLIENT_ID, trust, config), false);
});

test("an allow-listed host does not silently cover its subdomains", () => {
  const trust = resolveClientTrust(cimdClient());
  const exact = resolveOperatorTrustConfig({ logoHosts: ["oaistatic.com"] });

  // Whoever controls a domain can mint any subdomain under it, so an exact
  // host must not widen the operator's decision to the whole tree.
  assert.equal(isLogoFetchAllowed(CHATGPT_LOGO, CHATGPT_CLIENT_ID, trust, exact), false);

  // An operator who wants the tree says so, and it reads as a wildcard.
  const wildcard = resolveOperatorTrustConfig({ logoHosts: [".oaistatic.com"] });
  assert.equal(isLogoFetchAllowed(CHATGPT_LOGO, CHATGPT_CLIENT_ID, trust, wildcard), true);
  assert.equal(isLogoFetchAllowed("https://oaistatic.com/logo.png", CHATGPT_CLIENT_ID, trust, wildcard), true);
  // A lookalike suffix must not match: `notoaistatic.com` is a different domain.
  assert.equal(isLogoFetchAllowed("https://notoaistatic.com/logo.png", CHATGPT_CLIENT_ID, trust, wildcard), false);
});

test("a logo host can be allow-listed for one client without opening it to others", () => {
  const config = resolveOperatorTrustConfig({
    trustedClients: [{ client_id: CHATGPT_CLIENT_ID, logo_hosts: ["persistent.oaistatic.com"] }],
  });
  const chatGpt = resolveClientTrust(cimdClient(), config);
  const other = resolveClientTrust(cimdClient("https://other.example/client.json"), config);

  assert.equal(isLogoFetchAllowed(CHATGPT_LOGO, CHATGPT_CLIENT_ID, chatGpt, config), true);
  assert.equal(
    isLogoFetchAllowed(CHATGPT_LOGO, "https://other.example/client.json", other, config),
    false,
    "a per-client logo host must not become a global one"
  );
});

test("non-https logo URLs are refused even for a verified client on its own domain", () => {
  const trust = resolveClientTrust(cimdClient());

  assert.equal(isLogoFetchAllowed("http://chatgpt.com/logo.png", CHATGPT_CLIENT_ID, trust), false);
  assert.equal(isLogoFetchAllowed("data:image/png;base64,AAAA", CHATGPT_CLIENT_ID, trust), false);
  assert.equal(isLogoFetchAllowed("", CHATGPT_CLIENT_ID, trust), false);
  assert.equal(isLogoFetchAllowed(null, CHATGPT_CLIENT_ID, trust), false);
});

test("operator logo hosts accept either a bare host or a URL", () => {
  const trust = resolveClientTrust(cimdClient());
  const config = resolveOperatorTrustConfig({ logoHosts: ["https://persistent.oaistatic.com/", "www.cdn.example"] });

  assert.equal(isLogoFetchAllowed(CHATGPT_LOGO, CHATGPT_CLIENT_ID, trust, config), true);
  assert.equal(isLogoFetchAllowed("https://cdn.example/logo.png", CHATGPT_CLIENT_ID, trust, config), true);
});

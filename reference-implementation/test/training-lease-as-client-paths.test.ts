// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-training lease prototype: client paths that need a fuller OAuth setup.
 *
 * - L4: refresh-token replay detection revokes the token family, NOT training
 *   authority. Needs the authorization-code flow, the only RI flow that issues
 *   refresh tokens.
 * - L5: a confidential client (CIMD private_key_jwt) authenticates at the
 *   lease endpoint as it would at the token endpoint.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */

import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { describe, it } from "node:test";
import {
  fetchJson,
  type Harness,
  issueTrainingGrant,
  json,
  PublicLeaseClient,
  trainingDetail,
  withServer,
} from "./helpers/training-lease-harness.ts";

const REDIRECT = "https://client.example/callback";

function form(o: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(o).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  };
}

interface AuthCodeClientSpec {
  clientId: string;
  redirectUri: string;
  /** Client authentication parameters for a token-endpoint request. */
  tokenAuth: (tokenEndpoint: string) => Record<string, string>;
}

async function registerPublicClient(h: Harness): Promise<AuthCodeClientSpec> {
  const reg = await fetchJson<{ client_id: string }>(
    `${h.asUrl}/oauth/register`,
    json({
      application_type: "web",
      client_name: "Training lease test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  );
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const clientId = reg.body.client_id;
  return {
    clientId,
    redirectUri: REDIRECT,
    tokenAuth: () => ({ client_id: clientId }),
  };
}

async function authCodeTrainingGrant(h: Harness, client: AuthCodeClientSpec) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${h.asUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", client.redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", "s1");
  authorize.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set(
    "authorization_details",
    JSON.stringify([
      trainingDetail(h.connectorId, { access_mode: "continuous" }),
    ]),
  );
  const a = await fetch(authorize, { redirect: "manual" });
  assert.equal(a.status, 302, await a.text());
  const requestUri = new URL(
    a.headers.get("location") as string,
    h.asUrl,
  ).searchParams.get("request_uri");
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({
      processing_permissions_approved: true,
      request_uri: requestUri,
      subject_id: "owner_local",
    }),
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approve = await fetch(`${h.asUrl}/consent/approve`, {
    ...json({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: requestUri,
    }),
    redirect: "manual",
  });
  assert.equal(approve.status, 302);
  const code = new URL(
    approve.headers.get("location") as string,
  ).searchParams.get("code") as string;
  const tokenEndpoint = `${h.asUrl}/oauth/token`;
  const token = await fetchJson<{
    access_token: string;
    refresh_token: string;
    grant_id: string;
  }>(
    tokenEndpoint,
    form({
      ...client.tokenAuth(tokenEndpoint),
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: client.redirectUri,
    }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return {
    accessToken: token.body.access_token,
    clientId: client.clientId,
    grantId: token.body.grant_id,
    refreshToken: token.body.refresh_token,
  };
}

describe("L4: refresh-token replay does not end training authority", () => {
  it("replaying a superseded refresh token revokes the family; lease renewal continues", async () => {
    await withServer(true, async (h) => {
      const g = await authCodeTrainingGrant(h, await registerPublicClient(h));
      const c = new PublicLeaseClient(h, g.grantId);
      const boot = await c.bootstrap(g.accessToken);
      assert.equal(boot.status, 200, JSON.stringify(boot.body));
      const r1 = await fetchJson<{ refresh_token: string }>(
        `${h.asUrl}/oauth/token`,
        form({
          client_id: g.clientId,
          grant_type: "refresh_token",
          refresh_token: g.refreshToken,
        }),
      );
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      const replay = await fetchJson(
        `${h.asUrl}/oauth/token`,
        form({
          client_id: g.clientId,
          grant_type: "refresh_token",
          refresh_token: g.refreshToken,
        }),
      );
      assert.equal(replay.status, 400, "replay detected");
      const afterReplay = await fetchJson(
        `${h.asUrl}/oauth/token`,
        form({
          client_id: g.clientId,
          grant_type: "refresh_token",
          refresh_token: r1.body.refresh_token,
        }),
      );
      assert.equal(afterReplay.status, 400, "the whole family is revoked");
      const renewed = await c.renew();
      assert.equal(
        renewed.status,
        200,
        "training authority survives replay detection",
      );
      const status = await fetchJson<{ state: string }>(
        `${h.asUrl}/v1/owner/grants/${g.grantId}/training`,
        {
          headers: { Authorization: `Bearer ${h.ownerToken}` },
        },
      );
      assert.equal(status.body.state, "active");
    });
  });
});

function cimdClient() {
  const clientId = `https://trainer.example/oauth/${randomBytes(6).toString("hex")}/client.json`;
  const jwksUri = `${new URL(clientId).origin}/oauth/jwks.json`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwks = {
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        alg: "RS256",
        kid: "k1",
        use: "sig",
      },
    ],
  };
  const doc = {
    client_id: clientId,
    client_name: "Confidential Trainer",
    grant_types: ["authorization_code", "refresh_token"],
    jwks_uri: jwksUri,
    redirect_uris: [`${new URL(clientId).origin}/callback`],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "RS256",
  };
  return { clientId, doc, jwks, jwksUri, privateKey };
}

function assertion(
  clientId: string,
  audience: string,
  privateKey: KeyObject,
): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc({
    aud: audience,
    exp: now + 60,
    iat: now,
    iss: clientId,
    jti: randomBytes(8).toString("hex"),
    sub: clientId,
  })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

describe("L5: confidential client authenticates as at the token endpoint", () => {
  const c = cimdClient();
  const cimdFetchDependencies = {
    dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (input: unknown) =>
      new Response(
        JSON.stringify(String(input) === c.jwksUri ? c.jwks : c.doc),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      ),
    isGlobalUnicastAddressImpl: () => true,
  };

  it("issues a lease to a private_key_jwt client; refuses a bad or token-endpoint assertion and another client's grant", async () => {
    await withServer(
      true,
      async (h) => {
        const g0 = await authCodeTrainingGrant(h, {
          clientId: c.clientId,
          redirectUri: c.doc.redirect_uris[0] as string,
          tokenAuth: (aud) => ({
            client_assertion: assertion(c.clientId, aud, c.privateKey),
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_id: c.clientId,
          }),
        });
        const g = { grant: { grant_id: g0.grantId } };
        const endpoint = `${h.asUrl}/oauth/processing-lease`;
        const ok = await fetchJson<{ lease?: string }>(
          endpoint,
          form({
            client_assertion: assertion(c.clientId, endpoint, c.privateKey),
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_id: c.clientId,
            grant_id: g.grant.grant_id,
          }),
        );
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const payload = JSON.parse(
          Buffer.from(
            (ok.body.lease as string).split(".")[1] as string,
            "base64url",
          ).toString(),
        );
        assert.equal(payload.aud, c.clientId);
        assert.equal(
          "lease_credential" in ok.body,
          false,
          "a confidential client needs no lease credential",
        );

        const tokenAudience = await fetchJson(
          endpoint,
          form({
            client_assertion: assertion(
              c.clientId,
              `${h.asUrl}/oauth/token`,
              c.privateKey,
            ),
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_id: c.clientId,
            grant_id: g.grant.grant_id,
          }),
        );
        assert.equal(tokenAudience.status, 401);

        const other = await issueTrainingGrant(h);
        const notMine = await fetchJson(
          endpoint,
          form({
            client_assertion: assertion(c.clientId, endpoint, c.privateKey),
            client_assertion_type:
              "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_id: c.clientId,
            grant_id: other.grant.grant_id,
          }),
        );
        assert.deepEqual(notMine.body, {
          error: "no_lease",
          error_description:
            "No processing lease is available for this request.",
        });
      },
      { cimdFetchDependencies } as never,
    );
  });
});

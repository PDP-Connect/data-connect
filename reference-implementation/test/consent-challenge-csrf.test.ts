// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { countGrantPackagesForOwner } from "../server/auth.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import {
  computeHostedMcpDecisionDigest,
  type HostedMcpConsentChallengeModel,
} from "../server/routes/as-consent-ui-helpers.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./helpers/introspection-test-credentials.ts";

test("password-enabled consent challenges enforce CSRF for browser form media types and accept owner JSON", async (t) => {
  const password = "consent-csrf-test-password";
  const server = await startServer({
    asPort: 0,
    rsPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: password,
    quiet: true,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  });
  const origin = `http://127.0.0.1:${server.asPort}`;
  try {
    const login = await fetch(`${origin}/owner/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      redirect: "manual",
    });
    assert.equal(login.status, 302);
    const session = login.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("pdpp_owner_session="))
      ?.split(";")[0];
    assert.ok(session, "the test must exercise an authenticated owner with password protection enabled");

    const manifest = JSON.parse(
      readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8"),
    );
    manifest.connector_id = canonicalConnectorKeyFromManifest(manifest);
    const registered = await fetch(`${origin}/connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: session },
      body: JSON.stringify(manifest),
    });
    assert.equal(registered.status, 201, await registered.text());
    const now = new Date().toISOString();
    await createSqliteConnectorInstanceStore().upsert({
      connectorId: manifest.connector_id,
      connectorInstanceId: "cin_csrf_spotify",
      createdAt: now,
      updatedAt: now,
      displayName: "Spotify CSRF test account",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: "consent-csrf" },
      sourceBindingKey: "consent-csrf",
      sourceKind: "account",
      status: "active",
    });
    const registration = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        application_type: "web",
        client_name: "Consent CSRF test client",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: ["https://client.example/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 201);
    const client = (await registration.json()) as { client_id: string };
    const authorize = new URL("/oauth/authorize", origin);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      state: "consent-csrf-state",
      code_challenge: createHash("sha256")
        .update("consent-csrf-verifier-value-long-enough-for-pkce")
        .digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const handoff = await fetch(authorize, { headers: { cookie: session }, redirect: "manual" });
    assert.equal(handoff.status, 302);
    const location = handoff.headers.get("location");
    assert.ok(location);
    const challenge = new URL(location).searchParams.get("challenge");
    assert.ok(challenge);
    const endpoint = `${origin}/oauth/authorize/consent-challenges/${challenge}`;
    const modelResponse = await fetch(endpoint, { headers: { cookie: session } });
    assert.equal(modelResponse.status, 200);
    const model = (await modelResponse.json()) as HostedMcpConsentChallengeModel;
    const source = model.sources[0];
    assert.ok(source, "registered active source must appear in the real model");
    const stream = source.streams.find((candidate) => candidate.name === "saved_tracks");
    assert.ok(stream);
    const body = {
      access_mode: model.accessMode.value,
      grant_expiry: model.grantExpiry.defaultId,
      review_digest: model.reviewDigest,
      decision_digest: computeHostedMcpDecisionDigest({
        clientId: client.client_id,
        accessMode: model.accessMode.value,
        sources: [{ sourceKey: source.id, streamNames: [stream.name] }],
      }),
      source_id: [source.id],
      stream: [stream.id],
    };
    const initialCount = await countGrantPackagesForOwner();

    for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
      await t.test(
        `${contentType} is rejected without a valid CSRF pair and leaves the challenge pending`,
        async () => {
          for (const forged of [false, true]) {
            const payload = new URLSearchParams({
              ...body,
              source_id: source.id,
              stream: stream.id,
              ...(forged ? { _csrf: "forged-token" } : {}),
            }).toString();
            const response = await fetch(`${endpoint}/accept`, {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": contentType,
                cookie: `${session}${forged ? "; pdpp_owner_csrf=forged-token" : ""}`,
                origin: "https://attacker.example",
              },
              body: payload,
            });
            assert.equal(response.status, 403, await response.clone().text());
            const error = (await response.json()) as { error: { code: string } };
            assert.equal(error.error.code, "csrf_token_invalid");
            assert.equal(await countGrantPackagesForOwner(), initialCount);
            assert.equal(
              getDb().prepare("SELECT status FROM consent_challenges WHERE id = ?").get<{ status: string }>(challenge)
                ?.status,
              "pending",
            );
          }
        },
      );
    }

    await t.test("an untrusted origin receives no permission for a credentialed JSON preflight", async () => {
      const response = await fetch(`${endpoint}/accept`, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.notEqual(response.headers.get("access-control-allow-credentials"), "true");
    });

    await t.test(
      "the console's JSON request shape accepts the same owner decision without a CSRF field or cookie",
      async () => {
        const response = await fetch(`${endpoint}/accept`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", cookie: session },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const result = (await response.json()) as { redirect_url: string };
        const callback = new URL(result.redirect_url);
        assert.equal(callback.origin, "https://client.example");
        assert.equal(callback.searchParams.get("state"), "consent-csrf-state");
        assert.ok(callback.searchParams.get("code"));
        assert.equal(await countGrantPackagesForOwner(), initialCount + 1);
        assert.equal(
          getDb().prepare("SELECT status FROM consent_challenges WHERE id = ?").get<{ status: string }>(challenge)
            ?.status,
          "accepted",
        );
      },
    );
  } finally {
    server.asServer.closeAllConnections();
    server.rsServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server.asServer.close(() => resolve())),
      new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    ]);
    closeDb();
  }
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consent + owner-device-auth conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/consent-device-auth-conformance.js` against the current
 * SQLite-backed reference auth helpers (`initiateGrant`, `approveGrant`,
 * `denyGrant`, `getPendingConsent`, `getPendingConsentRowByApprovalId`,
 * `initiateOwnerDeviceAuthorization`, `approveOwnerDeviceAuthorization`,
 * `denyOwnerDeviceAuthorization`, `exchangeOwnerDeviceCode`,
 * `getOwnerDeviceAuthorizationByUserCode`, `getOwnerDeviceAuthRowByApprovalId`).
 *
 * Replaces nothing on its own; the focused route-level auth/security suites
 * (`owner-auth.test.js`, `owner-csrf.test.js`,
 * `security-device-code-exposure.test.js`,
 * `security-consent-token-handoff.test.js`) remain as direct evidence
 * alongside this conformance run. See worker report for rationale.
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  exchangeGrantScopedDeviceCode,
  exchangeOAuthAuthorizationCode,
  getPendingConsentRowByApprovalId,
  initiateGrant,
  issueOAuthAuthorizationCodeForDeviceCode,
  parsePendingConsentRequestUri,
  stageOAuthAuthorizationCodeRequest,
} from "../server/auth.ts";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { runConsentDeviceAuthConformance } from "./helpers/consent-device-auth-conformance.ts";
import { createSqliteConsentDeviceAuthDriver } from "./helpers/sqlite-consent-device-auth-driver.ts";

function stringProperty(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberProperty(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordArrayProperty(input: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    return;
  }
  return value.filter(isRecord);
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected a result object");
  return value;
}

function approvalResult(value: unknown): { access_token?: string; grant?: { grant_id: string }; token?: string } {
  const result = recordValue(value);
  const { access_token: accessToken, grant, token } = result;
  const grantRecord = isRecord(grant) ? grant : null;
  const grantId = grantRecord?.grant_id;
  return {
    ...(typeof grantId === "string" ? { grant: { grant_id: grantId } } : {}),
    ...(typeof token === "string" ? { token } : {}),
    ...(typeof accessToken === "string" ? { access_token: accessToken } : {}),
  };
}

runConsentDeviceAuthConformance({
  label: "sqlite-reference",
  makeDriver: () => {
    const driver = createSqliteConsentDeviceAuthDriver();
    return {
      ...driver,
      async approveOwnerDeviceAuth(code: string) {
        return approvalResult(await driver.approveOwnerDeviceAuth(code));
      },
      async approvePendingConsent(uri: string) {
        return approvalResult(await driver.approvePendingConsent(uri));
      },
      async exchangeOwnerDeviceCode(input: Record<string, string>) {
        return approvalResult(
          await driver.exchangeOwnerDeviceCode({
            ...(input.client_id ? { client_id: input.client_id } : {}),
            ...(input.device_code ? { device_code: input.device_code } : {}),
          })
        );
      },
      async lookupOwnerDeviceAuthByApprovalId(id: string) {
        const view = await driver.lookupOwnerDeviceAuthByApprovalId(id);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.status === "string" ? { status: view.status } : {}),
          ...(typeof view.approval_id === "string" ? { approval_id: view.approval_id } : {}),
          ...(typeof view.client_id === "string" ? { client_id: view.client_id } : {}),
          ...(typeof view.subject_id === "string" || view.subject_id === null ? { subject_id: view.subject_id } : {}),
        };
      },
      async lookupOwnerDeviceAuthByUserCode(code: string) {
        const view = await driver.lookupOwnerDeviceAuthByUserCode(code);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.client_id === "string" ? { client_id: view.client_id } : {}),
          ...(typeof view.interval === "number" ? { interval: view.interval } : {}),
          ...(typeof view.created_at === "string" || view.created_at === null ? { created_at: view.created_at } : {}),
          ...(typeof view.expires_at === "string" || view.expires_at === null ? { expires_at: view.expires_at } : {}),
        };
      },
      async lookupPendingConsentByApprovalId(id: string) {
        const view = await driver.lookupPendingConsentByApprovalId(id);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.status === "string" ? { status: view.status } : {}),
          ...(typeof view.approval_id === "string" ? { approval_id: view.approval_id } : {}),
          ...(typeof view.grant_id === "string" || view.grant_id === null ? { grant_id: view.grant_id } : {}),
          ...(typeof view.subject_id === "string" || view.subject_id === null ? { subject_id: view.subject_id } : {}),
        };
      },
      async lookupPendingConsentByRequestUri(uri: string) {
        const view = await driver.lookupPendingConsentByRequestUri(uri);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.user_code === "string" ? { user_code: view.user_code } : {}),
          ...(typeof view.created_at === "string" || view.created_at === null ? { created_at: view.created_at } : {}),
          ...(typeof view.expires_at === "string" || view.expires_at === null ? { expires_at: view.expires_at } : {}),
        };
      },
      async setup() {
        await driver.setup();
        const connectorId = driver.getRegisteredConnectorId();
        const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
        const now = new Date().toISOString();
        await createSqliteConnectorInstanceStore().upsert({
          connectorId: canonicalId,
          connectorInstanceId: "cin_conformance_spotify",
          createdAt: now,
          displayName: "Spotify",
          ownerSubjectId: "owner_local",
          sourceBinding: { kind: "test_account", label: "consent-conformance-spotify" },
          sourceBindingKey: "consent-conformance-spotify",
          sourceKind: "account",
          status: "active",
          updatedAt: now,
        });
      },
      async startOwnerDeviceAuth(input: Record<string, unknown>) {
        const clientId = stringProperty(input, "client_id");
        const interval = numberProperty(input, "interval");
        const expiresIn = numberProperty(input, "expires_in");
        const result = await driver.startOwnerDeviceAuth({
          ...(clientId === undefined ? {} : { client_id: clientId }),
          ...(interval === undefined ? {} : { interval }),
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        });
        assert.ok(typeof result.device_code === "string", "owner device start returns a device code");
        assert.ok(typeof result.user_code === "string", "owner device start returns a user code");
        assert.ok(typeof result.approval_id === "string", "owner device start returns an approval ID");
        assert.ok(typeof result.interval === "number", "owner device start returns a polling interval");
        assert.ok(typeof result.expires_in === "number", "owner device start returns an expiry interval");
        return {
          approval_id: result.approval_id,
          device_code: result.device_code,
          expires_in: result.expires_in,
          interval: result.interval,
          user_code: result.user_code,
        };
      },
      async startPendingConsent(input: Record<string, unknown>) {
        const purposeCode = stringProperty(input, "purpose_code");
        const purposeDescription = stringProperty(input, "purpose_description");
        const accessMode = stringProperty(input, "access_mode");
        const streams = recordArrayProperty(input, "streams");
        const result = await driver.startPendingConsent({
          ...(purposeCode === undefined ? {} : { purpose_code: purposeCode }),
          ...(purposeDescription === undefined ? {} : { purpose_description: purposeDescription }),
          ...(accessMode === undefined ? {} : { access_mode: accessMode }),
          ...(streams === undefined ? {} : { streams }),
        });
        assert.ok(typeof result.request_uri === "string", "pending consent start returns a request URI");
        assert.ok(typeof result.approval_id === "string", "pending consent start returns an approval ID");
        return { approval_id: result.approval_id, request_uri: result.request_uri };
      },
    };
  },
  test,
});

test("grant-scoped device codes require server provenance and atomic redemption", async (t) => {
  const driver = createSqliteConsentDeviceAuthDriver();
  await driver.setup();
  t.after(() => driver.teardown());
  const connectorId = driver.getRegisteredConnectorId();
  const now = new Date().toISOString();
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: canonicalConnectorKey(connectorId) ?? connectorId,
    connectorInstanceId: "cin_conformance_spotify",
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId: "owner_local",
    sourceBinding: { kind: "test_account", label: "consent-conformance-spotify" },
    sourceBindingKey: "consent-conformance-spotify",
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });

  const pending = await driver.startPendingConsent({});
  assert.equal(typeof pending.request_uri, "string");
  const requestUri = pending.request_uri as string;
  const row = await getPendingConsentRowByApprovalId(pending.approval_id);
  assert.ok(row);
  const params = recordValue(JSON.parse(row.params_json));
  const clientId = recordValue(params.client).client_id;
  assert.equal(typeof clientId, "string");
  const client = clientId as string;
  const verifier = "v".repeat(43);
  const redirectUri = "https://example.com/callback";
  await stageOAuthAuthorizationCodeRequest({
    clientId: client,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    codeChallengeMethod: "S256",
    deviceCode: row.device_code,
    redirectUri,
  });
  const approved = approvalResult(await driver.approvePendingConsent(requestUri));
  assert.ok(approved.grant);
  assert.ok(approved.token);
  const issued = await issueOAuthAuthorizationCodeForDeviceCode(row.device_code, {
    grantId: approved.grant.grant_id,
    token: approved.token,
  });
  assert.ok(issued);

  await t.test("approved authorization-code consent cannot redeem as a device code", async () => {
    await assert.rejects(
      exchangeGrantScopedDeviceCode({ clientId: client, deviceCode: row.device_code }),
      { code: "invalid_grant" }
    );
  });

  await t.test("PKCE code exchange still requires the verifier and succeeds with it", async () => {
    const input = { clientId: client, code: issued.code, redirectUri };
    await assert.rejects(
      exchangeOAuthAuthorizationCode({ ...input, codeVerifier: "x".repeat(43) }),
      { code: "invalid_grant" }
    );
    const token = await exchangeOAuthAuthorizationCode({ ...input, codeVerifier: verifier });
    assert.equal(token.access_token, approved.token);
  });

  await t.test("genuine device authorization redeems once, including concurrent exchanges", async () => {
    const input = {
      authorization_details: [{ ...recordValue(params.selection), source: params.source_binding }],
      client_id: client,
    };
    // The provenance option is supplied by the server's device-authorization
    // endpoint, not by authorization_details or any other client body field.
    const deviceOptions = { baseUrl: "http://localhost", deviceAuthorization: true };
    const device = await initiateGrant(input, deviceOptions);
    assert.equal(typeof device.request_uri, "string");
    const deviceUri = device.request_uri as string;
    const deviceCode = parsePendingConsentRequestUri(deviceUri);
    assert.ok(deviceCode);
    await assert.rejects(exchangeGrantScopedDeviceCode({ clientId: client, deviceCode }), {
      code: "authorization_pending",
    });
    const deviceApproved = approvalResult(await driver.approvePendingConsent(deviceUri));
    assert.ok(deviceApproved.token);
    const attempts = await Promise.allSettled([
      exchangeGrantScopedDeviceCode({ clientId: client, deviceCode }),
      exchangeGrantScopedDeviceCode({ clientId: client, deviceCode }),
    ]);
    const successes = attempts.filter((result) => result.status === "fulfilled");
    const failures = attempts.filter((result) => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(successes[0]?.value.access_token, deviceApproved.token);
    assert.equal(failures[0]?.reason.code, "invalid_grant");
    await assert.rejects(exchangeGrantScopedDeviceCode({ clientId: client, deviceCode }), {
      code: "invalid_grant",
    });
    await assert.rejects(initiateGrant({ ...input, device_authorization: "issued" }), {
      code: "invalid_request",
    });
  });
});

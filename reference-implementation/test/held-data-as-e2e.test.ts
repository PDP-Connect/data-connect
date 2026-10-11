// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Held-data lifecycle prototype over HTTP, in the RI: the ending paths of
 * integration-v2 §2 as the RI implements them, the grant-lifecycle status
 * operation, restore of the main database, refresh replay, package partial
 * failure, whole-client disconnect, lifecycle-credential recovery, and B3 at
 * the lease endpoint.
 *
 * PROTOTYPE: experimental held-data lifecycle work, off by default.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { HeldDataClient } from "../lib/held-data/client.ts";
import { MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import { httpReportTransport, httpStatusTransport } from "../lib/held-data/http-transport.ts";
import { makeDpopProof, thumbprint } from "../lib/training-lease/dpop.ts";
import { generateEd25519KeyPair } from "../lib/training-lease/jws.ts";
import {
  endHeldDataForGrant,
  ensureHeldDataGrant,
  exchangeGrantScopedDeviceCode,
  revokeCimdClientAccessForSecurityMetadataChange,
} from "../server/auth.ts";
import { invalidateCimdCache } from "../server/cimd.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import {
  approveGrant,
  createConsentExchangeCode,
  getGrantPackageAccess,
  introspect,
  revokeGrant,
  issueToken,
} from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { buildLogger } from "../server/transport.ts";
import { getTrainingLeaseRuntime } from "../server/training-lease/runtime.ts";
import { getHeldDataRuntime } from "../server/held-data/runtime.ts";
import { createAgentConnectAttemptStore } from "../server/routes/as-agent-connect.ts";
import { parseHostedMcpSelection } from "../server/hosted-mcp-selection.ts";
import {
  computeHostedMcpDecisionDigest,
  type HostedMcpConsentChallengeModel,
} from "../server/routes/as-consent-ui-helpers.ts";
import {
  fetchJson,
  mutateMainDatabase,
  type Harness,
  issueTrainingGrant,
  json,
  PublicLeaseClient,
  par,
  seedInstance,
  trainingDetail,
  withServer,
} from "./helpers/training-lease-harness.ts";

const REDIRECT = "https://client.example/callback";
const DAY = 24 * 60 * 60 * 1000;

function heldDataOpts(clock?: { now: number }) {
  return {
    experimentalHeldDataLifecycle: {
      journalDir: mkdtempSync(join(tmpdir(), "pdpp-held-e2e-journal-")),
      markerDir: mkdtempSync(join(tmpdir(), "pdpp-held-e2e-marker-")),
      ...(clock ? { now: () => clock.now } : {}),
    },
  };
}

function form(o: Record<string, string>): RequestInit {
  return {
    body: new URLSearchParams(o).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  };
}

function ordinaryDetail(connectorId: string, extra: Record<string, unknown> = {}) {
  const { processing_permissions: _p, purpose_description: _d, ...rest } = trainingDetail(connectorId, extra);
  return rest;
}

/** PAR → review → approve for an ordinary (non-training) grant. */
async function ordinaryGrant(h: Harness, extra: Record<string, unknown> = {}) {
  const p = await par(h.asUrl, ordinaryDetail(h.connectorId, extra));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({ request_uri: p.body.request_uri, subject_id: "owner_local" }),
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approved = await fetchJson<{
    grant: { grant_id: string };
    token: string;
  }>(
    `${h.asUrl}/consent/approve`,
    json({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: p.body.request_uri,
    }),
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { grantId: approved.body.grant.grant_id, token: approved.body.token };
}

async function registerPublicClient(h: Harness): Promise<string> {
  const reg = await fetchJson<{ client_id: string }>(
    `${h.asUrl}/oauth/register`,
    json({
      application_type: "web",
      client_name: "Held-data test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  );
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  return reg.body.client_id;
}

/** Authorization-code flow for a continuous grant: the only RI flow with refresh tokens. */
async function authCodeGrant(
  h: Harness,
  clientId: string,
  opts: { redirect?: string; tokenAuth?: (tokenEndpoint: string) => Record<string, string> } = {},
) {
  const redirect = opts.redirect ?? REDIRECT;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${h.asUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirect);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", "s1");
  authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set(
    "authorization_details",
    JSON.stringify([ordinaryDetail(h.connectorId, { access_mode: "continuous" })]),
  );
  const a = await fetch(authorize, { redirect: "manual" });
  assert.equal(a.status, 302, await a.text());
  const requestUri = new URL(a.headers.get("location") as string, h.asUrl).searchParams.get("request_uri");
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({ request_uri: requestUri, subject_id: "owner_local" }),
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
  const code = new URL(approve.headers.get("location") as string).searchParams.get("code") as string;
  const token = await fetchJson<{
    access_token: string;
    refresh_token: string;
    grant_id: string;
  }>(
    `${h.asUrl}/oauth/token`,
    form({
      ...(opts.tokenAuth ? opts.tokenAuth(`${h.asUrl}/oauth/token`) : { client_id: clientId }),
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return {
    code,
    verifier,
    accessToken: token.body.access_token,
    grantId: token.body.grant_id,
    refreshToken: token.body.refresh_token,
  };
}

/** Hosted-MCP picker flow: one package with a child grant per connector (from ref-grant-packages.test.ts). */
async function packageFlow(h: Harness, clientId: string, connectorIds: string[]) {
  const verifier = randomBytes(32).toString("base64url");
  const authorizeUrl = new URL(`${h.asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "pkg");
  authorizeUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  const picker = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(picker.status, 302);
  const challenge = new URL(picker.headers.get("location") as string).searchParams.get("challenge");
  const model = (
    await fetchJson<HostedMcpConsentChallengeModel>(`${h.asUrl}/oauth/authorize/consent-challenges/${challenge}`)
  ).body;
  const wanted = connectorIds.map((c) => canonicalConnectorKey(c) ?? c);
  const chosen = model.sources.filter((s) => {
    const sel = parseHostedMcpSelection(s.selectionValue);
    return sel !== null && wanted.includes(canonicalConnectorKey(sel.connectorId) ?? sel.connectorId);
  });
  assert.equal(chosen.length, connectorIds.length);
  const approve = await fetchJson<{ redirect_url?: string }>(
    `${h.asUrl}/oauth/authorize/consent-challenges/${challenge}/accept`,
    json({
      access_mode: "continuous",
      decision_digest: computeHostedMcpDecisionDigest({
        accessMode: "continuous",
        clientId,
        grantExpiry: model.grantExpiry.defaultId,
        sources: chosen.map((s) => ({
          sourceKey: s.id,
          streamNames: s.streams.map((x) => x.name).sort(),
        })),
      }),
      grant_expiry: model.grantExpiry.defaultId,
      review_digest: model.reviewDigest,
      source_id: chosen.map((s) => s.id),
      stream: chosen.flatMap((s) => s.streams.map((x) => x.id)),
    }),
  );
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const code = new URL(approve.body.redirect_url as string).searchParams.get("code") as string;
  const token = await fetchJson<{
    grant_package_id: string;
    access_token: string;
    refresh_token: string;
  }>(
    `${h.asUrl}/oauth/token`,
    form({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  const detail = await fetchJson<{ children: { grant_id: string }[] }>(
    `${h.asUrl}/_ref/grant-packages/${encodeURIComponent(token.body.grant_package_id)}`,
  );
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  return {
    code,
    verifier,
    packageId: token.body.grant_package_id,
    packageToken: token.body.access_token,
    refreshToken: token.body.refresh_token,
    children: detail.body.children.map((c) => c.grant_id),
  };
}

async function registerSecondConnector(h: Harness): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "seed-manifests", "github.json"), "utf8"),
  ) as { connector_id: string };
  const reg = await fetch(`${h.asUrl}/connectors`, json(manifest));
  assert.equal(reg.status, 201);
  await seedInstance(manifest.connector_id);
  return manifest.connector_id;
}

async function devicePackage(h: Harness, clientId: string) {
  const second = await registerSecondConnector(h);
  const started = await fetchJson<{
    device_code: string;
    verification_uri_complete: string;
  }>(
    `${h.asUrl}/oauth/device_authorization`,
    form({
      client_id: clientId,
      resource: `${h.rsUrl}/mcp`,
      authorization_details: JSON.stringify([ordinaryDetail(h.connectorId, { access_mode: "continuous" })]),
    })
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const requestUri = new URL(started.body.verification_uri_complete).searchParams.get("request_uri");
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({ request_uri: requestUri, subject_id: "owner_local" })
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approval = await fetchJson(
    `${h.asUrl}/consent/approve`,
    json({
      request_uri: requestUri,
      approval_review_revision: review.body.approval_review_revision,
    })
  );
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  const p = await packageFlow(h, clientId, [h.connectorId, second]);
  // Restore an approved device row with the binding written by a package approval.
  getDb()
    .prepare("UPDATE pending_consents SET grant_id = ?, token_id = ? WHERE device_code = ?")
    .run(p.packageId, p.packageToken, started.body.device_code);
  return { ...p, deviceCode: started.body.device_code };
}

/** The grant lifecycle operation, in the Core draft's form encoding. */
async function lifecycle(h: Harness, params: Record<string, string>) {
  return fetchJson<{ grants: Record<string, unknown>[]; error?: string }>(
    `${h.asUrl}/oauth/grant-lifecycle`,
    form(params),
  );
}

async function status(h: Harness, token: string, grantId: string) {
  return lifecycle(h, { grant_id: grantId, token });
}

async function revoke(h: Harness, bearer: string, grantId: string, body: Record<string, unknown> = {}) {
  return fetchJson(`${h.asUrl}/grants/${grantId}/revoke`, json(body, { Authorization: `Bearer ${bearer}` }));
}

/** Restore the pre-ending main-store rows; leave the independent journal intact. */
function restoreGrantRows(grantId: string) {
  getDb().prepare("UPDATE grants SET status = 'active', consumed = 0 WHERE grant_id = ?").run(grantId);
  getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(grantId);
  getDb()
    .prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?")
    .run(grantId);
  getDb()
    .prepare("UPDATE grant_package_members SET status = 'active', revoked_at = NULL WHERE grant_id = ?")
    .run(grantId);
}

function restoreAuthorizationCode(code: string, token: string) {
  getDb()
    .prepare("UPDATE oauth_authorization_codes SET status = 'issued', consumed_at = NULL WHERE code = ?")
    .run(code);
  getDb().prepare("UPDATE tokens SET refresh_family_id = NULL, expires_at = NULL WHERE token_id = ?").run(token);
}

async function rsRead(h: Harness, token: string) {
  return (
    await fetch(`${h.rsUrl}/v1/streams/top_artists/records`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).status;
}

async function owner(h: Harness, path: string, method: "GET" | "POST" = "GET") {
  return fetchJson<Record<string, unknown>>(`${h.asUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${h.ownerToken}`,
      "Content-Type": "application/json",
    },
    method,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

function cimdClient() {
  const clientId = `https://app.example/oauth/${randomBytes(6).toString("hex")}/client.json`;
  const jwksUri = `${new URL(clientId).origin}/oauth/jwks.json`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "k1", use: "sig" }] };
  const doc = {
    client_id: clientId,
    client_name: "Confidential App",
    grant_types: ["authorization_code", "refresh_token"],
    jwks_uri: jwksUri,
    redirect_uris: [`${new URL(clientId).origin}/callback`],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "RS256",
  };
  return { clientId, doc, jwks, jwksUri, privateKey };
}

/** private_key_jwt client authentication parameters. `jti: null` omits the claim. */
function clientAuth(
  c: { clientId: string; privateKey: KeyObject },
  audience: string,
  o: { jti?: string | null } = {},
): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const jti = o.jti === undefined ? randomBytes(8).toString("hex") : o.jti;
  const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc({
    aud: audience,
    exp: now + 60,
    iat: now,
    iss: c.clientId,
    ...(jti === null ? {} : { jti }),
    sub: c.clientId,
  })}`;
  return {
    client_assertion: `${input}.${sign("RSA-SHA256", Buffer.from(input), c.privateKey).toString("base64url")}`,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_id: c.clientId,
  };
}

function loseHistory(journalPath: string, loss: "wiped" | "suffix") {
  const rt = getHeldDataRuntime()!;
  rt.authority.registerGrant({ grantId: "loss-witness", clientId: "witness", subjectId: "owner_local", confidential: false, streams: [], expiresAtMs: null });
  const prefix = readFileSync(journalPath, "utf8");
  rt.authority.end({ grantId: "loss-witness", path: "owner_withdrawal", disposition: "keep" });
  const full = readFileSync(journalPath, "utf8");
  if (loss === "wiped") rmSync(journalPath);
  else writeFileSync(journalPath, prefix);
  assert.equal(rt.authority.lost, true);
  return () => writeFileSync(journalPath, full);
}

describe("held-data lifecycle over HTTP", () => {
  it("D4: authority fence is installed before the AS listener is published", async () => {
    let readyWhenBound = false;
    const logger = buildLogger({ quiet: true });
    logger.info = ((...args: unknown[]) => {
      if (args[1] === "authorization server listening") readyWhenBound = getHeldDataRuntime() !== null;
    }) as typeof logger.info;
    await withServer(false, async () => {
      assert.equal(readyWhenBound, true);
    }, { ...heldDataOpts(), logger });
  });

  for (const loss of ["wiped", "suffix"] as const) {
    for (const disposition of ["delete", "keep"] as const) {
      it(`D4: ${loss} history accepts owner ${disposition}; restores before lifecycle, introspection and refresh`, async () => {
        const opts = heldDataOpts();
        await withServer(false, async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          assert.equal((await status(h, g.accessToken, g.grantId)).status, 200);
          const journal = join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal");
          const restore = loseHistory(journal, loss);
          const first = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: disposition });
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal((first.body as { lifecycle: { status: string } }).lifecycle.status, "pending");
          const retry = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: disposition });
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          const record = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
          assert.equal(record.status, 200);
          assert.equal((record.body.pending_actions as unknown[]).length, 1);
          assert.equal(record.body.history_available, false);
          assert.match(String(record.body.owner_message), /no reads, tokens, processing authority, or positive assessments/);
          assert.equal((await status(h, g.accessToken, g.grantId)).status, 503);
          restore();
          // Restore the read database too: no authority path may bypass pending replay.
          getDb().prepare("UPDATE grants SET status = 'active' WHERE grant_id = ?").run(g.grantId);
          getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(g.grantId);
          getDb().prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?").run(g.grantId);
          assert.equal((await status(h, g.accessToken, g.grantId)).status, 503);
          assert.equal(await rsRead(h, g.accessToken), 403);
          const refresh = () => fetchJson(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken }));
          assert.equal((await refresh()).status, 400);
          getDb().prepare("UPDATE oauth_authorization_codes SET status = 'issued', consumed_at = NULL WHERE code = ?").run(g.code);
          const redeliver = () => fetchJson(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "authorization_code", code: g.code, code_verifier: g.verifier, redirect_uri: REDIRECT }));
          assert.equal((await redeliver()).status, 400);
          const device = getDb().prepare("SELECT device_code FROM pending_consents WHERE grant_id = ?").get(g.grantId) as { device_code: string };
          assert.ok(device.device_code);
          await assert.rejects(() => exchangeGrantScopedDeviceCode({ clientId, deviceCode: device.device_code }));
          await assert.rejects(() => issueToken(g.grantId, "owner_local", clientId, null));
          getHeldDataRuntime()!.authority.reestablishHistory();
          const result = await status(h, g.accessToken, g.grantId);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.grants[0]?.read_state, "revoked");
          assert.equal(result.body.grants[0]?.held_data, disposition === "delete" ? "erase" : "permitted");
          assert.equal(await rsRead(h, g.accessToken), 403);
          assert.equal((await refresh()).status, 400);
          assert.equal((await redeliver()).status, 400);
          await assert.rejects(() => exchangeGrantScopedDeviceCode({ clientId, deviceCode: device.device_code }));
          await assert.rejects(() => issueToken(g.grantId, "owner_local", clientId, null));
        }, opts);
      });
    }
    it(`D4: ${loss} history accepts package delete for active and previously kept children`, async () => {
      const opts = heldDataOpts();
      await withServer(false, async (h) => {
        const github = await registerSecondConnector(h);
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, github]);
        await revoke(h, h.ownerToken, pkg.children[0]!, { pdpp_disposition: "keep" });
        const restore = loseHistory(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), loss);
        const result = await fetchJson<{ status: string; lifecycle: { grants: { status: string }[] } }>(`${h.asUrl}/_ref/grant-packages/${pkg.packageId}/revoke`, json({ pdpp_disposition: "delete" }));
        assert.equal(result.status, 202, JSON.stringify(result.body));
        assert.equal(result.body.status, "pending");
        assert.equal(result.body.lifecycle.grants.length, 2);
        assert.ok(result.body.lifecycle.grants.every((g) => g.status === "pending"));
        for (const grantId of pkg.children) {
          const v = await owner(h, `/v1/owner/grants/${grantId}/lifecycle`);
          assert.equal((v.body.pending_actions as unknown[]).length, 1);
        }
        restore();
        getHeldDataRuntime()!.authority.reestablishHistory();
        for (const grantId of pkg.children) {
          assert.equal((await status(h, pkg.packageToken, grantId)).body.grants[0]?.held_data, "erase");
        }
      }, opts);
    });
  }

  it("D4: whole-client delete while wiped includes an earlier ended grant absent from the lost history", async () => {
    const opts = heldDataOpts();
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const old = await authCodeGrant(h, clientId);
      const live = await authCodeGrant(h, clientId);
      await revoke(h, h.ownerToken, old.grantId, { pdpp_disposition: "keep" });
      getDb().prepare("UPDATE oauth_clients SET metadata_json = json_set(metadata_json, '$.issuer_subject_id', 'owner_local') WHERE client_id = ?").run(clientId);
      const restore = loseHistory(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), "wiped");
      const result = await fetchJson<{ lifecycle: { status: string; grants: unknown[] } }>(`${h.asUrl}/oauth/register/${encodeURIComponent(clientId)}?pdpp_disposition=delete`, { method: "DELETE" });
      assert.equal(result.status, 202, JSON.stringify(result.body));
      assert.equal(result.body.lifecycle.status, "pending");
      assert.equal(result.body.lifecycle.grants.length, 2);
      restore();
      getHeldDataRuntime()!.authority.reestablishHistory();
      for (const g of [old, live]) {
        assert.equal((await status(h, g.accessToken, g.grantId)).body.grants[0]?.held_data, "erase");
      }
    }, opts);
  });

  it("D4: history loss during async grant lookup still records the owner action", async () => {
    const opts = heldDataOpts();
    await withServer(false, async (h) => {
      const g = await ordinaryGrant(h);
      const rt = getHeldDataRuntime()!;
      assert.equal(rt.authority.isKnown(g.grantId), false);
      const journal = join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal");
      rt.authority.registerGrant({ grantId: "lookup-witness", clientId: "witness", subjectId: "owner_local", confidential: false, streams: [], expiresAtMs: null });
      const prefix = readFileSync(journal, "utf8");
      rt.authority.end({ grantId: "lookup-witness", path: "owner_withdrawal", disposition: "keep" });
      const full = readFileSync(journal, "utf8");
      const accepting = endHeldDataForGrant(g.grantId, { path: "owner_withdrawal", disposition: "delete" });
      queueMicrotask(() => writeFileSync(journal, prefix));
      await assert.doesNotReject(accepting);
      assert.equal(rt.authority.pendingActions(g.grantId).length, 1);
      writeFileSync(journal, full);
      rt.authority.reestablishHistory();
      assert.equal(rt.authority.ownerView(g.grantId, DAY)?.erasures.length, 1);
      assert.equal(await rsRead(h, g.token), 403);
    }, opts);
  });

  it("D4: pending training revocation does not append to lost history and replays processing withdrawal", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      await status(h, g.token, g.grant.grant_id);
      const training = getTrainingLeaseRuntime()!;
      const restore = loseHistory(training.journalPath, "suffix");
      const damaged = readFileSync(training.journalPath, "utf8");
      const result = await revoke(h, h.ownerToken, g.grant.grant_id, { pdpp_disposition: "keep" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(readFileSync(training.journalPath, "utf8"), damaged, "all terminal effects wait for verified recovery");
      restore();
      getHeldDataRuntime()!.authority.reestablishHistory();
      assert.equal(training.store.status(g.grant.grant_id).state, "withdrawn");
      assert.equal(training.store.issueLease({ grantId: g.grant.grant_id, clientId: "concert_recommendation_app" }).ok, false);
    }, heldDataOpts());
  });

  it("D4: narrowing and later owner erasure are accepted while history is lost", async () => {
    const opts = heldDataOpts();
    await withServer(false, async (h) => {
      const narrow = await ordinaryGrant(h);
      const erase = await ordinaryGrant(h);
      await status(h, narrow.token, narrow.grantId);
      await status(h, erase.token, erase.grantId);
      const restore = loseHistory(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), "suffix");
      const result = await revoke(h, h.ownerToken, narrow.grantId, { pdpp_ending: "narrowing", pdpp_disposition: "delete" });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal((result.body as { lifecycle: { status: string } }).lifecycle.status, "pending");
      const erased = await owner(h, `/v1/owner/grants/${erase.grantId}/lifecycle/erase`, "POST");
      assert.equal(erased.status, 202, JSON.stringify(erased.body));
      restore();
      getHeldDataRuntime()!.authority.reestablishHistory();
      for (const g of [narrow, erase]) assert.equal((await status(h, g.token, g.grantId)).body.grants[0]?.held_data, "erase");
    }, opts);
  });

  it("flag off: no lifecycle endpoint, and owner revocation without a disposition works as before", async () => {
    await withServer(false, async (h) => {
      const g = await ordinaryGrant(h);
      assert.equal((await status(h, g.token, g.grantId)).status, 404);
      const r = await revoke(h, h.ownerToken, g.grantId);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await rsRead(h, g.token), 403);
    });
  });

  it("owner withdrawal: rejected without a disposition (nothing revoked); with keep, the copy stays usable by status", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        const missing = await revoke(h, h.ownerToken, g.grantId);
        assert.equal(missing.status, 400, JSON.stringify(missing.body));
        assert.equal(await rsRead(h, g.token), 200, "a rejected call revokes nothing");
        const kept = await revoke(h, h.ownerToken, g.grantId, {
          pdpp_disposition: "keep",
        });
        assert.equal(kept.status, 200, JSON.stringify(kept.body));
        assert.equal(await rsRead(h, g.token), 403);
        const s = await status(h, g.token, g.grantId);
        assert.equal(s.status, 200, JSON.stringify(s.body));
        assert.equal(s.body.grants[0]?.read_state, "revoked");
        assert.equal(s.body.grants[0]?.held_data, "permitted");
        assert.ok(s.body.grants[0]?.ended_at);
      },
      heldDataOpts(),
    );
  });

  it("client revocation with pdpp_disposition=delete: erasure reaches the client library over HTTP; the AS records delivery; FINDING: a public client has no current authentication left to confirm receipt", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        const app = new ToyApp();
        let t = Date.now();
        const client = new HeldDataClient({
          now: () => t,
          store: app,
          status: httpStatusTransport({
            asBaseUrl: h.asUrl,
            credentialFor: () => g.token,
          }),
        });
        app.attach(client);
        app.sync(g.grantId, [{ id: "a1", stream: "top_artists", text: "radiohead" }]);
        await client.reconcile();
        assert.equal(client.canUse(g.grantId).ok, true);
        const r = await revoke(h, g.token, g.grantId, {
          pdpp_disposition: "delete",
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        t += 1000;
        await client.onReadFailure(g.grantId);
        assert.deepEqual(client.canUse(g.grantId), {
          ok: false,
          reason: "deleted",
        });
        assert.deepEqual(app.holds(g.grantId), {
          records: 0,
          indexEntries: 0,
          summary: false,
        });
        const rec = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
        const op = (rec.body.erasures as Record<string, unknown>[])[0];
        assert.ok(op?.delivered_at);
        assert.equal(op?.delete_by, null);
        const receipt = await lifecycle(h, {
          grant_id: g.grantId,
          instruction_id: String(op?.operation_id),
          report: "received",
          reported_at: new Date().toISOString(),
          token: g.token,
        });
        assert.deepEqual(
          receipt.body.grants?.[0],
          { grant_id: g.grantId, error: "current_authentication_required" },
          "the revoked token cannot authenticate a write"
        );
      },
      heldDataOpts(),
    );
  });

  it("an expired single-use grant: a later owner erase reaches the client through the expired token; reads stay closed", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        await mutateMainDatabase("UPDATE grants SET expires_at = ? WHERE grant_id = ?", ["2000-01-01T00:00:00.000Z", g.grantId]);
        await mutateMainDatabase("UPDATE tokens SET expires_at = ? WHERE grant_id = ?", ["2000-01-01T00:00:00.000Z", g.grantId]);
        assert.equal(await rsRead(h, g.token), 403);
        const before = await status(h, g.token, g.grantId);
        assert.equal(before.body.grants[0]?.read_state, "expired");
        assert.equal(before.body.grants[0]?.held_data, "permitted");
        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        const after = await status(h, g.token, g.grantId);
        assert.equal(after.body.grants[0]?.held_data, "erase");
        assert.equal(await rsRead(h, g.token), 403, "status never reopens reads");
      },
      heldDataOpts(),
    );
  });

  it("a restore of the main database that resurrects an ended grant reopens neither reads nor a positive answer", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        await revoke(h, h.ownerToken, g.grantId, {
          pdpp_disposition: "delete",
        });
        // The main database comes back from a backup taken before the revocation.
        await mutateMainDatabase("UPDATE grants SET status = 'active' WHERE grant_id = ?", [g.grantId]);
        await mutateMainDatabase("UPDATE tokens SET revoked = FALSE WHERE grant_id = ?", [g.grantId]);
        assert.equal(await rsRead(h, g.token), 403, "the journal's ending blocks reads");
        const s = await status(h, g.token, g.grantId);
        assert.equal(s.body.grants[0]?.held_data, "erase");
      },
      heldDataOpts(),
    );
  });

  it("refresh replay is not an ending: the family is revoked, the grant is not, and the superseded refresh token still reads status", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const r1 = await fetchJson<{ refresh_token: string }>(
          `${h.asUrl}/oauth/token`,
          form({
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: g.refreshToken,
          }),
        );
        assert.equal(r1.status, 200, JSON.stringify(r1.body));
        const replay = await fetchJson(
          `${h.asUrl}/oauth/token`,
          form({
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: g.refreshToken,
          }),
        );
        assert.equal(replay.status, 400);
        const s = await status(h, g.refreshToken, g.grantId);
        assert.equal(s.status, 200, JSON.stringify(s.body));
        assert.equal(s.body.grants[0]?.read_state, "active");
        assert.equal(s.body.grants[0]?.held_data, "permitted");
        assert.equal(getHeldDataRuntime()?.authority.hasEnded(g.grantId), false);
      },
      heldDataOpts(),
    );
  });

  it("package disconnect: rejected without a disposition; delete covers every child including one withdrawn earlier with keep; partial failure is reported per child", async () => {
    await withServer(
      false,
      async (h) => {
        const github = await registerSecondConnector(h);
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, github]);
        assert.equal(pkg.children.length, 2);
        const [c1, c2] = pkg.children as [string, string];
        const noDisp = await fetchJson(`${h.asUrl}/_ref/grant-packages/${pkg.packageId}/revoke`, json({}));
        assert.equal(noDisp.status, 400, JSON.stringify(noDisp.body));
        // One child withdrawn first, with keep.
        const one = await revoke(h, h.ownerToken, c1, {
          pdpp_disposition: "keep",
          pdpp_ending: "one_child_withdrawal",
        });
        assert.equal(one.status, 200, JSON.stringify(one.body));
        const rt = getHeldDataRuntime();
        assert.equal(rt?.authority.hasEnded(c2), false, "the sibling survives");
        const all = await fetchJson<{ status: string }>(
          `${h.asUrl}/_ref/grant-packages/${pkg.packageId}/revoke`,
          json({ pdpp_disposition: "delete" }),
        );
        assert.equal(all.status, 200, JSON.stringify(all.body));
        for (const c of [c1, c2]) {
          const v = rt?.authority.ownerView(c, DAY);
          assert.equal(v?.erasures.length, 1, `${c} has an erasure`);
        }
        assert.equal(
          rt?.authority.ownerView(c1, DAY)?.ending?.disposition,
          "keep",
          "the earlier ending is kept; the erase is a new operation",
        );

        // Partial failure: a second package with one broken child.
        const pkg2 = await packageFlow(h, clientId, [h.connectorId, github]);
        const [broken, healthy] = pkg2.children as [string, string];
        await mutateMainDatabase("UPDATE grants SET grant_json = ? WHERE grant_id = ?", ['{"not":"a valid persisted grant"}', broken]);
        const partial = await fetchJson<{
          status: string;
          not_revoked_child_grants: { grant_id: string }[];
        }>(`${h.asUrl}/_ref/grant-packages/${pkg2.packageId}/revoke`, json({ pdpp_disposition: "delete" }));
        assert.equal(partial.status, 500);
        assert.equal(partial.body.status, "partial_failure");
        assert.equal(rt?.authority.hasEnded(healthy), true);
        assert.equal(rt?.authority.hasEnded(broken), false, "no ending is journaled for the child that did not end");
      },
      heldDataOpts(),
    );
  });

  it("whole-client disconnect: rejected without a disposition; with delete, every grant of the client gets an erasure, including one ended earlier", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g1 = await authCodeGrant(h, clientId);
        const g2 = await authCodeGrant(h, clientId);
        await revoke(h, h.ownerToken, g1.grantId, { pdpp_disposition: "keep" });
        // Bind the client to the owner, as the owner device flow would.
        await mutateMainDatabase(
          "UPDATE oauth_clients SET metadata_json = json_set(metadata_json, '$.issuer_subject_id', 'owner_local') WHERE client_id = ?",
          [clientId],
          "UPDATE oauth_clients SET metadata_json = jsonb_set(metadata_json, '{issuer_subject_id}', '\"owner_local\"') WHERE client_id = ?",
        );
        const no = await fetch(`${h.asUrl}/oauth/register/${encodeURIComponent(clientId)}`, { method: "DELETE" });
        assert.equal(no.status, 400, await no.text());
        const yes = await fetch(`${h.asUrl}/oauth/register/${encodeURIComponent(clientId)}?pdpp_disposition=delete`, {
          method: "DELETE",
        });
        assert.equal(yes.status, 204, await yes.text());
        const rt = getHeldDataRuntime();
        for (const g of [g1, g2]) {
          assert.equal(rt?.authority.ownerView(g.grantId, DAY)?.erasures.length, 1);
        }
        const s = await status(h, g2.refreshToken, g2.grantId);
        assert.equal(s.body.grants[0]?.held_data, "erase", "a deleted client's tokens still read status");
      },
      heldDataOpts(),
    );
  });

  it("a compromised lifecycle credential is replaced with an owner recovery code; the replacement reads status, never data", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        assert.equal((await status(h, g.token, g.grantId)).status, 200);
        getHeldDataRuntime()?.authority.disableCredential(g.token);
        assert.equal((await status(h, g.token, g.grantId)).status, 401);
        const code = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/recovery-code`, "POST");
        const rec = await fetchJson<{ status_credential: string }>(
          `${h.asUrl}/oauth/grant-lifecycle/recover`,
          json({ grant_id: g.grantId, recovery_code: code.body.recovery_code }),
        );
        assert.equal(rec.status, 200, JSON.stringify(rec.body));
        assert.equal((await status(h, rec.body.status_credential, g.grantId)).status, 200);
        assert.equal(await rsRead(h, rec.body.status_credential), 401, "a status credential is not an access token");
        const reuse = await fetchJson(
          `${h.asUrl}/oauth/grant-lifecycle/recover`,
          json({ grant_id: g.grantId, recovery_code: code.body.recovery_code }),
        );
        assert.equal(reuse.status, 400);
      },
      heldDataOpts(),
    );
  });

  it("B3 at the lease endpoint: erasing acquisition grant G1 ends leases naming it while training grant G2 stays live", async () => {
    await withServer(
      true,
      async (h) => {
        const g1 = await ordinaryGrant(h);
        const g2 = await issueTrainingGrant(h);
        const c = new PublicLeaseClient(h, g2.grant.grant_id);
        const boot = await fetchJson<{
          lease?: string;
          lease_credential?: string;
        }>(
          `${h.asUrl}/oauth/processing-lease`,
          json(
            {
              grant_id: g2.grant.grant_id,
              acquisition_grant_ids: [g1.grantId],
            },
            { Authorization: `Bearer ${g2.token}`, DPoP: c.proof() },
          ),
        );
        assert.equal(boot.status, 200, JSON.stringify(boot.body));
        c.credential = boot.body.lease_credential ?? null;
        const claims = JSON.parse(
          Buffer.from((boot.body.lease as string).split(".")[1] as string, "base64url").toString(),
        );
        assert.deepEqual(claims.acq, [g1.grantId]);
        const erase = await owner(h, `/v1/owner/grants/${g1.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        const renew = await fetchJson(
          `${h.asUrl}/oauth/processing-lease`,
          json(
            {
              grant_id: g2.grant.grant_id,
              lease_credential: c.credential,
              acquisition_grant_ids: [g1.grantId],
            },
            { DPoP: c.proof() },
          ),
        );
        assert.equal(renew.status, 400, "no lease names the erased copy");
        const plain = await c.renew();
        assert.equal(plain.status, 200, "G2 itself is live");
      },
      heldDataOpts(),
    );
  });

  it("Core wire: after an owner erase, the public client's superseded and current refresh tokens both fail to write (revocation killed the family); only a recovered credential can report receipt, and only then is a deletion date shown", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const r1 = await fetchJson<{ refresh_token: string }>(
          `${h.asUrl}/oauth/token`,
          form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken })
        );
        assert.equal(r1.status, 200);
        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        assert.equal(await rsRead(h, g.accessToken), 403, "an erase on an active grant also revokes it");
        const q = await status(h, g.refreshToken, g.grantId);
        const erasure = q.body.grants[0]?.erasure as { instruction_id: string; stop_use_by: string; accepted_at: string };
        assert.equal(q.body.grants[0]?.held_data, "erase");
        assert.equal(Date.parse(erasure.stop_use_by) - Date.parse(erasure.accepted_at), 2 * DAY);
        const receivedAt = new Date().toISOString();
        const write = { grant_id: g.grantId, instruction_id: erasure.instruction_id, report: "received", reported_at: receivedAt };
        const future = await lifecycle(h, { ...write, reported_at: new Date(Date.now() + DAY).toISOString(), token: r1.body.refresh_token });
        assert.equal(future.status, 400);
        const superseded = await lifecycle(h, { ...write, token: g.refreshToken });
        assert.equal(superseded.body.grants[0]?.error, "current_authentication_required");
        const both = await lifecycle(h, { ...write, pdpp_disposition: "delete", token: r1.body.refresh_token });
        assert.equal(both.status, 400);
        const before = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
        assert.equal((before.body.erasures as Record<string, unknown>[])[0]?.delete_by, null);
        // Revocation revoked the refresh family too, so a revoked grant's public client has no current token left.
        const current = await lifecycle(h, { ...write, token: r1.body.refresh_token });
        assert.equal(current.body.grants[0]?.error, "current_authentication_required");
        const code = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/recovery-code`, "POST");
        const rec = await fetchJson<{ status_credential: string }>(
          `${h.asUrl}/oauth/grant-lifecycle/recover`,
          json({ grant_id: g.grantId, recovery_code: code.body.recovery_code })
        );
        const viaRecovery = await lifecycle(h, { ...write, token: rec.body.status_credential });
        assert.equal(viaRecovery.body.grants[0]?.held_data, "erase", JSON.stringify(viaRecovery.body));
        const afterRec = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
        const op = (afterRec.body.erasures as Record<string, unknown>[])[0];
        assert.equal(op?.receipt_at, receivedAt);
        assert.equal(Date.parse(String(op?.delete_by)) - Date.parse(receivedAt), 30 * DAY);
      },
      heldDataOpts()
    );
  });

  it("reported_at skew: a client ten days ahead retries once with AS-mapped event time over HTTP", async () => {
    const clock = { now: Date.now() };
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const g = await authCodeGrant(h, clientId);
      await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
      const code = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/recovery-code`, "POST");
      const recovered = await fetchJson<{ status_credential: string }>(
        `${h.asUrl}/oauth/grant-lifecycle/recover`,
        json({ grant_id: g.grantId, recovery_code: code.body.recovery_code })
      );
      const q = await status(h, recovered.body.status_credential, g.grantId);
      const instruction = (q.body.grants[0]?.erasure as { instruction_id: string }).instruction_id;
      const receiptAt = clock.now + 10 * DAY;
      let reportAttempts = 0;
      const statuses: number[] = [];
      const transport = httpReportTransport({
        asBaseUrl: h.asUrl,
        currentTokenFor: () => recovered.body.status_credential,
        now: () => receiptAt,
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          if (new URLSearchParams(String(init?.body)).has("report")) {
            reportAttempts += 1;
            statuses.push(response.status);
          }
          return response;
        },
      });
      assert.equal(await transport({ grantId: g.grantId, operationId: instruction, kind: "receipt", reportedAt: receiptAt }), true);
      assert.equal(reportAttempts, 2);
      assert.deepEqual(statuses, [400, 200]);
      const ownerRecord = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
      const erasure = (ownerRecord.body.erasures as Record<string, unknown>[])[0];
      assert.equal(Date.parse(String(erasure?.receipt_at)), clock.now);
      assert.equal(Date.parse(String(erasure?.delete_by)), clock.now + 30 * DAY);
      assert.equal(await transport({ grantId: g.grantId, operationId: instruction, kind: "completion", reportedAt: receiptAt }), true);
      assert.equal(reportAttempts, 3, "a learned conservative mapping avoids another rejected report");
    }, heldDataOpts(clock));
  });

  it("Core wire: pdpp_disposition=delete from a client with current authentication records the instruction and ends the grant", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        const w = await lifecycle(h, { grant_id: g.grantId, pdpp_disposition: "delete", token: g.token });
        assert.equal(w.status, 200, JSON.stringify(w.body));
        assert.equal(w.body.grants[0]?.held_data, "erase");
        assert.equal(w.body.grants[0]?.read_state, "revoked");
        assert.equal(await rsRead(h, g.token), 403);
      },
      heldDataOpts()
    );
  });

  it("D2: unknown, foreign and uncovered grants get identical invalid_grant entries", async () => {
    await withServer(
      false,
      async (h) => {
        const mine = await ordinaryGrant(h);
        const clientId = await registerPublicClient(h);
        const theirs = await authCodeGrant(h, clientId);
        const foreign = await status(h, mine.token, theirs.grantId);
        const unknown = await status(h, mine.token, "grt_does_not_exist");
        assert.equal(foreign.status, unknown.status);
        assert.deepEqual(foreign.body.grants[0], { grant_id: theirs.grantId, error: "invalid_grant" });
        assert.deepEqual(unknown.body.grants[0], { grant_id: "grt_does_not_exist", error: "invalid_grant" });
        const bad = await status(h, "not-a-token", mine.grantId);
        assert.equal(bad.status, 401);
      },
      heldDataOpts()
    );
  });

  it("D1: after a main-database restore resurrects a revoked continuous grant, the refresh exchange issues no token", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "delete" });
        await mutateMainDatabase("UPDATE grants SET status = 'active' WHERE grant_id = ?", [g.grantId]);
        await mutateMainDatabase("UPDATE tokens SET revoked = FALSE WHERE grant_id = ?", [g.grantId]);
        await mutateMainDatabase("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?", [g.grantId]);
        const r = await fetchJson(
          `${h.asUrl}/oauth/token`,
          form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken })
        );
        assert.equal(r.status, 400, JSON.stringify(r.body));
      },
      heldDataOpts()
    );
  });

  for (const disposition of ["keep", "delete"]) {
    it(`lane B: minting for a restored grant ended with ${disposition} fails before inserting a token`, async () => {
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          assert.equal(
            (
              await revoke(h, h.ownerToken, g.grantId, {
                pdpp_disposition: disposition,
              })
            ).status,
            200
          );
          restoreGrantRows(g.grantId);
          const before = getDb().prepare("SELECT count(*) AS n FROM tokens").get() as { n: number };
          await assert.rejects(issueToken(g.grantId, "owner_local", clientId, null), { code: "grant_revoked" });
          assert.deepEqual(getDb().prepare("SELECT count(*) AS n FROM tokens").get(), before);
        },
        heldDataOpts()
      );
    });

    it(`lane B: consent exchange replay cannot redeliver a restored grant ended with ${disposition}`, async () => {
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          const info = await introspect(g.accessToken);
          const proof = "client-held-recovery-proof";
          const code = await createConsentExchangeCode({
            grantId: g.grantId,
            token: g.accessToken,
            grant: info.grant as Record<string, unknown>,
            recoveryProof: proof,
          });
          assert.equal((await fetchJson(`${h.asUrl}/consent/exchange`, json({ code, proof }))).status, 200);
          assert.equal(
            (
              await revoke(h, h.ownerToken, g.grantId, {
                pdpp_disposition: disposition,
              })
            ).status,
            200
          );
          restoreGrantRows(g.grantId);
          const replay = await fetchJson(`${h.asUrl}/consent/exchange`, json({ code, proof }));
          assert.equal(replay.status, 404, `restored consent exchange returned ${replay.status}`);
          assert.equal(replay.body.token, undefined);
        },
        heldDataOpts()
      );
    });
  }

  for (const path of ["authorization_code", "device_code", "refresh_token", "introspection", "consent_exchange"]) {
    it(`lane B: ${path} refuses a package whose restored children all ended in the journal`, async () => {
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const p =
            path === "device_code" ? await devicePackage(h, clientId) : await packageFlow(h, clientId, [h.connectorId]);
          const proof = "package-recovery-proof";
          const exchangeCode = await createConsentExchangeCode({
            grantId: p.packageId,
            token: p.packageToken,
            grant: {
              package_id: p.packageId,
              child_grants: p.children.map((grant_id) => ({ grant_id })),
            },
            recoveryProof: proof,
          });
          const poll = () =>
            fetchJson(
              `${h.asUrl}/oauth/token`,
              form({
                client_id: clientId,
                device_code: "deviceCode" in p && typeof p.deviceCode === "string" ? p.deviceCode : "",
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              })
            );
          if (path === "device_code") {
            const first = await poll();
            assert.equal(first.status, 200, JSON.stringify(first.body));
          }
          for (const grantId of p.children) {
            assert.equal(
              (
                await revoke(h, h.ownerToken, grantId, {
                  pdpp_disposition: "delete",
                })
              ).status,
              200
            );
            restoreGrantRows(grantId);
          }
          // Also restore family state: revoking a child may revoke a package refresh family.
          getDb()
            .prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE package_id = ?")
            .run(p.packageId);
          if (path === "introspection") {
            assert.equal(
              (await introspect(p.packageToken)).active,
              false,
              "restored package introspection returned active"
            );
          } else {
            if (path === "authorization_code") restoreAuthorizationCode(p.code, p.packageToken);
            const r =
              path === "device_code"
                ? await poll()
                : path === "consent_exchange"
                  ? await fetchJson(`${h.asUrl}/consent/exchange`, json({ code: exchangeCode, proof }))
                  : await fetchJson(
                      `${h.asUrl}/oauth/token`,
                      form(
                        path === "authorization_code"
                          ? {
                              client_id: clientId,
                              code: p.code,
                              code_verifier: p.verifier,
                              grant_type: path,
                              redirect_uri: REDIRECT,
                            }
                          : {
                              client_id: clientId,
                              grant_type: path,
                              refresh_token: p.refreshToken,
                            }
                      )
                    );
            assert.equal(
              r.status,
              path === "consent_exchange" ? 404 : 400,
              `${path} returned ${r.status} for journal-ended package`
            );
            assert.equal(r.body.access_token, undefined);
            assert.equal(r.body.refresh_token, undefined);
          }
          const access = await getGrantPackageAccess(p.packageId);
          assert.deepEqual(access?.members, [], "direct fan-out must hide restored ended grants");
        },
        heldDataOpts()
      );
    });
  }

  it("lane B: lost history blocks fresh issuance, package introspection and all token redelivery", async () => {
    const opts = heldDataOpts();
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const untracked = await authCodeGrant(h, clientId);
        const p = await packageFlow(h, clientId, [h.connectorId]);
        const code = await createConsentExchangeCode({
          grantId: g.grantId,
          token: g.accessToken,
          grant: (await introspect(g.accessToken)).grant as Record<string, unknown>,
        });
        // Acknowledged endings advance independent evidence; truncate the history only.
        assert.equal(
          (
            await revoke(h, h.ownerToken, g.grantId, {
              pdpp_disposition: "keep",
            })
          ).status,
          200
        );
        restoreGrantRows(g.grantId);
        const rt = getHeldDataRuntime();
        assert.ok(rt);
        truncateSync(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), 0);
        assert.equal(rt.authority.lost, true);
        await assert.rejects(issueToken(untracked.grantId, "owner_local", clientId, null), { code: "invalid_grant" });
        await assert.rejects(issueToken(g.grantId, "owner_local", clientId, null), { code: "invalid_grant" });
        assert.equal((await introspect(p.packageToken)).active, false);
        assert.equal((await fetchJson(`${h.asUrl}/consent/exchange`, json({ code }))).status, 404);
        assert.equal(
          (
            await fetchJson(
              `${h.asUrl}/oauth/token`,
              form({
                client_id: clientId,
                grant_type: "refresh_token",
                refresh_token: p.refreshToken,
              })
            )
          ).status,
          400
        );
        assert.deepEqual((await getGrantPackageAccess(p.packageId))?.members, []);
      },
      opts
    );
  });

  it("lane B: CIMD confidential tokens alone cannot query; client authentication can", async () => {
    const c = cimdClient();
    const cimdFetchDependencies = {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (input: unknown) =>
        new Response(JSON.stringify(String(input) === c.jwksUri ? c.jwks : c.doc), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      isGlobalUnicastAddressImpl: () => true,
    };
    await withServer(
      false,
      async (h) => {
        const g = await authCodeGrant(h, c.clientId, {
          redirect: c.doc.redirect_uris[0] as string,
          tokenAuth: (aud) => clientAuth(c, aud),
        });
        const tokenOnly = await status(h, g.accessToken, g.grantId);
        assert.equal(tokenOnly.status, 200);
        assert.equal(tokenOnly.body.grants[0]?.error, "invalid_grant", "CIMD token alone returned a lifecycle answer");
        assert.equal(tokenOnly.body.grants[0]?.held_data, undefined);
        const authenticated = await lifecycle(h, {
          grant_id: g.grantId,
          ...clientAuth(c, h.asUrl),
        });
        assert.equal(authenticated.status, 200);
        assert.equal(authenticated.body.grants[0]?.held_data, "permitted");
      },
      { ...heldDataOpts(), cimdFetchDependencies } as never
    );
  });

  for (const [replay, mixed] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const delivery = replay ? "replay" : "first delivery";
    const target = mixed ? "package child" : "grant";
    it(`lane B: agent-connect ${delivery} refuses a restored ended ${target}`, async () => {
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const p = mixed ? await devicePackage(h, clientId) : null;
          const g = p ? { grantId: p.packageId, accessToken: p.packageToken } : await authCodeGrant(h, clientId);
          const grant = p
            ? { package_id: p.packageId, child_grants: p.children.map((grant_id) => ({ grant_id })) }
            : (await introspect(g.accessToken)).grant;
          const ended = p?.children[0] ?? g.grantId;
          const id = `att_${randomBytes(8).toString("hex")}`;
          const pollingCode = "test-polling-proof";
          getDb()
            .prepare(`INSERT INTO agent_connect_attempts(
            id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
            interval_seconds, created_at, expires_at_ms, completed_at, grant_id, grant_json, token
          ) VALUES(?, ?, ?, ?, 'approved', ?, ?, 2, ?, ?, ?, ?, ?, ?)`)
            .run(
              id,
              `urn:test:${id}`,
              clientId,
              createHash("sha256").update(pollingCode).digest("base64url"),
              `${h.asUrl}/consent`,
              `${h.asUrl}/agent-connect/token`,
              new Date().toISOString(),
              Date.now() + DAY,
              new Date().toISOString(),
              g.grantId,
              JSON.stringify(grant),
              g.accessToken
            );
          const store = createAgentConnectAttemptStore();
          if (replay) {
            assert.equal((await store.redeem(id, pollingCode)).outcome, "approved");
            if (p) {
              // The cached response still lists both children; check it, not the updated grant snapshot.
              getDb().prepare("UPDATE agent_connect_attempts SET grant_json = ? WHERE id = ?").run(
                JSON.stringify({ package_id: p.packageId, child_grants: [{ grant_id: p.children[1] }] }),
                id
              );
            }
          }
          assert.equal(
            (
              await revoke(h, h.ownerToken, ended, {
                pdpp_disposition: "delete",
              })
            ).status,
            200
          );
          restoreGrantRows(ended);
          assert.equal((await store.redeem(id, pollingCode)).outcome, "missing", "agent-connect returned restored token");
        },
        heldDataOpts()
      );
    });
  }

  it("lane B: the first introspection after journal corruption fails closed", async () => {
    const opts = heldDataOpts();
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h, { access_mode: "continuous" });
        assert.equal((await status(h, g.token, g.grantId)).status, 200);
        appendFileSync(
          join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"),
          "unreadable terminal event\n"
        );
        assert.equal((await introspect(g.token)).active, false, "first check after corrupt history returned active");
        assert.equal(await rsRead(h, g.token), 403);
      },
      opts
    );
  });

  it("lane B: CIMD public tokens still query without client authentication", async () => {
    const c = cimdClient();
    const doc = { ...c.doc, token_endpoint_auth_method: "none" };
    const cimdFetchDependencies = {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async () =>
        new Response(JSON.stringify(doc), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      isGlobalUnicastAddressImpl: () => true,
    };
    await withServer(
      false,
      async (h) => {
        const g = await authCodeGrant(h, c.clientId, {
          redirect: doc.redirect_uris[0] as string,
        });
        const q = await status(h, g.accessToken, g.grantId);
        assert.equal(q.status, 200);
        assert.equal(q.body.grants[0]?.held_data, "permitted");
      },
      { ...heldDataOpts(), cimdFetchDependencies } as never
    );
  });

  /** CIMD fixture whose metadata host can be made unreachable mid-test. */
  function unreachableCimd(confidential: boolean) {
    const c = cimdClient();
    const doc = confidential ? c.doc : { ...c.doc, token_endpoint_auth_method: "none" };
    const host = { reachable: true };
    const cimdFetchDependencies = {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (input: unknown) => {
        if (!host.reachable) throw new Error("metadata host unreachable");
        return new Response(JSON.stringify(String(input) === c.jwksUri ? c.jwks : doc), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
      isGlobalUnicastAddressImpl: () => true,
    };
    const grant = (h: Harness) =>
      authCodeGrant(h, c.clientId, {
        redirect: doc.redirect_uris[0] as string,
        ...(confidential ? { tokenAuth: (aud: string) => clientAuth(c, aud) } : {}),
      });
    return { c, host, cimdFetchDependencies, grant };
  }

  for (const confidential of [true, false]) {
    const kind = confidential ? "confidential" : "public";
    it(`second-B repair: an owner ending of a tracked ${kind} CIMD grant needs no metadata fetch`, async () => {
      const f = unreachableCimd(confidential);
      await withServer(
        false,
        async (h) => {
          const g = await f.grant(h);
          const rt = getHeldDataRuntime()!;
          assert.equal(await ensureHeldDataGrant(g.grantId), true);
          assert.equal(rt.authority.isKnown(g.grantId), true);
          f.host.reachable = false;
          invalidateCimdCache(f.c.clientId);
          const ended = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "keep" });
          assert.equal(ended.status, 200, JSON.stringify(ended.body));
          assert.equal(rt.authority.hasEnded(g.grantId), true, "journal did not record the ending");
          assert.equal((await introspect(g.accessToken)).active, false);
        },
        { ...heldDataOpts(), cimdFetchDependencies: f.cimdFetchDependencies } as never
      );
    });

    it(`second-B repair: a security metadata change ends every tracked ${kind} CIMD grant without a fetch`, async () => {
      const f = unreachableCimd(confidential);
      await withServer(
        false,
        async (h) => {
          const first = await f.grant(h);
          const second = await f.grant(h);
          const rt = getHeldDataRuntime()!;
          f.host.reachable = false;
          // The cascade runs after the cache entry is deleted.
          invalidateCimdCache(f.c.clientId);
          await revokeCimdClientAccessForSecurityMetadataChange({ clientId: f.c.clientId });
          for (const g of [first, second]) {
            assert.equal(rt.authority.hasEnded(g.grantId), true, `${g.grantId} was not ended`);
            assert.equal((await introspect(g.accessToken)).active, false);
          }
        },
        { ...heldDataOpts(), cimdFetchDependencies: f.cimdFetchDependencies } as never
      );
    });
  }

  it("second-B repair: an owner action during history loss classifies an unresolvable CIMD client as confidential", async () => {
    const opts = heldDataOpts();
    const f = unreachableCimd(true);
    await withServer(
      false,
      async (h) => {
        const g = await f.grant(h);
        const rt = getHeldDataRuntime()!;
        const restore = loseHistory(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), "wiped");
        assert.equal(rt.authority.isKnown(g.grantId), false, "wiped history still knows the grant");
        f.host.reachable = false;
        invalidateCimdCache(f.c.clientId);
        const ended = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "keep" });
        assert.equal(ended.status, 200, JSON.stringify(ended.body));
        const [action] = rt.authority.pendingActions(g.grantId);
        assert.equal(action?.grant.confidential, true, "a confidential client was staged as public");
        restore();
        rt.authority.reestablishHistory();
        assert.equal(rt.authority.hasEnded(g.grantId), true);
        assert.equal((await introspect(g.accessToken)).active, false);
      },
      { ...opts, cimdFetchDependencies: f.cimdFetchDependencies } as never
    );
  });

  for (const replay of [false, true]) {
    const delivery = replay ? "replay" : "first delivery";
    it(`second-B repair: agent-connect ${delivery} keeps a live grant's attempt during history recovery`, async () => {
      const opts = heldDataOpts();
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const unrelated = await authCodeGrant(h, clientId);
          const g = await authCodeGrant(h, clientId);
          const grant = (await introspect(g.accessToken)).grant;
          const id = `att_${randomBytes(8).toString("hex")}`;
          const pollingCode = "recovery-polling-proof";
          getDb()
            .prepare(`INSERT INTO agent_connect_attempts(
            id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
            interval_seconds, created_at, expires_at_ms, completed_at, grant_id, grant_json, token
          ) VALUES(?, ?, ?, ?, 'approved', ?, ?, 2, ?, ?, ?, ?, ?, ?)`)
            .run(
              id,
              `urn:test:${id}`,
              clientId,
              createHash("sha256").update(pollingCode).digest("base64url"),
              `${h.asUrl}/consent`,
              `${h.asUrl}/agent-connect/token`,
              new Date().toISOString(),
              Date.now() + DAY,
              new Date().toISOString(),
              g.grantId,
              JSON.stringify(grant),
              g.accessToken
            );
          const store = createAgentConnectAttemptStore();
          if (replay) {
            assert.equal((await store.redeem(id, pollingCode)).outcome, "approved");
          }
          const restore = loseHistory(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), "suffix");
          const pending = await revoke(h, h.ownerToken, unrelated.grantId, { pdpp_disposition: "keep" });
          assert.equal(pending.status, 200, JSON.stringify(pending.body));
          assert.equal((await store.redeem(id, pollingCode)).outcome, "temporary", "lost history");
          const polled = await fetch(`${h.asUrl}/agent-connect/${id}/token`, json({ polling_code: pollingCode }));
          assert.equal(polled.status, 503, await polled.text());
          assert.equal(polled.headers.get("retry-after"), "60");
          restore();
          assert.equal(
            (await store.redeem(id, pollingCode)).outcome,
            "temporary",
            "restored history with another grant's pending action"
          );
          getHeldDataRuntime()!.authority.reestablishHistory();
          const delivered = await store.redeem(id, pollingCode);
          assert.equal(delivered.outcome, "approved", JSON.stringify(delivered));
          if (delivered.outcome === "approved") {
            assert.equal(delivered.body.access_token, g.accessToken);
            assert.equal(delivered.replay, replay);
          }
        },
        opts
      );
    });
  }

  it("lane B: a shared package credential stays active for its live sibling; fan-out excludes the restored ended child", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const second = await registerSecondConnector(h);
        const p = await packageFlow(h, clientId, [h.connectorId, second]);
        const ended = p.children[0] as string;
        assert.equal((await revoke(h, h.ownerToken, ended, { pdpp_disposition: "delete" })).status, 200);
        restoreGrantRows(ended);
        assert.equal((await introspect(p.packageToken)).active, true);
        const access = await getGrantPackageAccess(p.packageId);
        const members = access?.members as { grant_id: string }[];
        assert.deepEqual(
          members.map((m) => m.grant_id),
          p.children.filter((id) => id !== ended)
        );
        const refreshed = await fetchJson(
          `${h.asUrl}/oauth/token`,
          form({ client_id: clientId, grant_type: "refresh_token", refresh_token: p.refreshToken })
        );
        assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
      },
      heldDataOpts()
    );
  });

  for (const path of ["consent_exchange", "approval_retry"]) {
    it(`lane B: mixed-package ${path} never returns the restored erased child`, async () => {
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const p = await devicePackage(h, clientId);
          const proof = "mixed-package-proof";
          const code = await createConsentExchangeCode({
            grantId: p.packageId,
            token: p.packageToken,
            grant: { package_id: p.packageId },
            recoveryProof: proof,
          });
          const ended = p.children[0] as string;
          assert.equal((await revoke(h, h.ownerToken, ended, { pdpp_disposition: "delete" })).status, 200);
          restoreGrantRows(ended);
          let grant: Record<string, unknown>;
          if (path === "consent_exchange") {
            const response = await fetchJson(`${h.asUrl}/consent/exchange`, json({ code, proof }));
            assert.equal(response.status, 200, JSON.stringify(response.body));
            grant = response.body.grant as Record<string, unknown>;
          } else {
            grant = (await approveGrant(p.deviceCode, "owner_local")).grant;
          }
          assert.deepEqual(
            (grant.child_grants as { grant_id: string }[]).map((child) => child.grant_id),
            p.children.filter((id) => id !== ended),
            `${path} returned an erased child with the live sibling`
          );
        },
        heldDataOpts()
      );
    });
  }

  it("lane B: a restored single-grant authorization code is refused before consumption", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "keep" })).status, 200);
        restoreGrantRows(g.grantId);
        restoreAuthorizationCode(g.code, g.accessToken);
        const r = await fetchJson(
          `${h.asUrl}/oauth/token`,
          form({
            client_id: clientId,
            code: g.code,
            code_verifier: g.verifier,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT,
          })
        );
        assert.equal(r.status, 400);
        assert.equal(
          (
            getDb().prepare("SELECT status FROM oauth_authorization_codes WHERE code = ?").get(g.code) as {
              status: string;
            }
          ).status,
          "issued"
        );
      },
      heldDataOpts()
    );
  });

  it("lane B: flag off preserves direct minting and consent-code delivery from restored database rows", async () => {
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const g = await authCodeGrant(h, clientId);
      const grant = (await introspect(g.accessToken)).grant as Record<string, unknown>;
      const code = await createConsentExchangeCode({ grantId: g.grantId, token: g.accessToken, grant });
      assert.equal((await revoke(h, h.ownerToken, g.grantId)).status, 200);
      restoreGrantRows(g.grantId);
      assert.equal(typeof (await issueToken(g.grantId, "owner_local", clientId, null)), "string");
      assert.equal((await fetchJson(`${h.asUrl}/consent/exchange`, json({ code }))).status, 200);
    });
  });

  it("lane B: flag off preserves mixed-package child summaries on consent delivery and approval retry", async () => {
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const p = await devicePackage(h, clientId);
      const code = await createConsentExchangeCode({
        grantId: p.packageId,
        token: p.packageToken,
        grant: { package_id: p.packageId },
      });
      const ended = p.children[0] as string;
      assert.equal((await revoke(h, h.ownerToken, ended)).status, 200);
      restoreGrantRows(ended);
      const response = await fetchJson(`${h.asUrl}/consent/exchange`, json({ code }));
      assert.equal(response.status, 200);
      const retried = await approveGrant(p.deviceCode, "owner_local");
      for (const grant of [response.body.grant as Record<string, unknown>, retried.grant]) {
        assert.deepEqual((grant.child_grants as { grant_id: string }[]).map((child) => child.grant_id), p.children);
      }
    });
  });

  it("review fix: a public client's current refresh token authenticates pdpp_disposition=delete; an expired one and one for a journal-ended grant do not", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const live = await authCodeGrant(h, clientId);
        const ok = await lifecycle(h, { grant_id: live.grantId, pdpp_disposition: "delete", token: live.refreshToken });
        assert.equal(ok.body.grants[0]?.held_data, "erase", JSON.stringify(ok.body));
        assert.equal(await rsRead(h, live.accessToken), 403);

        const expired = await authCodeGrant(h, clientId);
        await mutateMainDatabase("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE grant_id = ?", ["2000-01-01T00:00:00.000Z", expired.grantId]);
        const e = await lifecycle(h, { grant_id: expired.grantId, pdpp_disposition: "delete", token: expired.refreshToken });
        assert.equal(e.body.grants[0]?.error, "current_authentication_required");
        assert.equal(getHeldDataRuntime()?.authority.hasEnded(expired.grantId), false, "nothing was revoked");

        const restored = await authCodeGrant(h, clientId);
        await revoke(h, h.ownerToken, restored.grantId, { pdpp_disposition: "keep" });
        await mutateMainDatabase("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?", [restored.grantId]);
        const r = await lifecycle(h, { grant_id: restored.grantId, pdpp_disposition: "delete", token: restored.refreshToken });
        assert.equal(r.body.grants[0]?.error, "current_authentication_required");
      },
      heldDataOpts()
    );
  });

  it("review fix: narrowing with delete reaches the client as `erase` (whole old copy, Core)", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        const n = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "delete", pdpp_ending: "narrowing" });
        assert.equal(n.status, 200, JSON.stringify(n.body));
        const s = await status(h, g.token, g.grantId);
        assert.equal(s.body.grants[0]?.held_data, "erase");
      },
      heldDataOpts()
    );
  });

  it("review fix: a grant revoked before the journal saw it reads `revoked`, not `active`", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        await mutateMainDatabase("UPDATE grants SET status = 'revoked' WHERE grant_id = ?", [g.grantId]);
        const s = await status(h, g.token, g.grantId);
        assert.equal(s.body.grants[0]?.read_state, "revoked", JSON.stringify(s.body));
        assert.equal(s.body.grants[0]?.held_data, "permitted");
      },
      heldDataOpts()
    );
  });

  it("review fix: an unreadable journal line makes the operation answer 503 temporarily_unavailable with Retry-After", async () => {
    const opts = heldDataOpts();
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        assert.equal((await status(h, g.token, g.grantId)).status, 200);
        appendFileSync(join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal"), "{torn\n");
        const resp = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: g.grantId, token: g.token }));
        assert.equal(resp.status, 503);
        assert.equal(resp.headers.get("retry-after"), "60");
        assert.equal(await rsRead(h, g.token), 403, "reads fail closed too");
      },
      opts
    );
  });

  it("red-team RT8 (finding 2): a client-conveyed delete records receipt only from reported_at, never from the request's arrival", async () => {
    await withServer(
      false,
      async (h) => {
        const withTime = await ordinaryGrant(h);
        const ownerChoice = new Date(Date.now() - 20 * DAY).toISOString();
        const w = await lifecycle(h, {
          grant_id: withTime.grantId,
          pdpp_disposition: "delete",
          reported_at: ownerChoice,
          token: withTime.token,
        });
        assert.equal(w.body.grants[0]?.held_data, "erase", JSON.stringify(w.body));
        const rec = await owner(h, `/v1/owner/grants/${withTime.grantId}/lifecycle`);
        const op = (rec.body.erasures as Record<string, unknown>[])[0];
        assert.equal(op?.receipt_at, ownerChoice);
        assert.equal(Date.parse(String(op?.delete_by)) - Date.parse(ownerChoice), 30 * DAY);

        const without = await ordinaryGrant(h);
        await lifecycle(h, { grant_id: without.grantId, pdpp_disposition: "delete", token: without.token });
        const rec2 = await owner(h, `/v1/owner/grants/${without.grantId}/lifecycle`);
        const op2 = (rec2.body.erasures as Record<string, unknown>[])[0];
        assert.equal(op2?.receipt_at, null, "arrival is not receipt");
        assert.equal(op2?.delete_by, null);

        const future = await ordinaryGrant(h);
        const f = await lifecycle(h, {
          grant_id: future.grantId,
          pdpp_disposition: "delete",
          reported_at: new Date(Date.now() + DAY).toISOString(),
          token: future.token,
        });
        assert.equal(f.status, 400);

        const viaRevoke = await ordinaryGrant(h);
        const r = await revoke(h, viaRevoke.token, viaRevoke.grantId, {
          pdpp_disposition: "delete",
          reported_at: ownerChoice,
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const rec3 = await owner(h, `/v1/owner/grants/${viaRevoke.grantId}/lifecycle`);
        assert.equal((rec3.body.erasures as Record<string, unknown>[])[0]?.receipt_at, ownerChoice);
      },
      heldDataOpts(),
    );
  });

  it("red-team RT12 (finding 6): a DPoP-bound lifecycle token needs a proof with `ath`, and a proof is accepted once", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        assert.equal((await status(h, g.token, g.grantId)).status, 200);
        const key = generateEd25519KeyPair();
        const jkt = thumbprint(key.publicJwk as unknown as Record<string, unknown>) as string;
        const bound = `bound-${randomBytes(12).toString("hex")}`;
        getHeldDataRuntime()?.authority.recordCredential({ token: bound, grantIds: [g.grantId], kind: "access", jkt });
        const url = `${h.asUrl}/oauth/grant-lifecycle`;
        const proof = (withAth: boolean) =>
          makeDpopProof({
            iatS: Math.floor(Date.now() / 1000),
            jti: randomBytes(12).toString("hex"),
            method: "POST",
            privateKey: key.privateKey,
            publicJwk: key.publicJwk as unknown as Record<string, unknown>,
            url,
            ...(withAth ? { accessToken: bound } : {}),
          });
        const send = (p: string) =>
          fetchJson<{ grants?: Record<string, unknown>[] }>(url, {
            ...form({ grant_id: g.grantId, token: bound }),
            headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: p },
          });
        assert.equal((await send(proof(false))).status, 401, "no ath");
        const good = proof(true);
        assert.equal((await send(good)).status, 200, "with ath");
        assert.equal((await send(good)).status, 401, "replayed proof");
      },
      heldDataOpts(),
    );
  });

  it("red-team RT13 (finding 6) and RT9 (finding 11): a client assertion needs aud = issuer and a fresh jti; retained then completed are both kept", async () => {
    const c = cimdClient();
    const cimdFetchDependencies = {
      dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: async (input: unknown) =>
        new Response(JSON.stringify(String(input) === c.jwksUri ? c.jwks : c.doc), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      isGlobalUnicastAddressImpl: () => true,
    };
    await withServer(
      false,
      async (h) => {
        const g = await authCodeGrant(h, c.clientId, {
          redirect: c.doc.redirect_uris[0] as string,
          tokenAuth: (aud) => clientAuth(c, aud),
        });
        const issuer = h.asUrl;
        const q = (auth: Record<string, string>, extra: Record<string, string> = {}) =>
          lifecycle(h, { grant_id: g.grantId, ...auth, ...extra });
        assert.equal((await q(clientAuth(c, issuer, { jti: null }))).status, 401, "missing jti");
        assert.equal((await q(clientAuth(c, `${h.asUrl}/oauth/grant-lifecycle`))).status, 401, "endpoint audience");
        const once = clientAuth(c, issuer);
        const ok = await q(once);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.grants[0]?.held_data, "permitted", JSON.stringify(ok.body));
        assert.equal((await q(once)).status, 401, "replayed assertion");

        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200);
        const instruction = (await q(clientAuth(c, issuer))).body.grants[0]?.erasure as { instruction_id: string };
        const at = (d: number) => new Date(Date.now() - d * DAY).toISOString();
        const write = (extra: Record<string, string>) =>
          q(clientAuth(c, issuer), { instruction_id: instruction.instruction_id, ...extra });
        assert.equal((await write({ report: "retained", reported_at: at(3), retained_until: "2030-01-01T00:00:00Z" })).status, 200);
        assert.equal((await write({ report: "retained", reported_at: at(2), retained_until: "2031-01-01T00:00:00Z" })).status, 200);
        assert.equal((await write({ report: "completed", reported_at: at(1) })).status, 200);
        const view = getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY)?.erasures[0];
        assert.equal(view?.completion?.outcome, "deleted");
        assert.equal(view?.retained.length, 2);
      },
      { ...heldDataOpts(), cimdFetchDependencies } as never,
    );
  });
});

describe("DCR to lifecycle over HTTP", () => {
  it("a dynamically registered public client can query, convey delete and report receipt with current authentication", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const grant = await authCodeGrant(h, clientId);
        const query = await status(h, grant.refreshToken, grant.grantId);
        assert.equal(query.status, 200);
        assert.equal(query.body.grants[0]?.held_data, "permitted");
        const erased = await lifecycle(h, {
          grant_id: grant.grantId,
          token: grant.refreshToken,
          pdpp_disposition: "delete",
          reported_at: new Date(Date.now() - 1000).toISOString(),
        });
        assert.equal(erased.status, 200, JSON.stringify(erased.body));
        assert.equal(erased.body.grants[0]?.held_data, "erase");
        const record = getHeldDataRuntime()?.authority.ownerView(grant.grantId, DAY);
        assert.ok(record?.erasures[0]?.receipt_at != null, "the AS recorded the client's receipt");
        assert.equal((await status(h, grant.refreshToken, grant.grantId)).body.grants[0]?.held_data, "erase");
        assert.notEqual(await rsRead(h, grant.accessToken), 200);
      },
      heldDataOpts()
    );
  });

  it("FINDING: confidential DCR is rejected before a grant or lifecycle credential can be issued", async () => {
    await withServer(
      false,
      async (h) => {
        const reg = await fetchJson<{ error: string; error_description: string }>(
          `${h.asUrl}/oauth/register`,
          json({
            application_type: "web",
            client_name: "Confidential DCR probe",
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: [REDIRECT],
            response_types: ["code"],
            token_endpoint_auth_method: "private_key_jwt",
          })
        );
        assert.equal(reg.status, 400);
        assert.equal(reg.body.error, "invalid_client_metadata");
        assert.match(reg.body.error_description, /Unsupported token_endpoint_auth_method/);
      },
      heldDataOpts()
    );
  });
});

async function revokeToken(h: Harness, params: Record<string, string>) {
  const response = await fetch(`${h.asUrl}/oauth/revoke`, form(params));
  const body = await response.text();
  return {
    status: response.status,
    body: body ? (JSON.parse(body) as { error?: string }) : null,
  };
}

describe("held-data lane integration over HTTP", () => {
  it("history loss fences revocation and a restarted client until owner erasure is replayed", async () => {
    const clock = { now: Date.now() };
    const opts = heldDataOpts(clock);
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const g = await authCodeGrant(h, clientId);
      const app = new ToyApp();
      const storage = new MemoryClientCheckpointStorage();
      const statusTransport = httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: () => g.refreshToken });
      const clientOpts = {
        now: () => clock.now, store: app, storage, status: statusTransport,
        policy: { disposeAt: "deadline" as const },
      };
      let client = new HeldDataClient({ ...clientOpts, initialize: true });
      app.attach(client);
      app.sync(g.grantId, [{ id: "a1", stream: "top_artists", text: "radiohead" }]);
      await client.reconcile();
      assert.equal(client.canUse(g.grantId).ok, true);
      const journalPath = join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal");
      const restore = loseHistory(journalPath, "suffix");
      const damaged = readFileSync(journalPath, "utf8");
      const revocation = { client_id: clientId, token: g.refreshToken, pdpp_disposition: "delete" };
      assert.equal((await revokeToken(h, revocation)).status, 503);
      assert.equal(readFileSync(journalPath, "utf8"), damaged, "revocation cannot append to lost history");
      const pending = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "delete" });
      assert.equal(pending.status, 200);
      clock.now += 7 * DAY;
      await client.reconcile();
      assert.deepEqual(client.canUse(g.grantId), { ok: false, reason: "stale" });
      client = new HeldDataClient(clientOpts);
      app.attach(client);
      assert.equal(client.canUse(g.grantId).ok, false);
      await client.reconcile();
      assert.equal(client.canUse(g.grantId).ok, false);
      restore();
      assert.equal((await revokeToken(h, revocation)).status, 503, "restoration alone does not release pending actions");
      getHeldDataRuntime()!.authority.reestablishHistory();
      assert.equal((await revokeToken(h, revocation)).status, 200);
      await client.reconcile();
      assert.deepEqual(client.canUse(g.grantId), { ok: false, reason: "erased" });
      const deadline = client.deleteBy(g.grantId);
      assert.equal(deadline, clock.now + 30 * DAY);
      assert.equal((await revokeToken(h, revocation)).status, 200);
      await client.reconcile();
      assert.equal(client.deleteBy(g.grantId), deadline);
      clock.now = deadline!;
      await client.tick();
      assert.equal(app.holds(g.grantId).records, 0);
      assert.equal(await rsRead(h, g.accessToken), 403);
    }, opts);
  });
});

describe("RFC 7009 held-data revocation", () => {
  it("RFC 7009 metadata advertises revocation_endpoint with the flag on and off", async () => {
    for (const opts of [{}, heldDataOpts()]) {
      await withServer(
        false,
        async (h) => {
          const metadata = await fetchJson<{ revocation_endpoint: string }>(
            `${h.asUrl}/.well-known/oauth-authorization-server`
          );
          assert.equal(metadata.body.revocation_endpoint, `${h.asUrl}/oauth/revoke`);
        },
        opts
      );
    }
  });

  it("RFC 7009 flag off revokes credentials only and ignores lifecycle extensions", async () => {
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const g = await authCodeGrant(h, clientId);
      const r = await revokeToken(h, {
        client_id: clientId,
        token: g.refreshToken,
        pdpp_disposition: "bogus",
        reported_at: "bogus",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, null, "RFC success is empty");
      assert.equal(getDb().prepare("SELECT status FROM grants WHERE grant_id = ?").get(g.grantId)?.status, "active");
      const refresh = await fetchJson<{ error: string }>(
        `${h.asUrl}/oauth/token`,
        form({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: g.refreshToken,
        })
      );
      assert.equal(refresh.status, 400);
      assert.equal(refresh.body.error, "invalid_grant");
      assert.equal((await status(h, g.accessToken, g.grantId)).status, 404);
    });
  });

  for (const disposition of ["keep", "delete"] as const) {
    it(`RFC 7009 P4 public current refresh token ${disposition}: status and owner-choice receipt`, async () => {
      const clock = { now: Date.now() };
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          const choice = new Date(clock.now).toISOString();
          const app = new ToyApp();
          let reachable = true;
          const transport = httpStatusTransport({
            asBaseUrl: h.asUrl,
            credentialFor: () => g.refreshToken,
          });
          const client = new HeldDataClient({
            now: () => clock.now,
            store: app,
            policy: { disposeAt: "deadline" },
            status: (ids) => (reachable ? transport(ids) : Promise.resolve({ ok: false, reason: "unreachable" })),
          });
          app.attach(client);
          app.sync(g.grantId, [{ id: "a1", stream: "top_artists", text: "radiohead" }]);
          await client.reconcile();
          assert.equal(client.canUse(g.grantId).ok, true);
          if (disposition === "delete") {
            reachable = false;
            client.ownerDelete(g.grantId);
            assert.deepEqual(client.canUse(g.grantId), {
              ok: false,
              reason: "erased",
            });
            assert.equal(client.deleteBy(g.grantId), clock.now + 30 * DAY);
            clock.now += 20 * DAY;
            await client.tick();
            assert.equal(app.holds(g.grantId).records, 1, "clock advanced without an AS answer");
            reachable = true;
          }
          const r = await revokeToken(h, {
            client_id: clientId,
            token: g.refreshToken,
            pdpp_disposition: disposition,
            reported_at: choice,
          });
          assert.equal(r.status, 200);
          const answer = (await status(h, g.refreshToken, g.grantId)).body.grants[0];
          assert.equal(answer?.read_state, "revoked");
          assert.equal(answer?.held_data, disposition === "delete" ? "erase" : "permitted");
          assert.equal(
            getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY)?.ending?.path,
            "client_revocation"
          );
          assert.equal(await rsRead(h, g.accessToken), 403);
          const record = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
          const erasure = (record.body.erasures as Record<string, unknown>[])[0];
          if (disposition === "delete") {
            assert.equal(erasure?.receipt_at, choice);
            assert.equal(Date.parse(String(erasure?.delete_by)), Date.parse(choice) + 30 * DAY);
            await client.reconcile();
            assert.equal(
              client.deleteBy(g.grantId),
              Date.parse(choice) + 30 * DAY,
              "late AS delivery cannot restart the local clock"
            );
            clock.now = Date.parse(choice) + 30 * DAY;
            await client.tick();
            assert.deepEqual(client.canUse(g.grantId), {
              ok: false,
              reason: "deleted",
            });
            assert.equal(app.holds(g.grantId).records, 0);
          } else {
            assert.equal(erasure, undefined);
          }
        },
        heldDataOpts(clock)
      );
    });
  }

  it("RFC 7009 P4 delete without reported_at records no receipt or receipt-based date; retry does not restart clocks", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const params = {
          client_id: clientId,
          token: g.refreshToken,
          pdpp_disposition: "delete",
        };
        assert.equal((await revokeToken(h, params)).status, 200);
        const first = getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY);
        clock.now += DAY;
        assert.equal(
          (
            await revokeToken(h, {
              ...params,
              reported_at: new Date(clock.now).toISOString(),
            })
          ).status,
          200
        );
        const after = getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY);
        assert.deepEqual(after?.ending, first?.ending);
        assert.deepEqual(after?.erasures, first?.erasures);
        assert.equal(after?.erasures[0]?.receipt_at, null);
        assert.equal(after?.erasures[0]?.delete_by, null);
        assert.equal((await status(h, g.refreshToken, g.grantId)).body.grants[0]?.held_data, "erase");
      },
      heldDataOpts(clock)
    );
  });

  it("RFC 7009 P4 superseded refresh token ends the family and grants but records no disposition", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const rotated = await fetchJson<{
          access_token: string;
          refresh_token: string;
        }>(
          `${h.asUrl}/oauth/token`,
          form({
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: g.refreshToken,
          })
        );
        assert.equal(rotated.status, 200);
        assert.equal(
          (
            await revokeToken(h, {
              client_id: clientId,
              token: g.refreshToken,
              pdpp_disposition: "delete",
            })
          ).status,
          200
        );
        const answer = (await status(h, g.refreshToken, g.grantId)).body.grants[0];
        assert.equal(answer?.read_state, "revoked");
        assert.equal(answer?.held_data, "permitted");
        assert.equal(getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY)?.ending?.disposition, null);
        const refresh = await fetchJson<{ error: string }>(
          `${h.asUrl}/oauth/token`,
          form({
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: rotated.body.refresh_token,
          })
        );
        assert.equal(refresh.body.error, "invalid_grant");
        assert.equal(await rsRead(h, rotated.body.access_token), 403);
      },
      heldDataOpts()
    );
  });

  it("RFC 7009 P5 bare refresh revocation and already-ended token preserve permitted held data", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await revokeToken(h, { client_id: clientId, token: g.refreshToken })).status, 200);
        assert.equal(
          (
            await revokeToken(h, {
              client_id: clientId,
              token: g.refreshToken,
              pdpp_disposition: "delete",
            })
          ).status,
          200
        );
        const answer = (await status(h, g.refreshToken, g.grantId)).body.grants[0];
        assert.equal(answer?.read_state, "revoked");
        assert.equal(answer?.held_data, "permitted");
        assert.equal(answer?.erasure, undefined);
      },
      heldDataOpts()
    );
  });

  it("RFC 7009 P5 access token ends only itself when a family covers the grant, even a replay-revoked family", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await introspect(g.accessToken)).active, true);
        assert.equal(
          (
            await revokeToken(h, {
              client_id: clientId,
              token: g.accessToken,
              token_type_hint: "refresh_token",
              pdpp_disposition: "delete",
            })
          ).status,
          200
        );
        assert.equal((await introspect(g.accessToken)).active, false, "RFC 7009 must disable the access token");
        assert.equal((await status(h, g.accessToken, g.grantId)).body.grants[0]?.read_state, "active");
        const rotation = await fetchJson(
          `${h.asUrl}/oauth/token`,
          form({
            client_id: clientId,
            grant_type: "refresh_token",
            refresh_token: g.refreshToken,
          })
        );
        assert.equal(rotation.status, 200);
        assert.equal(
          (
            await fetchJson(
              `${h.asUrl}/oauth/token`,
              form({
                client_id: clientId,
                grant_type: "refresh_token",
                refresh_token: g.refreshToken,
              })
            )
          ).status,
          400
        );
        assert.equal((await revokeToken(h, { client_id: clientId, token: g.accessToken })).status, 200);
        assert.equal((await status(h, g.accessToken, g.grantId)).body.grants[0]?.read_state, "active");
      },
      heldDataOpts()
    );
  });

  it("RFC 7009 P5 access token without a refresh family ends its grant without erasure", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrant(h);
        const clientId = getDb().prepare("SELECT client_id FROM grants WHERE grant_id = ?").get(g.grantId)
          ?.client_id as string;
        assert.equal((await revokeToken(h, { client_id: clientId, token: g.token })).status, 200);
        const answer = (await status(h, g.token, g.grantId)).body.grants[0];
        assert.equal(answer?.read_state, "revoked");
        assert.equal(answer?.held_data, "permitted");
      },
      heldDataOpts()
    );
  });

  it("RFC 7009 disabled lifecycle token still revokes, but cannot convey a disposition", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        getHeldDataRuntime()?.authority.disableCredential(g.refreshToken);
        assert.equal(
          (
            await revokeToken(h, {
              client_id: clientId,
              token: g.refreshToken,
              pdpp_disposition: "delete",
            })
          ).status,
          200
        );
        assert.equal((await status(h, g.refreshToken, g.grantId)).status, 401);
        const answer = (await status(h, g.accessToken, g.grantId)).body.grants[0];
        assert.equal(answer?.read_state, "revoked");
        assert.equal(answer?.held_data, "permitted");
      },
      heldDataOpts()
    );
  });

  it("RFC 7009 package refresh delete reaches active and earlier-ended children", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await registerSecondConnector(h)]);
        const [a, b] = pkg.children as [string, string];
        await revoke(h, h.ownerToken, a, { pdpp_disposition: "keep" });
        assert.equal(
          (
            await revokeToken(h, {
              client_id: clientId,
              token: pkg.refreshToken,
              pdpp_disposition: "delete",
              reported_at: new Date(Date.now() - DAY).toISOString(),
            })
          ).status,
          200
        );
        for (const id of [a, b]) {
          const answer = (await status(h, pkg.refreshToken, id)).body.grants[0];
          assert.equal(answer?.read_state, "revoked");
          assert.equal(answer?.held_data, "erase");
        }
        assert.equal(
          (
            await fetchJson(
              `${h.asUrl}/oauth/token`,
              form({
                client_id: clientId,
                grant_type: "refresh_token",
                refresh_token: pkg.refreshToken,
              })
            )
          ).status,
          400
        );
      },
      heldDataOpts()
    );
  });

  for (const disposition of ["keep", "delete"] as const) {
    it(`RFC 7009 confidential ${disposition} requires client authentication, including for unknown tokens`, async () => {
      const c = cimdClient();
      const cimdFetchDependencies = {
        dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async (input: unknown) =>
          new Response(JSON.stringify(String(input) === c.jwksUri ? c.jwks : c.doc), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        isGlobalUnicastAddressImpl: () => true,
      };
      await withServer(
        false,
        async (h) => {
          const g = await authCodeGrant(h, c.clientId, {
            redirect: c.doc.redirect_uris[0] as string,
            tokenAuth: (aud) => clientAuth(c, aud),
          });
          assert.equal((await revokeToken(h, { client_id: c.clientId, token: "unknown" })).status, 401);
          assert.equal(
            (
              await revokeToken(h, {
                client_id: c.clientId,
                token: g.refreshToken,
              })
            ).status,
            401
          );
          assert.equal(
            (
              await revokeToken(h, {
                ...clientAuth(c, h.asUrl),
                token: g.refreshToken,
                pdpp_disposition: disposition,
              })
            ).status,
            200
          );
          const answer = (
            await lifecycle(h, {
              ...clientAuth(c, h.asUrl),
              grant_id: g.grantId,
            })
          ).body.grants[0];
          assert.equal(answer?.read_state, "revoked");
          assert.equal(answer?.held_data, disposition === "delete" ? "erase" : "permitted");
          assert.equal(
            (
              await revokeToken(h, {
                ...clientAuth(c, `${h.asUrl}/oauth/revoke`),
                token: "unknown",
              })
            ).status,
            200
          );
        },
        { ...heldDataOpts(), cimdFetchDependencies } as never
      );
    });
  }

  it("RFC 7009 unknown tokens and unknown hints return 200; malformed extensions and unsupported token kinds fail", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        assert.equal(
          (
            await revokeToken(h, {
              client_id: clientId,
              token: "unknown",
              token_type_hint: "unknown",
            })
          ).status,
          200
        );
        assert.equal((await revokeToken(h, { client_id: clientId })).body?.error, "invalid_request");
        getDb().prepare("UPDATE tokens SET client_id = ? WHERE token_id = ?").run(clientId, h.ownerToken);
        assert.equal(
          (await revokeToken(h, { client_id: clientId, token: h.ownerToken })).body?.error,
          "unsupported_token_type"
        );
        const g = await authCodeGrant(h, clientId);
        const foreign = await registerPublicClient(h);
        assert.equal(
          (
            await revokeToken(h, {
              client_id: foreign,
              token: g.refreshToken,
              pdpp_disposition: "delete",
            })
          ).status,
          400
        );
        assert.equal((await status(h, g.refreshToken, g.grantId)).body.grants[0]?.read_state, "active");
        for (const extra of [
          { pdpp_disposition: "bogus" },
          { pdpp_disposition: "delete", reported_at: "bogus" },
          {
            pdpp_disposition: "delete",
            reported_at: new Date(clock.now + DAY).toISOString(),
          },
        ]) {
          assert.equal(
            (
              await revokeToken(h, {
                client_id: clientId,
                token: g.refreshToken,
                ...extra,
              })
            ).body?.error,
            "invalid_request"
          );
          assert.equal((await status(h, g.refreshToken, g.grantId)).body.grants[0]?.read_state, "active");
        }
      },
      heldDataOpts(clock)
    );
  });
});

describe("RFC 7009 validation regressions", () => {
  it("RFC 7009 refuses a token issued to another client", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const foreign = await registerPublicClient(h);
        const result = await revokeToken(h, {
          client_id: foreign,
          token: g.refreshToken,
        });
        assert.equal(result.status, 400);
        assert.equal(result.body?.error, "invalid_grant");
        assert.equal((await status(h, g.refreshToken, g.grantId)).body.grants[0]?.read_state, "active");
      },
      heldDataOpts()
    );
  });

  it("RFC 7009 reported_at must be RFC 3339, not a Date.parse shorthand", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        for (const reported_at of ["2000", "2000-02-30T00:00:00Z", "2001-02-29T00:00:00Z"]) {
          const result = await revokeToken(h, {
            client_id: clientId,
            token: g.refreshToken,
            pdpp_disposition: "delete",
            reported_at,
          });
          assert.equal(result.status, 400);
          assert.equal(result.body?.error, "invalid_request");
        }
        assert.equal((await status(h, g.refreshToken, g.grantId)).body.grants[0]?.read_state, "active");
      },
      heldDataOpts()
    );
  });
});

describe("RFC 7009 restore authentication", () => {
  it("RFC 7009 restored package refresh token cannot add erasure after every child has ended", async () => {
    const opts = heldDataOpts();
    const journalPath = join(opts.experimentalHeldDataLifecycle.journalDir, "revoke-restore.jsonl");
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await registerSecondConnector(h)]);
        assert.equal((await revokeToken(h, { client_id: clientId, token: pkg.refreshToken })).status, 200);
        assert.equal(
          getDb().prepare("SELECT status FROM oauth_refresh_tokens WHERE package_id = ?").get(pkg.packageId)?.status,
          "revoked"
        );
        const familyId = getDb()
          .prepare("SELECT family_id FROM oauth_refresh_tokens WHERE package_id = ?")
          .get(pkg.packageId)?.family_id as string;
        assert.equal(HeldDataAuthority.open({ journalPath, now: Date.now }).refreshFamilyRevoked(familyId), true);
        getDb()
          .prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE package_id = ?")
          .run(pkg.packageId);
        assert.equal(
          (await revokeToken(h, { client_id: clientId, token: pkg.refreshToken, pdpp_disposition: "delete" })).status,
          200
        );
        for (const id of pkg.children) {
          const answer = (await status(h, pkg.refreshToken, id)).body.grants[0];
          assert.equal(answer?.read_state, "revoked");
          assert.equal(answer?.held_data, "permitted");
        }
      },
      { experimentalHeldDataLifecycle: { ...opts.experimentalHeldDataLifecycle, journalPath } }
    );
  });
});

describe("RFC 7009 partial package revocation", () => {
  it("RFC 7009 P1a partial package returns 503 with per-child states; retry keeps recorded clocks", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await registerSecondConnector(h)]);
        const [broken, healthy] = pkg.children as [string, string];
        await revoke(h, h.ownerToken, broken, { pdpp_disposition: "keep" });
        const original = getDb().prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get(broken)?.grant_json;
        getDb()
          .prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?")
          .run('{"not":"a valid persisted grant"}', broken);
        const params = {
          client_id: clientId,
          token: pkg.refreshToken,
          pdpp_disposition: "delete",
          reported_at: new Date(clock.now).toISOString(),
        };
        const partial = await fetchJson<{ error: string; grants: { grant_id: string; state: string }[] }>(
          `${h.asUrl}/oauth/revoke`,
          form(params)
        );
        assert.equal(partial.status, 503);
        assert.equal(partial.body.error, "temporarily_unavailable");
        assert.deepEqual(partial.body.grants, [
          { grant_id: broken, state: "pending" },
          { grant_id: healthy, state: "recorded" },
        ]);
        const first = getHeldDataRuntime()?.authority.ownerView(healthy, 30 * DAY);
        assert.equal(first?.erasures.length, 1);
        getDb().prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?").run(original, broken);
        clock.now += DAY;
        assert.equal(
          (
            await revokeToken(h, {
              ...params,
              pdpp_disposition: "keep",
              reported_at: new Date(clock.now).toISOString(),
            })
          ).status,
          200
        );
        const after = getHeldDataRuntime()?.authority.ownerView(healthy, 30 * DAY);
        assert.deepEqual(after?.ending, first?.ending);
        assert.deepEqual(after?.erasures, first?.erasures);
        assert.equal(
          getHeldDataRuntime()?.authority.ownerView(broken, 30 * DAY)?.erasures[0]?.receipt_at,
          Date.parse(params.reported_at)
        );
        for (const id of pkg.children) {
          assert.equal((await status(h, pkg.refreshToken, id)).body.grants[0]?.held_data, "erase");
        }
      },
      heldDataOpts(clock)
    );
  });
});

describe("RFC 7009 bound credentials", () => {
  it("RFC 7009 bound refresh disposition needs a fresh DPoP proof for the revocation URL", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const key = generateEd25519KeyPair();
        const jkt = thumbprint(key.publicJwk as unknown as Record<string, unknown>) as string;
        const proof = makeDpopProof({
          iatS: Math.floor(clock.now / 1000),
          jti: randomBytes(12).toString("hex"),
          method: "POST",
          privateKey: key.privateKey,
          publicJwk: key.publicJwk as unknown as Record<string, unknown>,
          url: `${h.asUrl}/oauth/revoke`,
        });
        let attempt = 0;
        for (const [dpop, expected] of [
          [undefined, "permitted"],
          [proof, "erase"],
          [proof, "permitted"],
        ] as const) {
          if (attempt++ === 2) clock.now = (Math.floor(clock.now / 1000) + 300) * 1000 + 500;
          const g = await authCodeGrant(h, clientId);
          await ensureHeldDataGrant(g.grantId);
          getHeldDataRuntime()?.authority.recordCredential({
            token: g.refreshToken,
            grantIds: [g.grantId],
            kind: "refresh",
            jkt,
          });
          const response = await fetch(`${h.asUrl}/oauth/revoke`, {
            ...form({ client_id: clientId, token: g.refreshToken, pdpp_disposition: "delete" }),
            ...(dpop ? { headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: dpop } } : {}),
          });
          assert.equal(response.status, 200);
          const answer = getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY);
          assert.equal(answer?.erasures.length, expected === "erase" ? 1 : 0, dpop ? "fresh proof only" : "no proof");
        }
      },
      heldDataOpts(clock)
    );
  });
});

describe("RFC 7009 owner-package restore", () => {
  it("RFC 7009 owner-revoked package refresh cannot convey delete after a database restore", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await registerSecondConnector(h)]);
        assert.equal(
          (
            await fetchJson(
              `${h.asUrl}/_ref/grant-packages/${pkg.packageId}/revoke`,
              json({ pdpp_disposition: "keep" })
            )
          ).status,
          200
        );
        getDb()
          .prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE package_id = ?")
          .run(pkg.packageId);
        assert.equal(
          (await revokeToken(h, { client_id: clientId, token: pkg.refreshToken, pdpp_disposition: "delete" })).status,
          200
        );
        for (const id of pkg.children)
          assert.equal(getHeldDataRuntime()?.authority.ownerView(id, 30 * DAY)?.erasures.length, 0);
      },
      heldDataOpts()
    );
  });
});

describe("RFC 7009 Core assertion authentication", () => {
  for (const scenario of [
    "issuer audience",
    "advertised issuer",
    "non-empty jti",
    "shared replay",
    "flag off",
  ] as const) {
    it(`RFC 7009 Core assertion ${scenario}`, async () => {
      const c = cimdClient();
      const cimdFetchDependencies = {
        dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async (input: unknown) =>
          new Response(JSON.stringify(String(input) === c.jwksUri ? c.jwks : c.doc), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
        isGlobalUnicastAddressImpl: () => true,
      };
      await withServer(
        false,
        async (h) => {
          const g = await authCodeGrant(h, c.clientId, {
            redirect: c.doc.redirect_uris[0] as string,
            tokenAuth: (aud) =>
              clientAuth(c, scenario === "advertised issuer" ? "https://token-auth.example/oauth/token" : aud),
          });
          const params = { token: g.refreshToken, pdpp_disposition: "delete" };
          if (scenario === "flag off") {
            const assertion = clientAuth(c, `${h.asUrl}/oauth/revoke`, { jti: null });
            assert.equal((await revokeToken(h, { ...assertion, ...params })).status, 200);
            assert.equal((await revokeToken(h, { ...assertion, ...params })).status, 200);
            assert.equal(
              getDb().prepare("SELECT status FROM grants WHERE grant_id = ?").get(g.grantId)?.status,
              "active"
            );
            return;
          }
          if (scenario === "issuer audience" || scenario === "advertised issuer") {
            const jti = randomBytes(8).toString("hex");
            assert.equal(
              (await revokeToken(h, { ...clientAuth(c, `${h.asUrl}/oauth/revoke`, { jti }), ...params })).status,
              401
            );
            const metadata = await fetchJson<{ issuer: string }>(`${h.asUrl}/.well-known/oauth-authorization-server`);
            assert.equal(
              (await revokeToken(h, { ...clientAuth(c, metadata.body.issuer, { jti }), ...params })).status,
              200
            );
            assert.equal(getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY)?.erasures.length, 1);
            assert.equal((await lifecycle(h, { ...clientAuth(c, metadata.body.issuer), grant_id: g.grantId })).status, 200);
          } else if (scenario === "non-empty jti") {
            for (const jti of [null, ""] as const) {
              assert.equal((await revokeToken(h, { ...clientAuth(c, h.asUrl, { jti }), ...params })).status, 401);
            }
            assert.equal((await revokeToken(h, { ...clientAuth(c, h.asUrl), ...params })).status, 200);
          } else {
            const used = clientAuth(c, h.asUrl);
            assert.equal((await lifecycle(h, { ...used, grant_id: g.grantId })).status, 200);
            assert.equal(
              (await revokeToken(h, { ...used, ...params })).status,
              401,
              "lifecycle assertion cannot be replayed at revocation"
            );
            const fresh = clientAuth(c, h.asUrl);
            assert.equal((await revokeToken(h, { ...fresh, ...params })).status, 200);
            assert.equal(
              (await revokeToken(h, { ...fresh, ...params })).status,
              401,
              "revocation assertion is accepted once"
            );
            assert.equal(
              (await lifecycle(h, { ...fresh, grant_id: g.grantId })).status,
              401,
              "revocation assertion cannot be replayed at lifecycle"
            );
          }
        },
        {
          ...(scenario === "flag off" ? {} : heldDataOpts()),
          cimdFetchDependencies,
          ...(scenario === "advertised issuer" ? { asIssuer: "https://token-auth.example" } : {}),
        } as never
      );
    });
  }
});

describe("lane F: lifecycle discovery", () => {
  it("advertises pdpp_grant_lifecycle_endpoint only with the flag on", async () => {
    await withServer(false, async (h) => {
      const metadata = await fetchJson<Record<string, unknown>>(`${h.asUrl}/.well-known/oauth-authorization-server`);
      assert.equal(metadata.status, 200);
      assert.equal(metadata.body.pdpp_grant_lifecycle_endpoint, `${metadata.body.issuer}/oauth/grant-lifecycle`);
    }, heldDataOpts());
  });

  it("omits pdpp_grant_lifecycle_endpoint with the flag off", async () => {
    await withServer(false, async (h) => {
      const metadata = await fetchJson<Record<string, unknown>>(`${h.asUrl}/.well-known/oauth-authorization-server`);
      assert.equal(metadata.status, 200);
      assert.equal(Object.hasOwn(metadata.body, "pdpp_grant_lifecycle_endpoint"), false);
    });
  });
});


describe("lane F: single-use read window", () => {
  it("returns window_closed with surviving use and no deletion instruction", async () => {
    const clock = { now: Date.now() };
    await withServer(false, async (h) => {
      const expiry = clock.now + 10 * DAY;
      const windowEnd = clock.now + 60_000;
      const g = await ordinaryGrant(h, { access_mode: "single_use" });
      getDb().prepare("UPDATE grants SET expires_at = ?, grant_json = json_set(grant_json, '$.expires_at', ?) WHERE grant_id = ?")
        .run(new Date(expiry).toISOString(), new Date(expiry).toISOString(), g.grantId);
      getDb().prepare("UPDATE tokens SET expires_at = ? WHERE token_id = ?").run(new Date(windowEnd).toISOString(), g.token);
      const initial = await status(h, g.token, g.grantId);
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      assert.equal(initial.body.grants[0]!.read_state, "active");
      clock.now = windowEnd;
      const closed = await status(h, g.token, g.grantId);
      assert.equal(closed.body.grants[0]!.read_state, "window_closed");
      assert.equal(closed.body.grants[0]!.held_data, "permitted");
      assert.equal(Object.hasOwn(closed.body.grants[0]!, "ended_at"), false);
      assert.equal(Object.hasOwn(closed.body.grants[0]!, "erasure"), false);
      const app = new ToyApp();
      const client = new HeldDataClient({ now: () => clock.now, store: app,
        status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: () => g.token }),
      });
      app.attach(client);
      app.sync(g.grantId, [{ id: "r1", stream: "messages", text: "survives" }]);
      await client.reconcile();
      assert.equal(client.grantState(g.grantId)?.readState, "window_closed");
      assert.equal(client.canUse(g.grantId).ok, true);
      assert.equal(client.deleteBy(g.grantId), clock.now + 90 * DAY);
      clock.now = expiry;
      assert.equal((await status(h, g.token, g.grantId)).body.grants[0]!.read_state, "expired");
      assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
      const erased = await status(h, g.token, g.grantId);
      assert.equal(erased.body.grants[0]!.read_state, "expired");
      assert.equal(erased.body.grants[0]!.held_data, "erase");
      await client.reconcile();
      assert.equal(app.holds(g.grantId).records, 0);
    }, heldDataOpts(clock));
  });
});


describe("lane F: P9 decommission", () => {
  it("offers all grants, requires dispositions, persists retirement, and the client pauses then deletes", async () => {
    const clock = { now: Date.now() };
    await withServer(false, async (h) => {
      const live = await ordinaryGrant(h, { access_mode: "continuous" });
      const consumed = await ordinaryGrant(h, { access_mode: "single_use" });
      const ended = await ordinaryGrant(h, { access_mode: "continuous" });
      await revoke(h, h.ownerToken, ended.grantId, { pdpp_disposition: "keep" });
      const app = new ToyApp();
      const client = new HeldDataClient({ now: () => clock.now, store: app,
        status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: () => live.token }),
      });
      app.attach(client);
      app.sync(live.grantId, [{ id: "r1", stream: "messages", text: "held" }]);
      await client.reconcile();
      const origin = clock.now;
      const path = "/v1/owner/lifecycle/decommission";
      const offer = await owner(h, path);
      assert.equal(offer.status, 200, JSON.stringify(offer.body));
      const grants = offer.body.grants as { grant_id: string; choices: string[]; grant: Record<string, unknown> | null }[];
      assert.deepEqual(grants.map((g) => g.grant_id).sort(), [live.grantId, consumed.grantId, ended.grantId].sort());
      for (const g of grants) {
        assert.deepEqual(g.choices, ["keep", "delete"]);
        assert.equal(Object.hasOwn(g, "disposition"), false);
        assert.equal(g.grant?.grant_id, g.grant_id);
        assert.ok(g.grant && Object.hasOwn(g.grant, "access_mode"));
      }
      assert.equal(offer.body.pause_threshold_ms, 7 * DAY);
      assert.equal(offer.body.long_stop_ms, 90 * DAY);
      assert.match(String(offer.body.owner_message), /pause.*positive assessment.*delete/i);
      const send = (body: unknown) => fetchJson<Record<string, unknown>>(`${h.asUrl}${path}`,
        json(body, { Authorization: `Bearer ${h.ownerToken}` }));
      assert.equal((await send({ offer_id: offer.body.offer_id })).status, 400);
      assert.equal((await status(h, live.token, live.grantId)).status, 200);
      const complete = await send({ offer_id: offer.body.offer_id,
        dispositions: Object.fromEntries(grants.map((g) => [g.grant_id, "keep"])),
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      assert.equal(complete.body.decommissioned, true);
      const rt = getHeldDataRuntime();
      assert.ok(rt);
      assert.equal(rt.authority.decommissioned, true);
      const reopened = HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now: () => clock.now });
      assert.equal(reopened.decommissioned, true);
      assert.equal((await status(h, live.token, live.grantId)).status, 503);
      clock.now = origin + 7 * DAY;
      await client.tick();
      assert.equal(client.canUse(live.grantId).ok, false);
      assert.equal(app.holds(live.grantId).records, 1);
      clock.now = origin + 90 * DAY;
      await client.tick();
      assert.equal(app.holds(live.grantId).records, 0);
      assert.equal(app.holds(live.grantId).summary, false);
      assert.equal(app.holds(live.grantId).indexEntries, 0);
    }, heldDataOpts(clock));
  });

  it("keeps decommission routes absent with the flag off", async () => {
    await withServer(false, async (h) => {
      assert.equal((await owner(h, "/v1/owner/lifecycle/decommission")).status, 404);
      assert.equal((await owner(h, "/v1/owner/lifecycle/decommission", "POST")).status, 404);
    });
  });
});


describe("lane F: P6 advance election over HTTP", () => {
  it("keeps reads before expiry, reports acceptance and effective time separately, and erases at expiry", async () => {
    const clock = { now: Date.now() };
    await withServer(false, async (h) => {
      const g = await ordinaryGrant(h, { access_mode: "continuous" });
      const accepted = clock.now;
      const expiry = clock.now + DAY;
      getDb().prepare("UPDATE grants SET expires_at = ?, grant_json = json_set(grant_json, '$.expires_at', ?) WHERE grant_id = ?")
        .run(new Date(expiry).toISOString(), new Date(expiry).toISOString(), g.grantId);
      getDb().prepare("UPDATE tokens SET expires_at = ? WHERE token_id = ?").run(new Date(expiry).toISOString(), g.token);
      const elected = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/elect-delete`, "POST");
      assert.equal(elected.status, 200, JSON.stringify(elected.body));
      const instruction = (elected.body.erasures as Record<string, unknown>[])[0]!;
      assert.equal(instruction.accepted_at, new Date(accepted).toISOString());
      assert.equal(instruction.effective_at, new Date(expiry).toISOString());
      assert.equal(instruction.delivered_at, null);
      assert.equal(instruction.use_stops_by, new Date(expiry + 7 * DAY).toISOString());
      assert.equal((await status(h, g.token, g.grantId)).body.grants[0]!.held_data, "permitted");
      assert.equal(await rsRead(h, g.token), 200);
      const app = new ToyApp();
      const client = new HeldDataClient({ now: () => clock.now, store: app,
        status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: () => g.token }),
        policy: { disposeAt: "deadline" },
      });
      app.attach(client);
      app.sync(g.grantId, [{ id: "r", stream: "messages", text: "held" }]);
      await client.reconcile();
      assert.equal(client.canUse(g.grantId).ok, true);
      clock.now = expiry;
      const expired = (await status(h, g.token, g.grantId)).body.grants[0]!;
      assert.equal(expired.read_state, "expired");
      assert.equal(expired.held_data, "erase");
      const e = expired.erasure as Record<string, unknown>;
      assert.equal(e.instruction_id, instruction.operation_id);
      assert.equal(e.accepted_at, new Date(accepted).toISOString());
      assert.equal(e.effective_at, new Date(expiry).toISOString());
      await client.reconcile();
      assert.equal(client.canUse(g.grantId).ok, false);
      assert.equal(client.deleteBy(g.grantId), expiry + 30 * DAY);
      clock.now += 30 * DAY;
      await client.tick();
      assert.equal(app.holds(g.grantId).records, 0);
    }, heldDataOpts(clock));
  });
});

it('owner keep after security revocation is applied on replay',async()=>{
 const opts=heldDataOpts();
 await withServer(false,async(h)=>{
  const g=await ordinaryGrant(h);
  await status(h,g.token,g.grantId);
  await revokeGrant(g.grantId);
  const restore=loseHistory(join(opts.experimentalHeldDataLifecycle.journalDir,'authority.journal'),'suffix');
  const response=await revoke(h,h.ownerToken,g.grantId,{pdpp_disposition:'keep'});
  assert.equal(response.status, 200);
  assert.equal((response.body.lifecycle as { status: string }).status, 'pending');
  console.log('owner_keep_http=200 lifecycle_status=pending');
  restore();
  const authority=getHeldDataRuntime()!.authority;
  authority.reestablishHistory();
  const view=authority.ownerView(g.grantId,DAY)!;
  const entries=readFileSync(join(opts.experimentalHeldDataLifecycle.journalDir,'authority.journal'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  const keeps=entries.filter(e=>e.t==='hd_keep'&&e.grant_id===g.grantId).length;
  console.log('after_replay_pending='+view.pending_actions.length+' disposition='+view.ending?.disposition+' owner_notice_required='+view.ending?.owner_notice_required+' recorded_keep_entries='+keeps);
  assert.equal(view.pending_actions.length, 0);
  assert.equal(keeps, 1);
  assert.equal(view.ending?.owner_notice_required,false);
 },opts);
});

it('restored revoked access token authenticates new erasure',async()=>{
 await withServer(false,async h=>{
  const clientId=await registerPublicClient(h);
  const g=await authCodeGrant(h,clientId);
  const r=await fetchJson(h.asUrl+'/oauth/revoke',form({client_id:clientId,token:g.accessToken}));
  assert.equal(r.status,200);
  assert.equal((await introspect(g.accessToken)).active,false);
  getDb().prepare('UPDATE tokens SET revoked = 0 WHERE token_id = ?').run(g.accessToken);
  const active=(await introspect(g.accessToken)).active;
  const write=await lifecycle(h,{token:g.accessToken,grant_id:g.grantId,pdpp_disposition:'delete'});
  console.log('ACCESS_RESTORE',JSON.stringify({revoke:r.status,introspectionActive:active,writeHeldData:write.body.grants[0]?.held_data,writeError:write.body.grants[0]?.error??null}));
  assert.equal(active, false);
  assert.equal(write.body.grants[0]?.error,'current_authentication_required');
  assert.equal((await status(h, g.accessToken, g.grantId)).body.grants[0]?.held_data, 'permitted');
 },heldDataOpts());
});

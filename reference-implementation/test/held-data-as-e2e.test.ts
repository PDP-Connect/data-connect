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
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataClient } from "../lib/held-data/client.ts";
import { httpStatusTransport } from "../lib/held-data/http-transport.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { getHeldDataRuntime } from "../server/held-data/runtime.ts";
import { parseHostedMcpSelection } from "../server/hosted-mcp-selection.ts";
import {
  computeHostedMcpDecisionDigest,
  type HostedMcpConsentChallengeModel,
} from "../server/routes/as-consent-ui-helpers.ts";
import {
  fetchJson,
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
async function authCodeGrant(h: Harness, clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${h.asUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT);
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
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return {
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
    packageId: token.body.grant_package_id,
    packageToken: token.body.access_token,
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

describe("held-data lifecycle over HTTP", () => {
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
        getDb()
          .prepare("UPDATE grants SET expires_at = ? WHERE grant_id = ?")
          .run("2000-01-01T00:00:00.000Z", g.grantId);
        getDb()
          .prepare("UPDATE tokens SET expires_at = ? WHERE grant_id = ?")
          .run("2000-01-01T00:00:00.000Z", g.grantId);
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
        getDb().prepare("UPDATE grants SET status = 'active' WHERE grant_id = ?").run(g.grantId);
        getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(g.grantId);
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
        getDb()
          .prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?")
          .run('{"not":"a valid persisted grant"}', broken);
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
        getDb()
          .prepare(
            "UPDATE oauth_clients SET metadata_json = json_set(metadata_json, '$.issuer_subject_id', 'owner_local') WHERE client_id = ?",
          )
          .run(clientId);
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
        getDb().prepare("UPDATE grants SET status = 'active' WHERE grant_id = ?").run(g.grantId);
        getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(g.grantId);
        getDb()
          .prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?")
          .run(g.grantId);
        const r = await fetchJson(
          `${h.asUrl}/oauth/token`,
          form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken })
        );
        assert.equal(r.status, 400, JSON.stringify(r.body));
      },
      heldDataOpts()
    );
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
        getDb()
          .prepare("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE grant_id = ?")
          .run("2000-01-01T00:00:00.000Z", expired.grantId);
        const e = await lifecycle(h, { grant_id: expired.grantId, pdpp_disposition: "delete", token: expired.refreshToken });
        assert.equal(e.body.grants[0]?.error, "current_authentication_required");
        assert.equal(getHeldDataRuntime()?.authority.hasEnded(expired.grantId), false, "nothing was revoked");

        const restored = await authCodeGrant(h, clientId);
        await revoke(h, h.ownerToken, restored.grantId, { pdpp_disposition: "keep" });
        getDb()
          .prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?")
          .run(restored.grantId);
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
        getDb().prepare("UPDATE grants SET status = 'revoked' WHERE grant_id = ?").run(g.grantId);
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
});

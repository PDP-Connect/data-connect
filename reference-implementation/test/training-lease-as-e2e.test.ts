// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-training lease prototype: end-to-end AS behavior over HTTP (lease note
 * L0, L3, L4, L5, L9; Core processing-permission gate).
 *
 * Boots real servers: one with the experimental flag off (the Core gate and
 * unchanged metadata) and one with it on (PAR -> review -> approve -> lease
 * endpoint -> revocation and withdrawal -> owner-visible stop time).
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_TRAINING_PERMISSION } from "../lib/training-lease/constants.ts";
import {
  type Jwks,
  validateLeaseStatic,
} from "../lib/training-lease/worker.ts";
import { getDb } from "../server/db.ts";
import {
  fetchJson,
  issueTrainingGrant,
  json,
  leaseExpMs,
  MIN,
  PublicLeaseClient,
  par,
  trainingDetail,
  withServer,
} from "./helpers/training-lease-harness.ts";

describe("flag off: the Core gate and unchanged behavior", () => {
  it("rejects processing_permissions with invalid_authorization_details and advertises nothing", async () => {
    await withServer(false, async (h) => {
      const p = await par(h.asUrl, trainingDetail(h.connectorId));
      assert.equal(p.status, 400);
      assert.equal(p.errorCode, "invalid_authorization_details");
      const meta = await fetchJson(
        `${h.asUrl}/.well-known/oauth-authorization-server`,
      );
      assert.equal(meta.status, 200);
      assert.equal("pdpp_processing_permissions_supported" in meta.body, false);
      assert.equal("pdpp_processing_lease_endpoint" in meta.body, false);
      const lease = await fetchJson(
        `${h.asUrl}/oauth/processing-lease`,
        json({ grant_id: "grt_x" }),
      );
      assert.equal(lease.status, 404);
      // An ordinary request still succeeds.
      const ordinary = await par(
        h.asUrl,
        trainingDetail(h.connectorId, { processing_permissions: undefined }),
      );
      assert.equal(ordinary.status, 201, JSON.stringify(ordinary.body));
    });
  });
});

describe("flag on: issuance gate and consent binding", () => {
  it("advertises the permission, the lease endpoint and the JWKS", async () => {
    await withServer(true, async (h) => {
      const meta = await fetchJson<Record<string, unknown>>(
        `${h.asUrl}/.well-known/oauth-authorization-server`,
      );
      assert.deepEqual(meta.body.pdpp_processing_permissions_supported, [
        AI_TRAINING_PERMISSION,
      ]);
      assert.equal(
        meta.body.pdpp_processing_lease_endpoint,
        `${h.asUrl}/oauth/processing-lease`,
      );
      const jwks = await fetchJson<Jwks>(
        meta.body.pdpp_processing_lease_jwks_uri as string,
      );
      assert.equal(jwks.status, 200);
      assert.equal(jwks.body.keys.length, 1);
    });
  });

  it("rejects unknown, duplicate and malformed permissions, and a training detail without purpose_description", async () => {
    await withServer(true, async (h) => {
      for (const bad of [
        { processing_permissions: ["https://pdpp.dev/processing/other"] },
        {
          processing_permissions: [
            AI_TRAINING_PERMISSION,
            AI_TRAINING_PERMISSION,
          ],
        },
        { processing_permissions: ["not a uri"] },
        { processing_permissions: AI_TRAINING_PERMISSION },
        { purpose_description: undefined },
      ]) {
        const p = await par(h.asUrl, trainingDetail(h.connectorId, bad));
        assert.equal(p.status, 400, JSON.stringify(bad));
        assert.equal(
          p.errorCode,
          "invalid_authorization_details",
          JSON.stringify(bad),
        );
      }
    });
  });

  it("requires a distinct affirmative selection at review, binds the set and a training expires_at", async () => {
    await withServer(true, async (h) => {
      const p = await par(h.asUrl, trainingDetail(h.connectorId));
      assert.equal(p.status, 201);
      const unselected = await fetchJson(
        `${h.asUrl}/consent/review`,
        json({ request_uri: p.body.request_uri, subject_id: "owner_local" }),
      );
      assert.equal(unselected.status, 400);
      const g = await issueTrainingGrant(h);
      // Gap (contract schema is closed): the set is not in the review artifact.
      assert.equal("processing_permissions" in g.review, false);
      assert.equal(typeof g.review.expires_at, "string");
      assert.equal(g.grant.expires_at, g.review.expires_at);
    });
  });
});

describe("flag on: leases, endings and the owner's stop time", () => {
  it("public client: bootstrap with the grant token + DPoP returns a lease workers can validate", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      const r = await c.bootstrap(g.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.lease && r.body.lease_credential);
      const jwks = await fetchJson<Jwks>(
        `${h.asUrl}/oauth/processing-lease/jwks`,
      );
      const v = validateLeaseStatic(r.body.lease as string, jwks.body, {
        clientId: "concert_recommendation_app",
        grantId: g.grant.grant_id,
        iss: h.asUrl,
      });
      assert.equal(v.ok, true, JSON.stringify(v));
    });
  });

  it("a lease confers no data access: the RS rejects it as a bearer", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      const r = await c.bootstrap(g.token);
      const read = await fetch(`${h.rsUrl}/v1/streams/top_artists/records`, {
        headers: { Authorization: `Bearer ${r.body.lease}` },
      });
      assert.equal(read.status, 401);
    });
  });

  it("answers every refusal the same way: unknown, another client's, revoked, withdrawn", async () => {
    await withServer(true, async (h) => {
      const mine = await issueTrainingGrant(h);
      const theirs = await issueTrainingGrant(h, "longview");
      const c = new PublicLeaseClient(h, mine.grant.grant_id);
      await c.bootstrap(mine.token);
      const answers: Array<{ status: number; body: unknown }> = [];
      // Unknown grant with a valid token.
      answers.push(
        await fetchJson(
          `${h.asUrl}/oauth/processing-lease`,
          json(
            { grant_id: "grt_does_not_exist" },
            { Authorization: `Bearer ${mine.token}`, DPoP: c.proof() },
          ),
        ),
      );
      // Another client's grant, presented with our credential.
      answers.push(
        await fetchJson(
          `${h.asUrl}/oauth/processing-lease`,
          json(
            { grant_id: theirs.grant.grant_id, lease_credential: c.credential },
            { DPoP: c.proof() },
          ),
        ),
      );
      // Withdrawn.
      await fetchJson(
        `${h.asUrl}/v1/owner/grants/${mine.grant.grant_id}/training/withdraw`,
        json({}, { Authorization: `Bearer ${h.ownerToken}` }),
      );
      answers.push(await c.renew());
      // Revoked.
      const revoke = await fetch(
        `${h.asUrl}/grants/${theirs.grant.grant_id}/revoke`,
        {
          headers: { Authorization: `Bearer ${h.ownerToken}` },
          method: "POST",
        },
      );
      assert.equal(revoke.status, 200);
      answers.push(
        await fetchJson(
          `${h.asUrl}/oauth/processing-lease`,
          json(
            { grant_id: theirs.grant.grant_id },
            { Authorization: `Bearer ${theirs.token}`, DPoP: c.proof() },
          ),
        ),
      );
      for (const a of answers) {
        assert.deepEqual(a, answers[0]);
      }
      assert.equal(answers[0]?.status, 400);
    });
  });

  it("owner revocation (L4): no further lease, the read token dies, and T is the last lease's exp", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      const first = await c.bootstrap(g.token);
      h.clock.now += 25 * MIN;
      const second = await c.renew();
      assert.equal(second.status, 200);
      h.clock.now += MIN;
      const revoke = await fetch(
        `${h.asUrl}/grants/${g.grant.grant_id}/revoke`,
        {
          headers: { Authorization: `Bearer ${h.ownerToken}` },
          method: "POST",
        },
      );
      assert.equal(revoke.status, 200);
      const status = await fetchJson<{
        state: string;
        training_stops_by: string;
        owner_message: string;
      }>(`${h.asUrl}/v1/owner/grants/${g.grant.grant_id}/training`, {
        headers: { Authorization: `Bearer ${h.ownerToken}` },
      });
      assert.equal(status.body.state, "withdrawn");
      assert.equal(
        Date.parse(status.body.training_stops_by),
        leaseExpMs(second.body.lease as string),
      );
      assert.ok(
        leaseExpMs(first.body.lease as string) <=
          Date.parse(status.body.training_stops_by),
      );
      assert.match(
        status.body.owner_message,
        /^Training stops by .* for apps that follow PDPP\.$/,
      );
      assert.equal((await c.renew()).status, 400);
    });
  });

  it("client-initiated revocation (client bearer on its own grant) ends training authority too", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const revoke = await fetch(
        `${h.asUrl}/grants/${g.grant.grant_id}/revoke`,
        {
          headers: { Authorization: `Bearer ${g.token}` },
          method: "POST",
        },
      );
      assert.equal(revoke.status, 200);
      assert.equal((await c.renew()).status, 400);
    });
  });

  it("training withdrawal (L0): read access stays, leases stop", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      const first = await c.bootstrap(g.token);
      const w = await fetchJson<{ state: string; training_stops_by: string }>(
        `${h.asUrl}/v1/owner/grants/${g.grant.grant_id}/training/withdraw`,
        json({}, { Authorization: `Bearer ${h.ownerToken}` }),
      );
      assert.equal(w.status, 200);
      assert.equal(
        Date.parse(w.body.training_stops_by),
        leaseExpMs(first.body.lease as string),
      );
      assert.equal((await c.renew()).status, 400);
      const read = await fetch(`${h.rsUrl}/v1/streams/top_artists/records`, {
        headers: { Authorization: `Bearer ${g.token}` },
      });
      assert.notEqual(
        read.status,
        401,
        "the read token is untouched by a training-only withdrawal",
      );
    });
  });

  it("training expiry (L4): no lease at or after the grant's expires_at, and leases never outlast it", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const expiresAt = Date.parse(g.grant.expires_at as string);
      h.clock.now = expiresAt - 10 * MIN;
      const last = await c.renew();
      assert.equal(last.status, 200);
      assert.ok(leaseExpMs(last.body.lease as string) <= expiresAt);
      h.clock.now = expiresAt;
      assert.equal((await c.renew()).status, 400);
    });
  });

  it("a restore of the main database that resurrects a revoked grant does not resurrect training authority", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      await fetch(`${h.asUrl}/grants/${g.grant.grant_id}/revoke`, {
        headers: { Authorization: `Bearer ${h.ownerToken}` },
        method: "POST",
      });
      // What a restore from a pre-revocation backup does to this row.
      getDb()
        .prepare("UPDATE grants SET status = 'active' WHERE grant_id = ?")
        .run(g.grant.grant_id);
      assert.equal((await c.renew()).status, 400);
    });
  });
});

describe("flag on: L5 public-client credential chain", () => {
  it("lost response: a retry with the same DPoP proof gets the same successor", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const pred = c.credential as string;
      const proof = c.proof();
      const lost = await c.renew({ adopt: false, proof });
      const retry = await c.renew({ adopt: false, credential: pred, proof });
      assert.equal(lost.status, 200);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.lease_credential, lost.body.lease_credential);
    });
  });

  it("concurrent renewals with the same predecessor receive the same successor", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const pred = c.credential as string;
      const [a, b] = await Promise.all([
        c.renew({ adopt: false, credential: pred }),
        c.renew({ adopt: false, credential: pred }),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(a.body.lease_credential, b.body.lease_credential);
    });
  });

  it("reuse of a predecessor after its successor was used is theft: the chain is revoked and the owner sees it", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const pred = c.credential as string;
      const proofA = c.proof();
      const r1 = await c.renew({ proof: proofA });
      assert.equal(r1.status, 200);
      const r2 = await c.renew();
      assert.equal(r2.status, 200, "the successor is used");
      // The same proof as before is still a repeat, per L5.
      const repeat = await c.renew({
        adopt: false,
        credential: pred,
        proof: proofA,
      });
      assert.equal(repeat.status, 200);
      // A new use of the predecessor is theft.
      const theft = await c.renew({ adopt: false, credential: pred });
      assert.equal(theft.status, 400);
      assert.equal((await c.renew()).status, 400, "the whole chain is revoked");
      const status = await fetchJson<{
        credential_chains: Array<{ status: string; revoked_reason: string }>;
      }>(`${h.asUrl}/v1/owner/grants/${g.grant.grant_id}/training`, {
        headers: { Authorization: `Bearer ${h.ownerToken}` },
      });
      assert.equal(
        status.body.credential_chains[0]?.revoked_reason,
        "theft_detected",
      );
    });
  });

  it("finding: a lost-response retry after the DPoP freshness window cannot repeat the proof", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const pred = c.credential as string;
      const proof = c.proof();
      const lost = await c.renew({ adopt: false, proof });
      assert.equal(lost.status, 200);
      h.clock.now += 10 * MIN;
      const retry = await c.renew({ adopt: false, credential: pred, proof });
      assert.equal(
        retry.status,
        400,
        "RFC 9449 iat freshness rejects the repeated proof",
      );
      // A fresh proof still works while the successor is unused.
      const fresh = await c.renew({ adopt: false, credential: pred });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body.lease_credential, lost.body.lease_credential);
    });
  });

  it("a stolen credential without the DPoP key gets nothing and is not treated as theft", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      const thief = new PublicLeaseClient(h, g.grant.grant_id);
      const r = await thief.renew({ credential: c.credential as string });
      assert.equal(r.status, 400);
      assert.equal((await c.renew()).status, 200);
    });
  });

  it("the endpoint keeps issuing after the grant's access token is revoked (works after the read window)", async () => {
    await withServer(true, async (h) => {
      const g = await issueTrainingGrant(h);
      const c = new PublicLeaseClient(h, g.grant.grant_id);
      await c.bootstrap(g.token);
      getDb()
        .prepare("UPDATE tokens SET revoked = 1 WHERE grant_id = ?")
        .run(g.grant.grant_id);
      const read = await fetch(`${h.rsUrl}/v1/streams/top_artists/records`, {
        headers: { Authorization: `Bearer ${g.token}` },
      });
      assert.ok(
        read.status === 401 || read.status === 403,
        `read access is gone (${read.status})`,
      );
      assert.equal((await c.renew()).status, 200);
    });
  });
});

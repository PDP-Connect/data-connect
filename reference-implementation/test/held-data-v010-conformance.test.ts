// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Section 9 acceptance cases of the final v0.1.0 Core text (`held-data-cases`),
 * one `describe` per case and one `it` per stated outcome or variant, named by
 * case ID. PROTOTYPE.
 *
 * Classification (Core: "A conformance report MUST classify each assertion"):
 *   [PV] protocol-visible: observed on the AS wire (lifecycle operation,
 *        RFC 7009 revocation, token endpoint, introspection, RS read status) or
 *        on the authority's own durable record.
 *   [AO] adapter-observed: observed through the declared adapter. The declared
 *        adapters are (a) the RI owner JSON surface `/v1/owner/...` (there is no
 *        owner UI in the prototype) and (b) the toy app (`examples/held-data-toy-app`)
 *        for client use, retention, erasure, lineage and queued/in-flight work.
 *        The toy app's storage surfaces are its record store, word index, summary
 *        and digests; it has no backups and one downstream party (`ToySubprocessor`).
 * Failure domains exercised: the authority journal file, the epoch marker file, the
 * main (restorable) database, and the toy app's in-memory stores.
 *
 * `it(title, { skip: 'UNVERIFIED: reason' })` marks an outcome the prototype cannot run; the runner requires the reason.
 * `it.todo` marks a SPEC FINDING kept asserting the text.
 *
 * Not covered here (not in this file's brief): C1, C3 (unused), C6, C7 (not applicable until a processing
 * profile is published), C8.
 *
 * Known limits of the adapters: the toy app learns of a stop at its next use-gate check (`HeldStore` has no
 * cancel hook), so a cancellation time equals the receipt time only when deletion is prompt; the report
 * transport in the client journeys is the real HTTP transport, the status transport for the `Sim` cases is the
 * in-process authority.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import fs, { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToyApp } from "../examples/held-data-toy-app/app.ts";
import { HeldDataAuthority } from "../lib/held-data/authority.ts";
import { HeldDataClient } from "../lib/held-data/client.ts";
import { httpReportTransport, httpStatusTransport } from "../lib/held-data/http-transport.ts";
import { MemoryClientCheckpointStorage } from "../lib/held-data/checkpoint.ts";
import type { LegalRetentionSpec, StatusTransport } from "../lib/held-data/client.ts";
import { TrainingAuthorityStore } from "../lib/training-lease/authority-store.ts";
import { journalAllowsIssuance, readLossEvidence } from "../lib/authority-journal/journal.ts";
import {
  createConsentExchangeCode,
  exchangeGrantScopedDeviceCode,
  getGrantPackageAccess,
  introspect,
  issueToken,
  revokeGrant,
} from "../server/auth.ts";
import { AuthorityUnavailableError } from "../lib/held-data/authority.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { parseHostedMcpSelection } from "../server/hosted-mcp-selection.ts";
import { getHeldDataRuntime, installHeldDataRuntime } from "../server/held-data/runtime.ts";
import {
  computeHostedMcpDecisionDigest,
  type HostedMcpConsentChallengeModel,
} from "../server/routes/as-consent-ui-helpers.ts";
import {
  authCodeGrant,
  DAY,
  form,
  heldDataOpts,
  lifecycle,
  ordinaryDetail,
  owner,
  REDIRECT,
  registerPublicClient,
  rsRead,
  status,
} from "./helpers/held-data-as-http.ts";
import {
  approveRecovery,
  authorizeUrl,
  LIFECYCLE_TYPE,
  pkce,
  recoverLifecycle,
  tokenForm,
} from "./helpers/held-data-recovery-flow.ts";
import { HOUR, MIN, Sim, T0, tempDir } from "./helpers/held-data-sim.ts";
import {
  fetchJson,
  type Harness,
  json,
  mutateMainDatabase,
  seedInstance,
  withServer,
} from "./helpers/training-lease-harness.ts";

// ---------------------------------------------------------------------------
// Local helpers (the e2e file keeps its own copies private).
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

const revoke = (h: Harness, bearer: string, grantId: string, body: Body = {}) =>
  fetchJson<Body>(`${h.asUrl}/grants/${grantId}/revoke`, json(body, { Authorization: `Bearer ${bearer}` }));

async function revokeToken(h: Harness, params: Record<string, string>) {
  const response = await fetch(`${h.asUrl}/oauth/revoke`, form(params));
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Body) : null };
}

const answerOf = async (h: Harness, token: string, grantId: string) =>
  (await status(h, token, grantId)).body.grants[0] as Record<string, any>;

async function secondConnector(h: Harness): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "seed-manifests", "github.json"), "utf8"),
  ) as { connector_id: string };
  const reg = await fetch(`${h.asUrl}/connectors`, json(manifest));
  assert.equal(reg.status, 201);
  await seedInstance(manifest.connector_id);
  return manifest.connector_id;
}

/** Hosted-MCP picker flow: one package with a child grant per connector. */
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
        sources: chosen.map((s) => ({ sourceKey: s.id, streamNames: s.streams.map((x) => x.name).sort() })),
      }),
      grant_expiry: model.grantExpiry.defaultId,
      review_digest: model.reviewDigest,
      source_id: chosen.map((s) => s.id),
      stream: chosen.flatMap((s) => s.streams.map((x) => x.id)),
    }),
  );
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const code = new URL(approve.body.redirect_url as string).searchParams.get("code") as string;
  const token = await fetchJson<{ grant_package_id: string; access_token: string; refresh_token: string }>(
    `${h.asUrl}/oauth/token`,
    form({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: REDIRECT }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  const detail = await fetchJson<{ children: { grant_id: string }[] }>(
    `${h.asUrl}/_ref/grant-packages/${encodeURIComponent(token.body.grant_package_id)}`,
  );
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  return {
    packageId: token.body.grant_package_id,
    packageToken: token.body.access_token,
    refreshToken: token.body.refresh_token,
    children: detail.body.children.map((c) => c.grant_id),
  };
}

const ownerView = async (h: Harness, grantId: string) => (await owner(h, `/v1/owner/grants/${grantId}/lifecycle`)).body;
const erasuresOf = (record: Body) => record.erasures as Record<string, any>[];

// ---------------------------------------------------------------------------
// P1
// ---------------------------------------------------------------------------

describe("P1. Owner withdrawal at the AS", () => {
  /** A client holding an active `continuous` grant and a consumed `single_use` grant. */
  async function twoGrants(h: Harness) {
    const clientId = await registerPublicClient(h);
    const active = await authCodeGrant(h, clientId);
    const single = await authCodeGrant(h, clientId, { access_mode: "single_use" });
    assert.equal(await rsRead(h, single.accessToken), 200, "the single_use grant is read once");
    await mutateMainDatabase("UPDATE grants SET consumed = 1 WHERE grant_id = ?", [single.grantId]);
    assert.equal(
      (getDb().prepare("SELECT access_mode FROM grants WHERE grant_id = ?").get(single.grantId) as { access_mode: string })
        .access_mode,
      "single_use",
    );
    return { clientId, active, single };
  }

  it("P1: lists both grants and presents keep and delete with neither preselected [AO]", { skip: "UNVERIFIED: the RI has no interactive owner surface; the only listing is the decommission offer (P9) and the statements exist only after a choice" }, () => {});

  it("P1: rejects a programmatic request that lacks a disposition, for a grant and for the whole client, and ends nothing [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, active, single } = await twoGrants(h);
        for (const g of [active, single]) {
          const r = await revoke(h, h.ownerToken, g.grantId);
          assert.equal(r.status, 400, JSON.stringify(r.body));
        }
        await mutateMainDatabase(
          "UPDATE oauth_clients SET metadata_json = json_set(metadata_json, '$.issuer_subject_id', 'owner_local') WHERE client_id = ?",
          [clientId],
          "UPDATE oauth_clients SET metadata_json = jsonb_set(metadata_json, '{issuer_subject_id}', '\"owner_local\"') WHERE client_id = ?",
        );
        const client = await fetch(`${h.asUrl}/oauth/register/${encodeURIComponent(clientId)}`, { method: "DELETE" });
        assert.equal(client.status, 400, await client.text());
        const defaulted = await fetch(`${h.asUrl}/oauth/register/${encodeURIComponent(clientId)}?pdpp_disposition=maybe`, {
          method: "DELETE",
        });
        assert.equal(defaulted.status, 400, "an unknown value is not defaulted either");
        assert.equal(await rsRead(h, active.accessToken), 200, "no default was applied and nothing was revoked");
        for (const g of [active, single]) {
          assert.equal((await answerOf(h, g.accessToken, g.grantId)).read_state === "revoked", false);
          assert.equal(getHeldDataRuntime()?.authority.hasEnded(g.grantId), false);
        }
      },
      heldDataOpts(),
    );
  });

  it("P1: lifecycle answers report revoked with held_data matching each recorded disposition; a keep grant answers permitted [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { active, single } = await twoGrants(h);
        assert.equal((await revoke(h, h.ownerToken, active.grantId, { pdpp_disposition: "keep" })).status, 200);
        assert.equal((await revoke(h, h.ownerToken, single.grantId, { pdpp_disposition: "delete" })).status, 200);
        const kept = await answerOf(h, active.accessToken, active.grantId);
        assert.equal(kept.read_state, "revoked");
        assert.equal(kept.held_data, "permitted");
        assert.equal(kept.erasure, undefined);
        const deleted = await answerOf(h, single.accessToken, single.grantId);
        assert.equal(deleted.read_state, "revoked");
        assert.equal(deleted.held_data, "erase");
        assert.ok(deleted.erasure.instruction_id);
      },
      heldDataOpts(),
    );
  });

  it("P1: one choice applies to the whole client: a delete disconnect makes both grants answer revoked and erase [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, active, single } = await twoGrants(h);
        await mutateMainDatabase(
          "UPDATE oauth_clients SET metadata_json = json_set(metadata_json, '$.issuer_subject_id', 'owner_local') WHERE client_id = ?",
          [clientId],
          "UPDATE oauth_clients SET metadata_json = jsonb_set(metadata_json, '{issuer_subject_id}', '\"owner_local\"') WHERE client_id = ?",
        );
        const done = await fetch(`${h.asUrl}/oauth/register/${encodeURIComponent(clientId)}?pdpp_disposition=delete`, {
          method: "DELETE",
        });
        assert.equal(done.status, 204, await done.text());
        for (const g of [active, single]) {
          const a = await answerOf(h, g.accessToken, g.grantId);
          assert.equal(a.read_state, "revoked");
          assert.equal(a.held_data, "erase");
        }
      },
      heldDataOpts(),
    );
  });

  it("P1 (variant): the owner later requests erasure of the keep grant: the AS records a new instruction and the answer becomes erase [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const { active } = await twoGrants(h);
        assert.equal((await revoke(h, h.ownerToken, active.grantId, { pdpp_disposition: "keep" })).status, 200);
        const endedAt = (await answerOf(h, active.accessToken, active.grantId)).ended_at as string;
        assert.deepEqual(erasuresOf(await ownerView(h, active.grantId)), [], "keep recorded no instruction");
        clock.now += DAY;
        const erase = await owner(h, `/v1/owner/grants/${active.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        const a = await answerOf(h, active.accessToken, active.grantId);
        assert.equal(a.held_data, "erase");
        assert.equal(a.read_state, "revoked");
        assert.equal(a.ended_at, endedAt, "the ending is unchanged");
        assert.equal(Date.parse(a.erasure.accepted_at) - Date.parse(endedAt) >= DAY - 1000, true, "a new instruction with its own acceptance time");
        assert.equal(a.erasure.effective_at, a.erasure.accepted_at);
        assert.equal(erasuresOf(await ownerView(h, active.grantId)).length, 1);
      },
      heldDataOpts(clock),
    );
  });
});

// ---------------------------------------------------------------------------
// P1a
// ---------------------------------------------------------------------------

describe("P1a. Package with an ended child", () => {
  async function pkgWithKeptA(h: Harness) {
    const clientId = await registerPublicClient(h);
    const pkg = await packageFlow(h, clientId, [h.connectorId, await secondConnector(h)]);
    const [a, b] = pkg.children as [string, string];
    assert.equal((await revoke(h, h.ownerToken, a, { pdpp_disposition: "keep", pdpp_ending: "one_child_withdrawal" })).status, 200);
    return { clientId, pkg, a, b };
  }

  it("P1a: A (revoked earlier with keep) and B (active) both answer erase after a package disconnect with delete and current client authentication [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, pkg, a, b } = await pkgWithKeptA(h);
        assert.equal((await answerOf(h, pkg.refreshToken, a)).held_data, "permitted", "A was kept");
        assert.equal((await answerOf(h, pkg.refreshToken, b)).read_state, "active");
        const r = await revokeToken(h, {
          client_id: clientId,
          token: pkg.refreshToken,
          pdpp_disposition: "delete",
          reported_at: new Date(Date.now() - 1000).toISOString(),
        });
        assert.equal(r.status, 200);
        for (const id of [a, b]) {
          assert.equal((await answerOf(h, pkg.refreshToken, id)).held_data, "erase", id);
        }
      },
      heldDataOpts(),
    );
  });

  it("P1a (variant): the AS records B's instruction but not A's: HTTP 503 with A pending and B recorded, not reported complete; a retry records A and leaves B's clocks unchanged [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const { clientId, pkg, a, b } = await pkgWithKeptA(h);
        const original = getDb().prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get(a)?.grant_json;
        getDb().prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?").run('{"not":"a valid persisted grant"}', a);
        const params = {
          client_id: clientId,
          token: pkg.refreshToken,
          pdpp_disposition: "delete",
          reported_at: new Date(clock.now).toISOString(),
        };
        const partial = await fetchJson<{ error: string; grants: { grant_id: string; state: string }[] }>(
          `${h.asUrl}/oauth/revoke`,
          form(params),
        );
        assert.equal(partial.status, 503);
        assert.equal(partial.body.error, "temporarily_unavailable");
        assert.deepEqual(partial.body.grants, [
          { grant_id: a, state: "pending" },
          { grant_id: b, state: "recorded" },
        ]);
        const bBefore = getHeldDataRuntime()?.authority.ownerView(b, 30 * DAY);
        assert.equal(bBefore?.erasures.length, 1, "B's instruction is recorded");
        assert.equal(getHeldDataRuntime()?.authority.ownerView(a, 30 * DAY)?.erasures.length, 0, "A's is not");
        getDb().prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?").run(original, a);
        clock.now += DAY;
        const retry = await revokeToken(h, { ...params, reported_at: new Date(clock.now).toISOString() });
        assert.equal(retry.status, 200, "the same request completes");
        const bAfter = getHeldDataRuntime()?.authority.ownerView(b, 30 * DAY);
        assert.deepEqual(bAfter?.ending, bBefore?.ending);
        assert.deepEqual(bAfter?.erasures, bBefore?.erasures, "B's instruction clocks are unchanged");
        assert.equal(getHeldDataRuntime()?.authority.ownerView(a, 30 * DAY)?.erasures.length, 1, "the retry records A");
        for (const id of [a, b]) {
          assert.equal((await answerOf(h, pkg.refreshToken, id)).held_data, "erase");
        }
      },
      heldDataOpts(clock),
    );
  });
});

// ---------------------------------------------------------------------------
// P2
// ---------------------------------------------------------------------------

describe("P2. One package child", () => {
  /** Package {A, B}, a ToyApp client holding both with a derivative that mixes them, and A withdrawn with delete. */
  async function withdrawA(h: Harness, clock: { now: number }) {
    const clientId = await registerPublicClient(h);
    const pkg = await packageFlow(h, clientId, [h.connectorId, await secondConnector(h)]);
    const childOf = (connector: string) =>
      pkg.children.find((id) =>
        (getDb().prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get(id) as { grant_json: string }).grant_json.includes(connector),
      ) as string;
    const b = childOf(h.connectorId);
    const a = childOf("github");
    assert.ok(a && b && a !== b);
    const app = new ToyApp();
    const client = new HeldDataClient({
      now: () => clock.now,
      store: app,
      status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: () => pkg.refreshToken }),
    });
    app.attach(client);
    app.sync(a, [{ id: "a1", stream: "messages", text: "alphaonly shared" }]);
    app.sync(b, [{ id: "b1", stream: "messages", text: "bravoonly shared" }]);
    app.buildDigest("ab", [a, b]);
    await client.reconcile();
    const readable = async () =>
      ((await getGrantPackageAccess(pkg.packageId))?.members as { grant_id: string }[]).map((m) => m.grant_id).sort();
    assert.deepEqual(await readable(), [a, b].sort(), "the package token reads both children first");
    const out = await revoke(h, h.ownerToken, a, { pdpp_disposition: "delete", pdpp_ending: "one_child_withdrawal" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    return { pkg, a, b, app, client, readable };
  }

  it("P2: A answers erase; B still reads through the package and its answer is permitted [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const { pkg, a, b, readable } = await withdrawA(h, clock);
        assert.equal((await answerOf(h, pkg.refreshToken, a)).held_data, "erase");
        const bAnswer = await answerOf(h, pkg.refreshToken, b);
        assert.equal(bAnswer.held_data, "permitted");
        assert.equal(bAnswer.read_state, "active");
        assert.deepEqual(await readable(), [b], "B still reads; A does not");
        assert.equal((await introspect(pkg.packageToken)).active, true, "the shared credential stays active");
      },
      heldDataOpts(clock),
    );
  });

  it("P2: the client deletes A's data, and deletes or regenerates without A every derivative that mixes A and B [AO]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const { a, b, app, client } = await withdrawA(h, clock);
        await client.reconcile();
        assert.equal(client.canUse(a).ok, false);
        assert.deepEqual(app.holds(a), { records: 0, indexEntries: 0, summary: false });
        assert.equal(client.canUse(b).ok, true);
        assert.deepEqual(app.search(b, "shared"), [`${b}:b1`], "B is still searchable");
        assert.deepEqual(app.digests.get("ab")?.entries, [`${b}:b1`], "the A+B derivative is regenerated without A");
      },
      heldDataOpts(clock),
    );
  });
});

// ---------------------------------------------------------------------------
// P3
// ---------------------------------------------------------------------------

describe("P3. Narrowing", () => {
  async function narrow(h: Harness) {
    const clientId = await registerPublicClient(h);
    const g = await authCodeGrant(h, clientId);
    const out = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "delete", pdpp_ending: "narrowing" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const g2 = await authCodeGrant(h, clientId, {
      streams: [{ fields: ["id", "name"], name: "top_artists" }],
    });
    return { clientId, g, g2 };
  }

  it("P3: before the final step the AS states the effect of each disposition [AO]", { skip: "UNVERIFIED: the RI has no narrowing surface; Core's Grant narrowing statement (keep and delete effects) is not produced anywhere, and the prototype has no UI to observe" }, () => {});

  it("P3: G answers erase and the client deletes its G copy [PV+AO]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const { g, g2 } = await narrow(h);
        assert.equal(await rsRead(h, g.accessToken), 403);
        const a = await answerOf(h, g.refreshToken, g.grantId);
        assert.equal(a.read_state, "revoked");
        assert.equal(a.held_data, "erase");
        const app = new ToyApp();
        const client = new HeldDataClient({
          now: () => clock.now,
          store: app,
          status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: (id: string) => (id === g.grantId ? g.refreshToken : g2.accessToken) }),
        });
        app.attach(client);
        app.sync(g.grantId, [{ id: "a1", stream: "top_artists", text: "radiohead" }]);
        await client.reconcile();
        assert.equal(client.canUse(g.grantId).ok, false);
        assert.deepEqual(app.holds(g.grantId), { records: 0, indexEntries: 0, summary: false }, "the G copy is deleted");
      },
      heldDataOpts(clock),
    );
  });

  it("P3: if the client reacquires, the acquisition is under G2 and within G2's scope; G's instruction stays terminal [PV+AO]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const { g, g2 } = await narrow(h);
        const app = new ToyApp();
        const client = new HeldDataClient({
          now: () => clock.now,
          store: app,
          status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: (id: string) => (id === g.grantId ? g.refreshToken : g2.accessToken) }),
        });
        app.attach(client);
        // G2 is narrower than G, and its token reads only what G2 covers.
        const fieldsOf = (id: string) =>
          (JSON.parse((getDb().prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get(id) as { grant_json: string }).grant_json) as {
            streams: { name: string; fields?: string[] }[];
          }).streams.map((s) => `${s.name}:${(s.fields ?? []).join(",")}`);
        const gFields = fieldsOf(g.grantId);
        const g2Fields = fieldsOf(g2.grantId);
        assert.deepEqual(g2Fields, ["top_artists:id,name"]);
        assert.notDeepEqual(g2Fields, gFields, "G2 is narrower than G");
        assert.equal(await rsRead(h, g2.accessToken), 200, "the covered stream reads under G2");
        const outside = await fetch(`${h.rsUrl}/v1/streams/saved_tracks/records`, { headers: { Authorization: `Bearer ${g2.accessToken}` } });
        assert.notEqual(outside.status, 200, "a stream G2 does not cover is refused");
        app.sync(g2.grantId, [{ id: "a1", stream: "top_artists", text: "radiohead" }]);
        await client.reconcile();
        assert.equal(client.canUse(g2.grantId).ok, true, "G2 is permitted");
        assert.equal((await answerOf(h, g2.accessToken, g2.grantId)).held_data, "permitted");
        assert.equal((await answerOf(h, g.refreshToken, g.grantId)).held_data, "erase", "the new grant did not cancel G's instruction");
        // A late delivery under G after the instruction stays disposed.
        app.sync(g.grantId, [{ id: "a1", stream: "top_artists", text: "radiohead" }]);
        await client.reconcile();
        assert.equal(client.canUse(g.grantId).ok, false);
        assert.deepEqual(app.holds(g.grantId), { records: 0, indexEntries: 0, summary: false });
      },
      heldDataOpts(clock),
    );
  });

  it("P3: relabeling an old G acquisition as G2's never evades G's instruction [AO]", { skip: "UNVERIFIED: the toy app has no relabel operation and the client library cannot observe one; only the late-delivery case above is exercised" }, () => {});

  it("P3 (note): choosing not to reacquire does not fail the case [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, g2 } = await narrow(h);
        assert.equal((await answerOf(h, g.refreshToken, g.grantId)).held_data, "erase");
        assert.equal((await answerOf(h, g2.accessToken, g2.grantId)).held_data, "permitted");
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P4
// ---------------------------------------------------------------------------

/** A confidential client (CIMD, private_key_jwt) and its client assertions. */
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
  const cimdFetchDependencies = {
    dnsLookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (input: unknown) =>
      new Response(JSON.stringify(String(input) === jwksUri ? jwks : doc), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    isGlobalUnicastAddressImpl: () => true,
  };
  return { clientId, doc, privateKey, cimdFetchDependencies };
}

function clientAuth(c: { clientId: string; privateKey: KeyObject }, audience: string): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc({
    aud: audience,
    exp: now + 60,
    iat: now,
    iss: c.clientId,
    jti: randomBytes(8).toString("hex"),
    sub: c.clientId,
  })}`;
  return {
    client_assertion: `${input}.${sign("RSA-SHA256", Buffer.from(input), c.privateKey).toString("base64url")}`,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_id: c.clientId,
  };
}

/** Authorization-code flow for a public client that also returns the code and PKCE verifier (to replay the exchange). */
async function authCodeGrantWithCode(h: Harness, clientId: string) {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${h.asUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", "s1");
  authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("authorization_details", JSON.stringify([ordinaryDetail(h.connectorId, { access_mode: "continuous" })]));
  const a = await fetch(authorize, { redirect: "manual" });
  assert.equal(a.status, 302, await a.text());
  const requestUri = new URL(a.headers.get("location") as string, h.asUrl).searchParams.get("request_uri");
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({ request_uri: requestUri, subject_id: "owner_local" }),
  );
  const approve = await fetch(`${h.asUrl}/consent/approve`, {
    ...json({ approval_review_revision: review.body.approval_review_revision, request_uri: requestUri }),
    redirect: "manual",
  });
  assert.equal(approve.status, 302);
  const code = new URL(approve.headers.get("location") as string).searchParams.get("code") as string;
  const token = await fetchJson<{ access_token: string; refresh_token: string; grant_id: string }>(
    `${h.asUrl}/oauth/token`,
    form({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: REDIRECT }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return { accessToken: token.body.access_token, grantId: token.body.grant_id, refreshToken: token.body.refresh_token, code, verifier };
}

/** Authorization-code flow for a confidential CIMD client (private_key_jwt at the token endpoint). */
async function confidentialAuthCodeGrant(h: Harness, c: ReturnType<typeof cimdClient>) {
  const redirect = c.doc.redirect_uris[0] as string;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${h.asUrl}/oauth/authorize`);
  authorize.searchParams.set("client_id", c.clientId);
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
  const approve = await fetch(`${h.asUrl}/consent/approve`, {
    ...json({ approval_review_revision: review.body.approval_review_revision, request_uri: requestUri }),
    redirect: "manual",
  });
  assert.equal(approve.status, 302);
  const code = new URL(approve.headers.get("location") as string).searchParams.get("code") as string;
  const token = await fetchJson<{ access_token: string; refresh_token: string; grant_id: string }>(
    `${h.asUrl}/oauth/token`,
    form({ ...clientAuth(c, `${h.asUrl}/oauth/token`), code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect }),
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return { accessToken: token.body.access_token, grantId: token.body.grant_id, refreshToken: token.body.refresh_token };
}

const refreshWith = (h: Harness, clientId: string, refreshToken: string) =>
  fetchJson<{ access_token: string; refresh_token: string }>(
    `${h.asUrl}/oauth/token`,
    form({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
  );

describe("P4. Revocation at the owner's direction", () => {
  it("P4: the client's stop-use and deletion clocks start at the owner's choice, not at AS acceptance [AO]", async () => {
    const sim = new Sim({ policy: { disposeAt: "deadline" } });
    sim.sync();
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("g1").ok, true);
    sim.outages = [[sim.t, sim.t + 400 * DAY]]; // the AS is unreachable
    const choice = sim.t;
    sim.client.ownerDelete("g1");
    assert.deepEqual(sim.client.canUse("g1"), { ok: false, reason: "erased" }, "use stops at the owner's choice");
    assert.equal(sim.client.deleteBy("g1"), choice + 30 * DAY, "the deletion clock starts at the choice");
    await sim.runUntil(choice + 20 * DAY, 6 * HOUR);
    assert.equal(sim.app.holds("g1").records, 2, "nothing is due before the owner-choice deadline");
    assert.equal(sim.client.deleteBy("g1"), choice + 30 * DAY, "the unreachable AS moved nothing");
    await sim.runUntil(choice + 30 * DAY, 6 * HOUR);
    assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false }, "deleted by the owner-choice deadline");
  });

  it("P4: the family's grants answer erase, and a reported owner-choice time is recorded as receipt despite delayed delivery [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await secondConnector(h)]);
        const choice = clock.now - 10 * DAY;
        const r = await revokeToken(h, {
          client_id: clientId,
          token: pkg.refreshToken,
          pdpp_disposition: "delete",
          reported_at: new Date(choice).toISOString(),
        });
        assert.equal(r.status, 200);
        for (const id of pkg.children) {
          const a = await answerOf(h, pkg.refreshToken, id);
          assert.equal(a.read_state, "revoked");
          assert.equal(a.held_data, "erase", `each grant the family covers answers erase (${id})`);
          const e = erasuresOf(await ownerView(h, id))[0]!;
          assert.equal(Date.parse(e.receipt_at), choice, "the AS records the owner-choice time as receipt");
          assert.equal(Date.parse(e.delete_by), choice + 30 * DAY, "the deletion date counts from that receipt");
          assert.ok(Date.parse(e.accepted_at) >= clock.now - 1000, "acceptance is the later delivery time, not the choice");
        }
      },
      heldDataOpts(clock),
    );
  });

  it("P4: without a reported owner-choice time the AS records no receipt-based date and shows no deletion date [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await revokeToken(h, { client_id: clientId, token: g.refreshToken, pdpp_disposition: "delete" })).status, 200);
        assert.equal((await answerOf(h, g.refreshToken, g.grantId)).held_data, "erase");
        const e = erasuresOf(await ownerView(h, g.grantId))[0]!;
        assert.equal(e.receipt_at, null);
        assert.equal(e.delete_by, null);
        assert.match(e.owner_message, /No deletion date applies yet/);
      },
      heldDataOpts(),
    );
  });

  it("P4 (variant): a public client presenting only a superseded refresh token: the grants end and no disposition is recorded [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const rotated = await refreshWith(h, clientId, g.refreshToken);
        assert.equal(rotated.status, 200);
        const r = await revokeToken(h, { client_id: clientId, token: g.refreshToken, pdpp_disposition: "delete" });
        assert.equal(r.status, 200);
        const a = await answerOf(h, g.refreshToken, g.grantId);
        assert.equal(a.read_state, "revoked", "the grant ended");
        assert.equal(a.held_data, "permitted", "no disposition was recorded");
        assert.equal(getHeldDataRuntime()?.authority.ownerView(g.grantId, 30 * DAY)?.ending?.disposition, null);
        assert.deepEqual(erasuresOf(await ownerView(h, g.grantId)), []);
      },
      heldDataOpts(),
    );
  });

  it("P4 (variant): a confidential client with valid current authentication records delete even when the target token is superseded [PV]", async () => {
    const c = cimdClient();
    await withServer(
      false,
      async (h) => {
        const g = await confidentialAuthCodeGrant(h, c);
        const rotated = await fetchJson<{ refresh_token: string }>(
          `${h.asUrl}/oauth/token`,
          form({ ...clientAuth(c, `${h.asUrl}/oauth/token`), grant_type: "refresh_token", refresh_token: g.refreshToken }),
        );
        assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
        const r = await revokeToken(h, {
          ...clientAuth(c, h.asUrl),
          token: g.refreshToken,
          pdpp_disposition: "delete",
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const a = (
          await lifecycle(h, { ...clientAuth(c, h.asUrl), grant_id: g.grantId })
        ).body.grants[0] as Record<string, any>;
        assert.equal(a.read_state, "revoked");
        assert.equal(a.held_data, "erase");
      },
      { ...heldDataOpts(), cimdFetchDependencies: c.cimdFetchDependencies } as never,
    );
  });

  /** Fail the next journal append whose line contains `needle`, as a crash at that point would. */
  async function crashingAppend<T>(needle: string, run: () => Promise<T>): Promise<T> {
    const original = fs.writeSync;
    fs.writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
      if (typeof data === "string" && data.includes(needle)) {
        fs.writeSync = original;
        syncBuiltinESMExports();
        throw new Error(`injected crash before ${needle}`);
      }
      return (original as (...a: unknown[]) => number)(fd, data, ...rest);
    }) as typeof fs.writeSync;
    syncBuiltinESMExports();
    try {
      return await run();
    } finally {
      fs.writeSync = original;
      syncBuiltinESMExports();
    }
  }

  // The prototype records the owner's pending disposition first and the family revocation last, so the
  // window "family revocation recorded, disposition not" cannot arise; these are the two windows around it.
  for (const [window, needle, expectedStatus, expectedMidway] of [
    ["before the ending and instruction are recorded", '"t":"hd_end"', 503, "permitted"],
    ["after the disposition and before the family revocation is recorded", '"t":"hd_family_revoke"', 500, "erase"],
  ] as const) {
    it(`P4 (variant): the AS fails ${window}; a retry of the same request with no replacement credential completes the disposition without new owner approval and without restarting any clock [PV]`, async () => {
      const clock = { now: Date.now() };
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          const choice = new Date(clock.now - 5 * 60_000).toISOString();
          const request = { client_id: clientId, token: g.refreshToken, pdpp_disposition: "delete", reported_at: choice };
          const first = await crashingAppend(needle, () => revokeToken(h, request).catch((err) => ({ status: -1, body: { error: String(err) } })));
          assert.equal(first.status, expectedStatus, "the failed attempt was not acknowledged");
          const midway = await answerOf(h, g.refreshToken, g.grantId);
          assert.equal(midway.held_data, expectedMidway, "the state the failure left");
          clock.now += 2 * HOUR;
          const retry = await revokeToken(h, request);
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          const a = await answerOf(h, g.refreshToken, g.grantId);
          assert.equal(a.read_state, "revoked");
          assert.equal(a.held_data, "erase", "the disposition is complete");
          const e = erasuresOf(await ownerView(h, g.grantId));
          assert.equal(e.length, 1, "one instruction");
          assert.equal(Date.parse(e[0]!.receipt_at), Date.parse(choice), "the owner-choice clock is not restarted by the retry");
          assert.equal(Date.parse(e[0]!.delete_by), Date.parse(choice) + 30 * DAY);
          const approvals = readFileSync(getHeldDataRuntime()!.authority.journalPath, "utf8").split("\n").filter((l) => l.includes('"hd_recovery_approval"'));
          assert.equal(approvals.length, 0, "no owner approval was needed");
          assert.equal((await refreshWith(h, clientId, g.refreshToken)).status, 400, "the family is revoked");
        },
        heldDataOpts(clock),
      );
    });
  }
});

// SPEC FINDING (P4, crash variant): the text names the window "after recording the family revocation and before
// recording the disposition". The prototype never opens that window: it journals the owner's pending disposition
// first and the family revocation last, so the two windows on either side are tested above. If the family revocation
// is forced into the journal first, a retry of the same request ends the grant but does NOT record the disposition
// (the answer stays `permitted`), because a revoked family no longer counts as current client authentication. The
// outcome the case wants is reachable only by ordering the disposition before the revocation; the text states the
// outcome as if any order works.
describe("P4. literal crash window (family revocation recorded first)", () => {
  it.todo("P4 (variant, literal window): family revocation recorded and disposition not; a retry of the same request completes the disposition without new owner approval [PV] - SPEC FINDING: unreachable in this prototype; see the comment above");
});

// ---------------------------------------------------------------------------
// P5
// ---------------------------------------------------------------------------

describe("P5. Token revocation without a disposition", () => {
  it("P5: revoking the refresh-token family without pdpp_disposition ends the grants; they answer revoked and permitted; no erasure instruction exists [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await secondConnector(h)]);
        assert.equal((await revokeToken(h, { client_id: clientId, token: pkg.refreshToken })).status, 200);
        for (const id of pkg.children) {
          const a = await answerOf(h, pkg.refreshToken, id);
          assert.equal(a.read_state, "revoked");
          assert.equal(a.held_data, "permitted");
          assert.equal(a.erasure, undefined);
          assert.deepEqual(erasuresOf(await ownerView(h, id)), [], "no erasure instruction exists");
        }
      },
      heldDataOpts(),
    );
  });

  it("P5: revoking an access token that a family covers ends only that token [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await introspect(g.accessToken)).active, true);
        assert.equal((await revokeToken(h, { client_id: clientId, token: g.accessToken })).status, 200);
        assert.equal((await introspect(g.accessToken)).active, false, "the token ended");
        const a = await answerOf(h, g.refreshToken, g.grantId);
        assert.equal(a.read_state, "active", "the grant did not end");
        assert.equal(a.held_data, "permitted");
        const next = await refreshWith(h, clientId, g.refreshToken);
        assert.equal(next.status, 200, "the family still refreshes");
        assert.equal((await introspect(next.body.access_token)).active, true);
      },
      heldDataOpts(),
    );
  });

  it("P5 (variant): revoking an access token that no family covers ends its grants, which answer revoked and permitted [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        // A grant approved without a refresh family.
        const g = await ordinaryGrantPar(h);
        const clientId = getDb().prepare("SELECT client_id FROM grants WHERE grant_id = ?").get(g.grantId)?.client_id as string;
        assert.equal(getDb().prepare("SELECT 1 FROM oauth_refresh_tokens WHERE grant_id = ?").get(g.grantId), undefined, "no family covers it");
        assert.equal((await revokeToken(h, { client_id: clientId, token: g.token })).status, 200);
        const a = await answerOf(h, g.token, g.grantId);
        assert.equal(a.read_state, "revoked");
        assert.equal(a.held_data, "permitted");
        assert.deepEqual(erasuresOf(await ownerView(h, g.grantId)), []);
      },
      heldDataOpts(),
    );
  });
});

/** PAR, review and approve an ordinary grant (no refresh family). */
async function ordinaryGrantPar(h: Harness, extra: Body = {}) {
  const { par } = await import("./helpers/training-lease-harness.ts");
  const p = await par(h.asUrl, ordinaryDetail(h.connectorId, extra));
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const review = await fetchJson<{ approval_review_revision: string }>(
    `${h.asUrl}/consent/review`,
    json({ request_uri: p.body.request_uri, subject_id: "owner_local" }),
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approved = await fetchJson<{ grant: { grant_id: string }; token: string }>(
    `${h.asUrl}/consent/approve`,
    json({ approval_review_revision: review.body.approval_review_revision, request_uri: p.body.request_uri }),
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { grantId: approved.body.grant.grant_id, token: approved.body.token };
}

// ---------------------------------------------------------------------------
// P6
// ---------------------------------------------------------------------------

describe("P6. Expiry", () => {
  it("P6: at expires_at reads end, and the answer is expired and permitted [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrantPar(h);
        assert.equal(await rsRead(h, g.token), 200);
        const past = "2000-01-01T00:00:00.000Z";
        await mutateMainDatabase("UPDATE grants SET expires_at = ? WHERE grant_id = ?", [past, g.grantId]);
        await mutateMainDatabase("UPDATE tokens SET expires_at = ? WHERE grant_id = ?", [past, g.grantId]);
        assert.equal(await rsRead(h, g.token), 403, "reads ended");
        const a = await answerOf(h, g.token, g.grantId);
        assert.equal(a.read_state, "expired");
        assert.equal(a.held_data, "permitted");
        assert.equal(a.erasure, undefined);
      },
      heldDataOpts(),
    );
  });

  it("P6: no processing authority outlasts expires_at [PV]", () => {
    const dir = tempDir("pdpp-held-p6-");
    let t = T0;
    const journalPath = join(dir, "authority.journal");
    const held = HeldDataAuthority.open({ journalPath, now: () => t });
    const leases = TrainingAuthorityStore.open({
      storePath: join(dir, "training.sqlite"),
      journalPath,
      issuer: "https://as.example",
      nodeId: "n1",
      now: () => t,
    });
    const expiresAt = T0 + 15 * MIN;
    held.registerGrant({ grantId: "T", clientId: "app", subjectId: "owner", confidential: false, trainingOnly: true, streams: ["messages"], expiresAtMs: expiresAt });
    leases.createAuthority({ clientId: "app", grantId: "T", subjectId: "owner", trainingExpiresAtMs: expiresAt });
    const lease = leases.issueLease({ grantId: "T", clientId: "app" });
    assert.ok(lease.ok);
    assert.ok(lease.claims.exp * 1000 <= expiresAt, "the lease ends no later than expires_at");
    t = expiresAt;
    const after = leases.issueLease({ grantId: "T", clientId: "app" });
    assert.equal(after.ok, false, "no authority is issued at or after expires_at");
    leases.close();
  });

  it("P6 (variant): the owner elected deletion in advance: the answer becomes erase with effective_at equal to expires_at [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const g = await ordinaryGrantPar(h, { access_mode: "continuous" });
        const expiry = clock.now + DAY;
        await mutateMainDatabase(
          "UPDATE grants SET expires_at = ?, grant_json = json_set(grant_json, '$.expires_at', ?) WHERE grant_id = ?",
          [new Date(expiry).toISOString(), new Date(expiry).toISOString(), g.grantId],
        );
        await mutateMainDatabase("UPDATE tokens SET expires_at = ? WHERE token_id = ?", [new Date(expiry).toISOString(), g.token]);
        const elected = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/elect-delete`, "POST");
        assert.equal(elected.status, 200, JSON.stringify(elected.body));
        const before = await answerOf(h, g.token, g.grantId);
        assert.equal(before.held_data, "permitted", "the election alone prohibits nothing");
        assert.equal(before.read_state, "active");
        clock.now = expiry;
        const a = await answerOf(h, g.token, g.grantId);
        assert.equal(a.read_state, "expired");
        assert.equal(a.held_data, "erase");
        assert.equal(a.erasure.effective_at, new Date(expiry).toISOString());
        assert.equal(a.erasure.effective_at, a.ended_at);
      },
      heldDataOpts(clock),
    );
  });
});

// ---------------------------------------------------------------------------
// P7
// ---------------------------------------------------------------------------

describe("P7. Security revocation", () => {
  async function compromised(h: Harness) {
    const clientId = await registerPublicClient(h);
    const g = await authCodeGrant(h, clientId);
    // The AS ends a grant the owner did not ask to end, because the client is compromised.
    await revokeGrant(g.grantId, { lifecycle: { path: "security_revocation", reason: "client_compromised" } });
    return g;
  }

  it("P7: no erasure instruction exists and the answer is permitted [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await compromised(h);
        const a = await answerOf(h, g.refreshToken, g.grantId);
        assert.equal(a.read_state, "revoked");
        assert.equal(a.held_data, "permitted");
        assert.equal(a.erasure, undefined);
        assert.deepEqual(erasuresOf(await ownerView(h, g.grantId)), []);
      },
      heldDataOpts(),
    );
  });

  it("P7: the owner surface shows the ending and why it happened and offers the disposition until the owner chooses [AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await compromised(h);
        const view = (await ownerView(h, g.grantId)) as { ending: Record<string, any> };
        assert.equal(view.ending.path, "security_revocation", "a security revocation, not the owner's own action");
        assert.equal(view.ending.reason, "client_compromised", "and why");
        assert.ok(view.ending.ended_at, "the ending");
        assert.equal(view.ending.owner_notice_required, true, "the disposition is offered until the owner chooses");
        assert.equal(view.ending.disposition, null, "none is defaulted");
      },
      heldDataOpts(),
    );
  });

  it("P7: choosing delete makes the answer erase [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const g = await compromised(h);
        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        assert.equal((await answerOf(h, g.refreshToken, g.grantId)).held_data, "erase");
        assert.equal(((await ownerView(h, g.grantId)) as { ending: Record<string, any> }).ending.owner_notice_required, false);
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P8
// ---------------------------------------------------------------------------

describe("P8. Refresh replay", () => {
  it("P8: the family's tokens are revoked, the grant does not end, no erasure instruction exists, and the superseded token still authenticates a lifecycle query [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const r1 = await refreshWith(h, clientId, g.refreshToken);
        assert.equal(r1.status, 200);
        assert.equal((await introspect(r1.body.access_token)).active, true);
        assert.equal((await refreshWith(h, clientId, g.refreshToken)).status, 400, "replay of the superseded token");
        assert.equal((await refreshWith(h, clientId, r1.body.refresh_token)).status, 400, "the successor refresh token is revoked");
        assert.equal((await introspect(g.accessToken)).active, false);
        assert.equal((await introspect(r1.body.access_token)).active, false);
        const a = await answerOf(h, g.refreshToken, g.grantId);
        assert.equal(a.read_state, "active", "the grant does not end");
        assert.equal(a.held_data, "permitted");
        assert.deepEqual(erasuresOf(await ownerView(h, g.grantId)), [], "no erasure instruction exists");
        assert.equal(getHeldDataRuntime()?.authority.hasEnded(g.grantId), false);
        const viaSuperseded = await status(h, g.refreshToken, g.grantId);
        assert.equal(viaSuperseded.status, 200, "the superseded token authenticates a lifecycle query");
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// P9
// ---------------------------------------------------------------------------

describe("P9. AS decommission", () => {
  it("P9: the AS first offers a disposition for every grant whose held data may remain, shows each as offered, recorded, sent or receipt reported, and warns about the undelivered delete [AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const offered = await authCodeGrant(h, clientId);
        const recorded = await authCodeGrant(h, clientId); // delete recorded, client has not received it
        const sent = await authCodeGrant(h, clientId); // delete returned in a lifecycle answer
        const reported = await authCodeGrant(h, clientId); // delete returned and receipt reported
        const kept = await authCodeGrant(h, clientId); // ended earlier with keep
        for (const g of [recorded, sent, reported]) {
          assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
        }
        assert.equal((await revoke(h, h.ownerToken, kept.grantId, { pdpp_disposition: "keep" })).status, 200);
        await status(h, sent.refreshToken, sent.grantId);
        const instruction = (await answerOf(h, reported.refreshToken, reported.grantId)).erasure.instruction_id as string;
        const rec = await recoverLifecycle(h, clientId, [reported.grantId]);
        const receipt = await lifecycle(h, {
          grant_id: reported.grantId,
          instruction_id: instruction,
          report: "received",
          reported_at: new Date(Date.now() - 1000).toISOString(),
          token: rec.access_token,
        });
        assert.equal(receipt.status, 200, JSON.stringify(receipt.body));

        const offer = await owner(h, "/v1/owner/lifecycle/decommission");
        assert.equal(offer.status, 200, JSON.stringify(offer.body));
        const grants = offer.body.grants as { grant_id: string; choices: string[]; stage: string; warning?: string; delete_warning: string }[];
        const all = [offered, recorded, sent, reported, kept].map((g) => g.grantId).sort();
        assert.deepEqual(grants.map((g) => g.grant_id).sort(), all, "a disposition is offered for every grant whose held data may remain");
        for (const g of grants) {
          assert.deepEqual(g.choices, ["keep", "delete"]);
        }
        const stage = Object.fromEntries(grants.map((g) => [g.grant_id, g.stage]));
        assert.deepEqual(stage, {
          [offered.grantId]: "offered",
          [recorded.grantId]: "recorded",
          [sent.grantId]: "sent",
          [reported.grantId]: "receipt reported",
          [kept.grantId]: "recorded",
        });
        const warned = grants.filter((g) => g.warning).map((g) => g.grant_id);
        assert.deepEqual(warned, [recorded.grantId], "only the delete no client has received carries the warning");
        assert.match(String(grants.find((g) => g.grant_id === recorded.grantId)?.warning), /Once this server stops answering, the app cannot learn of it/);
        // The offer precedes any retirement: the AS still answers.
        assert.equal((await status(h, offered.refreshToken, offered.grantId)).status, 200);
        assert.equal(getHeldDataRuntime()?.authority.decommissioned, false);
        // Retirement needs a disposition for each offered grant.
        const send = (body: unknown) =>
          fetchJson<Body>(`${h.asUrl}/v1/owner/lifecycle/decommission`, json(body, { Authorization: `Bearer ${h.ownerToken}` }));
        assert.equal((await send({ offer_id: offer.body.offer_id })).status, 400);
        assert.equal((await send({ offer_id: offer.body.offer_id, dispositions: { [offered.grantId]: "keep" } })).status, 400);
        assert.equal(getHeldDataRuntime()?.authority.decommissioned, false, "an incomplete choice retires nothing");
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

describe("D1. Restore safety", () => {
  it("D1: after a restore of a backup taken before the acknowledged instruction, no positive assessment, active introspection or token contradicts it; the lifecycle operation returns temporarily_unavailable [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const rt = getHeldDataRuntime()!;
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await status(h, g.refreshToken, g.grantId)).status, 200);
        const backup = readFileSync(rt.authority.journalPath); // the backup is taken before E
        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, "E is acknowledged");
        writeFileSync(rt.authority.journalPath, backup); // restore
        // The main database comes back from a backup too: grant, tokens and refresh family live.
        await mutateMainDatabase("UPDATE grants SET status = 'active' WHERE grant_id = ?", [g.grantId]);
        await mutateMainDatabase("UPDATE tokens SET revoked = FALSE WHERE grant_id = ?", [g.grantId]);
        await mutateMainDatabase("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?", [g.grantId]);

        const q = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: g.grantId, token: g.refreshToken }));
        assert.equal(q.status, 503, "no stale positive answer");
        assert.equal(((await q.json()) as { error: string }).error, "temporarily_unavailable");
        assert.ok(q.headers.get("retry-after"), "with Retry-After");
        assert.equal((await introspect(g.accessToken)).active, false, "no active introspection result");
        assert.notEqual(await rsRead(h, g.accessToken), 200, "no read");
        const refreshed = await fetchJson(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken }));
        assert.equal(refreshed.status, 400, "no token");
        assert.equal((refreshed.body as Body).access_token, undefined);
      },
      heldDataOpts(),
    );
  });

  /** An authority, its grant G and a replica opened on a copy of the journal. */
  function replicaSetup(expiresAtMs: number | null = null) {
    const dir = tempDir("pdpp-held-d1-");
    let t = T0;
    const journalPath = join(dir, "authority.journal");
    const as = HeldDataAuthority.open({ journalPath, now: () => t, epochMarkerPath: join(dir, "epoch") });
    as.registerGrant({ grantId: "G", clientId: "app", subjectId: "owner", confidential: false, streams: ["messages"], expiresAtMs });
    as.recordCredential({ token: "tok", grantIds: ["G"], kind: "access" });
    return {
      as,
      advance: (ms: number) => (t += ms),
      now: () => t,
      replicaOf: (path: string, head: (() => number | null) | null) =>
        HeldDataAuthority.open({ journalPath: path, now: () => t, ...(head ? { primaryHead: head } : {}) }),
      copy: (name: string) => {
        const to = join(dir, name);
        copyFileSync(journalPath, to);
        return to;
      },
    };
  }
  const ask = (as: HeldDataAuthority) => {
    const p = as.authenticateRead({ token: "tok" });
    return p ? as.status(p, ["G"]) : null;
  };

  it("D1: a stale replica that cannot show it is current returns temporarily_unavailable, never a stale positive answer [PV]", () => {
    const s = replicaSetup();
    const stale = s.copy("replica.journal");
    s.advance(HOUR);
    s.as.requestErasure({ grantId: "G", origin: "owner_withdrawal" });
    const naive = s.replicaOf(stale, () => 0);
    const positive = ask(naive)?.[0] as { ordinary_use?: string };
    assert.equal(positive.ordinary_use, "permitted", "negative control: with the head check disabled the stale view contradicts the instruction");
    const checked = s.replicaOf(stale, () => s.as.position);
    assert.throws(() => ask(checked), AuthorityUnavailableError);
    const cannotReachPrimary = s.replicaOf(stale, () => null);
    assert.throws(() => ask(cannotReachPrimary), AuthorityUnavailableError);
  });

  it("D1: a stale replica MAY return the instruction (a refusal or a negative answer stays true) [PV]", () => {
    const s = replicaSetup();
    s.advance(HOUR);
    s.as.requestErasure({ grantId: "G", origin: "owner_withdrawal" });
    const replicaJournal = s.copy("replica.journal");
    s.as.registerGrant({ grantId: "later", clientId: "app", subjectId: "owner", confidential: false, streams: [], expiresAtMs: null });
    const replica = s.replicaOf(replicaJournal, () => s.as.position);
    const a = ask(replica)?.[0] as { ordinary_use: string; erasures: { operation_id: string }[] };
    assert.equal(a.ordinary_use, "stopped");
    assert.equal(a.erasures.length, 1);
  });

  it("D1 (variant): a stale replica holds an advance election for G; the owner then requests immediate erasure at the authoritative AS; queried after the originally scheduled time the replica returns the authoritative effective instruction or temporarily_unavailable, never the old effective_at or stop_use_by [PV]", () => {
    const scheduled = T0 + DAY;
    const s = replicaSetup(scheduled);
    s.as.electAdvance("G");
    const stale = s.copy("replica.journal"); // holds the election only
    s.advance(HOUR);
    const immediate = s.as.requestErasure({ grantId: "G", origin: "owner_withdrawal" });
    s.advance(DAY * 2); // past the originally scheduled time
    const replica = s.replicaOf(stale, () => s.as.position);
    let a: unknown;
    try {
      a = ask(replica)?.[0];
    } catch (err) {
      assert.ok(err instanceof AuthorityUnavailableError, "temporarily_unavailable");
      return;
    }
    const answer = a as { erasures: { operation_id: string; effective_at?: number }[] };
    for (const e of answer.erasures ?? []) {
      assert.equal(e.operation_id, immediate.operationId);
      assert.equal(e.effective_at, immediate.acceptedAt, "the authoritative effective time");
      assert.notEqual(e.effective_at, scheduled, "never the old effective_at");
    }
  });
});

// ---------------------------------------------------------------------------
// D1a
// ---------------------------------------------------------------------------

describe("D1a. Restore across issuance paths", () => {
  function restoreGrantRows(grantId: string) {
    getDb().prepare("UPDATE grants SET status = 'active', consumed = 0 WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE tokens SET revoked = 0 WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?").run(grantId);
    getDb().prepare("UPDATE grant_package_members SET status = 'active', revoked_at = NULL WHERE grant_id = ?").run(grantId);
  }
  const restoreCode = (code: string, token: string) => {
    getDb().prepare("UPDATE oauth_authorization_codes SET status = 'issued', consumed_at = NULL WHERE code = ?").run(code);
    getDb().prepare("UPDATE tokens SET refresh_family_id = NULL, expires_at = NULL WHERE token_id = ?").run(token);
  };

  /** The AS acknowledges revocation of G, then restores its main store from a backup in which G and its tokens are live. */
  async function revokedThenRestored(h: Harness) {
    const clientId = await registerPublicClient(h);
    const g = await authCodeGrantWithCode(h, clientId);
    const consent = await createConsentExchangeCode({
      grantId: g.grantId,
      token: g.accessToken,
      grant: (await introspect(g.accessToken)).grant as Record<string, unknown>,
      recoveryProof: "proof",
    });
    assert.equal((await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "keep" })).status, 200);
    restoreGrantRows(g.grantId);
    return { clientId, g, consent };
  }

  it("D1a: a refresh exchange fails for G [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, g } = await revokedThenRestored(h);
        const r = await fetchJson<Body>(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken }));
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.access_token, undefined);
        assert.equal(r.body.refresh_token, undefined);
      },
      heldDataOpts(),
    );
  });

  it("D1a: an authorization-code exchange fails for G [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, g } = await revokedThenRestored(h);
        restoreCode(g.code, g.accessToken);
        const r = await fetchJson<Body>(
          `${h.asUrl}/oauth/token`,
          form({ client_id: clientId, code: g.code, code_verifier: g.verifier, grant_type: "authorization_code", redirect_uri: REDIRECT }),
        );
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.access_token, undefined);
      },
      heldDataOpts(),
    );
  });

  it("D1a: a device-code exchange fails for G [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, g } = await revokedThenRestored(h);
        const device = getDb().prepare("SELECT device_code FROM pending_consents WHERE grant_id = ?").get(g.grantId) as { device_code: string };
        assert.ok(device?.device_code, "the restored store holds the approved device row");
        await assert.rejects(() => exchangeGrantScopedDeviceCode({ clientId, deviceCode: device.device_code }));
        await assert.rejects(() => issueToken(g.grantId, "owner_local", clientId, null), "minting a fresh token fails too");
      },
      heldDataOpts(),
    );
  });

  it("D1a: re-delivery of a minted token fails for G [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { consent } = await revokedThenRestored(h);
        const replay = await fetchJson<Body>(`${h.asUrl}/consent/exchange`, json({ code: consent, proof: "proof" }));
        assert.equal(replay.status, 404, JSON.stringify(replay.body));
        assert.equal(replay.body.token, undefined);
      },
      heldDataOpts(),
    );
  });

  it("D1a: a direct package fan-out sub-call fails for G [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const pkg = await packageFlow(h, clientId, [h.connectorId, await secondConnector(h)]);
        const [g, other] = pkg.children as [string, string];
        assert.equal((await revoke(h, h.ownerToken, g, { pdpp_disposition: "keep", pdpp_ending: "one_child_withdrawal" })).status, 200);
        restoreGrantRows(g);
        const members = ((await getGrantPackageAccess(pkg.packageId))?.members as { grant_id: string }[]).map((m) => m.grant_id);
        assert.deepEqual(members, [other], "the fan-out excludes the revoked child");
      },
      heldDataOpts(),
    );
  });

  it("D1a: a lifecycle write authenticated by a token revived solely by the restore fails [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g } = await revokedThenRestored(h);
        const write = await lifecycle(h, { grant_id: g.grantId, pdpp_disposition: "delete", token: g.accessToken });
        assert.equal(write.body.grants[0]?.error, "current_authentication_required");
        const viaRefresh = await lifecycle(h, { grant_id: g.grantId, pdpp_disposition: "delete", token: g.refreshToken });
        assert.equal(viaRefresh.body.grants[0]?.error, "current_authentication_required");
        assert.equal(getHeldDataRuntime()?.authority.ownerView(g.grantId, DAY)?.erasures.length, 0, "no write took effect");
      },
      heldDataOpts(),
    );
  });

  it("D1a: introspection returns no active result for G, and the restore reopens no read [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g } = await revokedThenRestored(h);
        assert.equal((await introspect(g.accessToken)).active, false);
        assert.equal(await rsRead(h, g.accessToken), 403, "no read succeeds: there is no cached introspection result in this fixture");
        assert.equal((await answerOf(h, g.refreshToken, g.grantId)).held_data, "permitted", "the answer still reports the revocation's disposition");
        assert.equal((await answerOf(h, g.refreshToken, g.grantId)).read_state, "revoked");
      },
      heldDataOpts(),
    );
  });

  it("D1a (variant): the RS retains a positive introspection result computed before revocation; a read MAY succeed only within the result's original cache lifetime and applicable read deadline, and the restore does not restart either limit [PV]", { skip: "UNVERIFIED: the RI's resource server keeps no introspection result cache, so the exception cannot be exercised" }, () => {});

  it("D1a (variant): a positive introspection response computed before revocation reaches the RS more than 60 seconds after the RS sent the request and authorizes neither a read nor a signed blob URL [PV]", { skip: "UNVERIFIED: no RS introspection cache, no delayed-response handling and no signed blob URLs exist in the prototype" }, () => {});
});

// ---------------------------------------------------------------------------
// D2
// ---------------------------------------------------------------------------

describe("D2. Lifecycle authentication", () => {
  it("D2: an expired access token for a revoked grant authenticates a query and cannot authenticate a write [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "keep" })).status, 200);
        // The public client holds only an expired access token (its refresh token is not presented).
        await mutateMainDatabase("UPDATE tokens SET expires_at = ? WHERE token_id = ?", ["2000-01-01T00:00:00.000Z", g.accessToken]);
        const q = await status(h, g.accessToken, g.grantId);
        assert.equal(q.status, 200);
        assert.equal(q.body.grants[0]?.read_state, "revoked");
        assert.equal(q.body.grants[0]?.held_data, "permitted");
        const w = await lifecycle(h, { grant_id: g.grantId, pdpp_disposition: "delete", token: g.accessToken });
        assert.deepEqual(w.body.grants[0], { grant_id: g.grantId, error: "current_authentication_required" });
        assert.equal(getHeldDataRuntime()?.authority.ownerView(g.grantId, DAY)?.erasures.length, 0, "nothing was recorded");
        // The same holds for a report on an instruction the owner records later.
        await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        const delivered = await status(h, g.accessToken, g.grantId);
        const instruction = (delivered.body.grants[0]?.erasure as { instruction_id: string }).instruction_id;
        const report = await lifecycle(h, {
          grant_id: g.grantId,
          instruction_id: instruction,
          report: "received",
          reported_at: new Date(Date.now() - 1000).toISOString(),
          token: g.accessToken,
        });
        assert.deepEqual(report.body.grants[0], { grant_id: g.grantId, error: "current_authentication_required" });
      },
      heldDataOpts(),
    );
  });

  it("D2: queries for another client's grant, an unknown grant and an uncovered grant get the same HTTP handling, entry schema and invalid_grant error; only grant_id differs [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const mine = await registerPublicClient(h);
        const theirs = await registerPublicClient(h);
        const own = await authCodeGrant(h, mine);
        const uncovered = await authCodeGrant(h, mine); // same client, but the presented token does not cover it
        const foreign = await authCodeGrant(h, theirs);
        // Control: another client presenting a token for its own grant is answered.
        assert.equal((await answerOf(h, foreign.accessToken, foreign.grantId)).held_data, "permitted");
        const probe = async (grantId: string) => {
          const r = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: grantId, token: own.accessToken }));
          const body = (await r.json()) as { grants: Record<string, unknown>[] };
          return {
            status: r.status,
            headers: ["content-type", "cache-control", "pragma", "retry-after", "www-authenticate"].map((n) => `${n}=${r.headers.get(n)}`),
            body: JSON.stringify(body).replaceAll(grantId, "<GRANT>"),
            entry: body.grants[0],
            grantId,
          };
        };
        const results = [await probe(foreign.grantId), await probe("grt_does_not_exist"), await probe(uncovered.grantId)];
        for (const r of results) {
          assert.equal(r.status, 200);
          assert.deepEqual(r.entry, { grant_id: r.grantId, error: "invalid_grant" }, "the entry carries only the requested grant_id and the error");
        }
        const [first, ...rest] = results;
        for (const r of rest) {
          assert.equal(r.status, first!.status);
          assert.deepEqual(r.headers, first!.headers);
          assert.equal(r.body, first!.body, "the bodies differ only in the echoed grant_id");
        }
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// D3
// ---------------------------------------------------------------------------

describe("D3. Recovery after lifecycle compromise", () => {
  async function compromised(h: Harness) {
    const clientId = await registerPublicClient(h);
    const a = await authCodeGrant(h, clientId);
    const b = await authCodeGrant(h, clientId);
    for (const g of [a, b]) {
      assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
    }
    // The AS disables the client's tokens for lifecycle use.
    for (const g of [a, b]) {
      getHeldDataRuntime()?.authority.disableCredential(g.accessToken);
      getHeldDataRuntime()?.authority.disableCredential(g.refreshToken);
    }
    return { clientId, a, b };
  }

  it("D3: disabled tokens get invalid_token [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { a } = await compromised(h);
        for (const token of [a.accessToken, a.refreshToken]) {
          const r = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: a.grantId, token }));
          assert.equal(r.status, 401);
          assert.equal(((await r.json()) as { error: string }).error, "invalid_token");
        }
      },
      heldDataOpts(),
    );
  });

  it("D3: the recovery token authenticates queries and writes for the approved grants only, introspects active false, is rejected by the RS, and its token response is not a positive assessment [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, a, b } = await compromised(h);
        const { code, verifier } = await approveRecovery(h, clientId, [a.grantId]);
        const tokenResponse = await fetchJson<Body>(`${h.asUrl}/oauth/token`, tokenForm(clientId, code, verifier));
        assert.equal(tokenResponse.status, 200, JSON.stringify(tokenResponse.body));
        const cred = tokenResponse.body.access_token as string;
        for (const positive of ["held_data", "grants", "assessed_at", "read_state"]) {
          assert.equal(Object.hasOwn(tokenResponse.body, positive), false, `the token response carries no ${positive}`);
        }
        assert.equal(tokenResponse.body.refresh_token, undefined);
        assert.deepEqual(
          (tokenResponse.body.authorization_details as { grant_ids: string[] }[])[0]?.grant_ids,
          [a.grantId],
        );
        assert.equal((await introspect(cred)).active, false, "introspects active:false");
        assert.equal(await rsRead(h, cred), 401, "rejected by the RS");
        // Queries and writes for the approved grant.
        const q = await status(h, cred, a.grantId);
        assert.equal(q.body.grants[0]?.held_data, "erase");
        const instruction = (q.body.grants[0]?.erasure as { instruction_id: string }).instruction_id;
        const reportedAt = new Date(Date.now() - 1000).toISOString();
        const wa = await lifecycle(h, { grant_id: a.grantId, instruction_id: instruction, report: "received", reported_at: reportedAt, token: cred });
        assert.equal(wa.body.grants[0]?.held_data, "erase", JSON.stringify(wa.body));
        assert.equal(Object.hasOwn(wa.body.grants[0] ?? {}, "error"), false);
        // Not for any other grant.
        const qb = await status(h, cred, b.grantId);
        assert.deepEqual(qb.body.grants?.[0], { grant_id: b.grantId, error: "invalid_grant" });
        const bInstruction = (erasuresOf(await ownerView(h, b.grantId))[0] as { operation_id: string }).operation_id;
        const wb = await lifecycle(h, { grant_id: b.grantId, instruction_id: bInstruction, report: "received", reported_at: reportedAt, token: cred });
        assert.deepEqual(wb.body.grants?.[0], { grant_id: b.grantId, error: "invalid_grant" });
        assert.equal(erasuresOf(await ownerView(h, b.grantId))[0]!.receipt_at, null, "no receipt was recorded for the unapproved grant");
      },
      heldDataOpts(),
    );
  });

  it("D3: a request that mixes a recovery detail with a data-access detail is rejected with invalid_authorization_details [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, a } = await compromised(h);
        const { challenge } = pkce();
        for (const details of [
          [{ type: LIFECYCLE_TYPE, grant_ids: [a.grantId] }, ordinaryDetail(h.connectorId)],
          [ordinaryDetail(h.connectorId), { type: LIFECYCLE_TYPE, grant_ids: [a.grantId] }],
        ]) {
          const res = await fetch(authorizeUrl(h, clientId, details, challenge), { redirect: "manual" });
          assert.equal(res.status, 400);
          assert.equal(((await res.json()) as { error: string }).error, "invalid_authorization_details");
        }
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// D5
// ---------------------------------------------------------------------------

describe("D5. Reports after revocation", () => {
  /** The owner revokes a public client's grant with delete; the client holds only revoked tokens. */
  async function revokedWithDelete(h: Harness) {
    const clientId = await registerPublicClient(h);
    const g = await authCodeGrant(h, clientId);
    const r1 = await refreshWith(h, clientId, g.refreshToken); // the client's tokens are all revoked below
    assert.equal(r1.status, 200);
    assert.equal((await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: "delete" })).status, 200);
    return { clientId, g, tokens: [g.accessToken, g.refreshToken, r1.body.access_token, r1.body.refresh_token] };
  }

  it("D5: a revoked token authenticates the query that delivers the instruction [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, tokens } = await revokedWithDelete(h);
        for (const token of tokens) {
          const a = await answerOf(h, token, g.grantId);
          assert.equal(a.held_data, "erase");
          assert.ok(a.erasure.instruction_id);
        }
      },
      heldDataOpts(),
    );
  });

  it("D5: a received or completed report with that token gets current_authentication_required [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, tokens } = await revokedWithDelete(h);
        const instruction = (await answerOf(h, g.refreshToken, g.grantId)).erasure.instruction_id as string;
        for (const token of tokens) {
          for (const report of ["received", "completed"]) {
            const r = await lifecycle(h, {
              grant_id: g.grantId,
              instruction_id: instruction,
              report,
              reported_at: new Date(Date.now() - 1000).toISOString(),
              token,
            });
            assert.deepEqual(r.body.grants[0], { grant_id: g.grantId, error: "current_authentication_required" }, `${report}`);
          }
        }
      },
      heldDataOpts(),
    );
  });

  it("D5: the owner sees the stage sent, receipt not reported, and no deletion date [AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g } = await revokedWithDelete(h);
        await status(h, g.refreshToken, g.grantId); // the query that delivers it
        const e = erasuresOf(await ownerView(h, g.grantId))[0]!;
        assert.equal(e.stages.latest, "sent");
        assert.match(e.owner_message, /Sent on .*; no receipt reported\. No deletion date applies yet\./);
        assert.equal(e.receipt_at, null);
        assert.equal(e.delete_by, null);
      },
      heldDataOpts(),
    );
  });

  it("D5: after the owner approves lifecycle recovery, the recovery token authenticates the client's report of its recorded receipt time and completion; the AS then shows the deletion date from that receipt [PV+AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const { clientId, g } = await revokedWithDelete(h);
        const instruction = (await answerOf(h, g.refreshToken, g.grantId)).erasure.instruction_id as string;
        const receivedAt = new Date(Date.now() - 3 * HOUR);
        const completedAt = new Date(Date.now() - HOUR);
        const rec = await recoverLifecycle(h, clientId, [g.grantId]);
        const received = await lifecycle(h, {
          grant_id: g.grantId,
          instruction_id: instruction,
          report: "received",
          reported_at: receivedAt.toISOString(),
          token: rec.access_token,
        });
        assert.equal(received.body.grants[0]?.held_data, "erase", JSON.stringify(received.body));
        let e = erasuresOf(await ownerView(h, g.grantId))[0]!;
        assert.equal(Date.parse(e.receipt_at), receivedAt.getTime(), "the recorded receipt time is kept");
        assert.equal(Date.parse(e.delete_by), receivedAt.getTime() + 30 * DAY, "the deletion date is shown from that receipt");
        const completed = await lifecycle(h, {
          grant_id: g.grantId,
          instruction_id: instruction,
          report: "completed",
          reported_at: completedAt.toISOString(),
          token: rec.access_token,
        });
        assert.equal(completed.status, 200, JSON.stringify(completed.body));
        e = erasuresOf(await ownerView(h, g.grantId))[0]!;
        assert.equal(Date.parse(e.completion.at), completedAt.getTime());
        assert.equal(e.stages.latest, "completed");
      },
      heldDataOpts(),
    );
  });

  it("D5 (variant): the owner chooses delete in the client and conveys it with current client authentication and reported_at: the AS records that time as the client's receipt [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const choice = clock.now - 2 * DAY;
        const w = await lifecycle(h, {
          grant_id: g.grantId,
          pdpp_disposition: "delete",
          reported_at: new Date(choice).toISOString(),
          token: g.accessToken,
        });
        assert.equal(w.status, 200, JSON.stringify(w.body));
        assert.equal(w.body.grants[0]?.held_data, "erase");
        const e = erasuresOf(await ownerView(h, g.grantId))[0]!;
        assert.equal(Date.parse(e.receipt_at), choice);
        assert.equal(Date.parse(e.delete_by), choice + 30 * DAY);
      },
      heldDataOpts(clock),
    );
  });

  it("D5 (variant): without reported_at the AS records no receipt [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const w = await lifecycle(h, { grant_id: g.grantId, pdpp_disposition: "delete", token: g.accessToken });
        assert.equal(w.status, 200, JSON.stringify(w.body));
        assert.equal(w.body.grants[0]?.held_data, "erase");
        const e = erasuresOf(await ownerView(h, g.grantId))[0]!;
        assert.equal(e.receipt_at, null);
        assert.equal(e.delete_by, null);
      },
      heldDataOpts(),
    );
  });
});

// ---------------------------------------------------------------------------
// D4
// ---------------------------------------------------------------------------

describe("D4. History loss", () => {
  const journalOf = (opts: ReturnType<typeof heldDataOpts>) => join(opts.experimentalHeldDataLifecycle.journalDir, "authority.journal");
  const evidenceOf = (opts: ReturnType<typeof heldDataOpts>) => join(opts.experimentalHeldDataLifecycle.markerDir, "held-data-authority-epoch");

  /** A history loss that leaves the loss-detection evidence in place; returns the function that restores the full history. */
  function loseHistory(journalPath: string, loss: "wiped" | "suffix") {
    const rt = getHeldDataRuntime()!;
    rt.authority.registerGrant({ grantId: "loss-witness", clientId: "witness", subjectId: "owner_local", confidential: false, streams: [], expiresAtMs: null });
    const prefix = readFileSync(journalPath, "utf8");
    rt.authority.end({ grantId: "loss-witness", path: "owner_withdrawal", disposition: "keep" });
    const full = readFileSync(journalPath, "utf8");
    if (loss === "wiped") {
      rmSync(journalPath);
    } else {
      writeFileSync(journalPath, prefix);
    }
    assert.equal(rt.authority.lost, true, "the AS treats the history as not current");
    return () => writeFileSync(journalPath, full);
  }

  for (const [loss, label] of [
    ["wiped", "the history store is lost"],
    ["suffix", "the store ends before the latest position the AS recorded"],
  ] as const) {
    describe(`${loss === "wiped" ? "base" : "variant 1"}: ${label}`, () => {
      it(`D4 (${loss}): the AS treats the history as not current, issues nothing and answers 503 temporarily_unavailable with Retry-After; its durability statement matches the failure domains exercised [PV+AO]`, async () => {
        const opts = heldDataOpts();
        await withServer(
          false,
          async (h) => {
            const clientId = await registerPublicClient(h);
            const g = await authCodeGrant(h, clientId);
            assert.equal((await status(h, g.refreshToken, g.grantId)).status, 200);
            loseHistory(journalOf(opts), loss);
            const q = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: g.grantId, token: g.refreshToken }));
            assert.equal(q.status, 503);
            assert.equal(((await q.json()) as { error: string }).error, "temporarily_unavailable");
            assert.ok(q.headers.get("retry-after"), "Retry-After");
            assert.equal((await introspect(g.accessToken)).active, false, "no active introspection result");
            assert.equal(
              (await fetchJson(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken }))).status,
              400,
              "no token",
            );
            assert.equal(getHeldDataRuntime()!.authority.hasEnded(g.grantId), false);
            assert.equal(journalAllowsIssuance(journalOf(opts)), false, "the issuance fence shuts processing authority too");
            const view = await ownerView(h, g.grantId);
            assert.equal(view.history_available, false);
            const detail = view.durability_detail as { mechanism: string; survives: string[]; does_not_survive: string[]; undetected: string[] };
            assert.equal(detail.mechanism, "outside_witness", "the declared mechanism is the one exercised");
            assert.match(detail.survives.join(" "), /restore of the history to an older copy, or its loss, while the loss-detection evidence survives/);
            assert.match(detail.does_not_survive.join(" "), /loss of the disk that holds both the history and its loss-detection evidence: they share one device here/, "the shared failure domain is named, not hidden");
            assert.match(String(view.durability), /Restore mechanism: loss-detection evidence kept outside the history\./);
          },
          opts,
        );
      });

      for (const disposition of ["delete", "keep"] as const) {
        it(`D4 (${loss}): the owner's revocation with ${disposition} while the history is unavailable is accepted and shown as pending, and applied before any answer for G once the history is re-established [PV+AO]`, async () => {
          const opts = heldDataOpts();
          await withServer(
            false,
            async (h) => {
              const clientId = await registerPublicClient(h);
              const g = await authCodeGrant(h, clientId);
              assert.equal((await status(h, g.refreshToken, g.grantId)).status, 200);
              const restore = loseHistory(journalOf(opts), loss);
              const r = await revoke(h, h.ownerToken, g.grantId, { pdpp_disposition: disposition });
              assert.equal(r.status, 200, "the owner's revocation is not rejected");
              assert.equal((r.body.lifecycle as { status: string }).status, "pending");
              const view = await ownerView(h, g.grantId);
              assert.equal((view.pending_actions as unknown[]).length, 1, "shown as pending");
              assert.match(String(view.owner_message), /recorded and pending/);
              assert.match(String(view.owner_message), /no tokens or processing authority and returns no positive assessments/);
              assert.match(String(view.owner_message), /within 60 seconds.*cached introspection result.*original cache lifetime/s);
              assert.equal((await status(h, g.refreshToken, g.grantId)).status, 503, "no answer while the history is unavailable");
              restore();
              getHeldDataRuntime()!.authority.reestablishHistory();
              const a = await answerOf(h, g.refreshToken, g.grantId);
              assert.equal(a.read_state, "revoked", "applied before the first answer");
              assert.equal(a.held_data, disposition === "delete" ? "erase" : "permitted");
              assert.equal(await rsRead(h, g.accessToken), 403);
            },
            opts,
          );
        });
      }
    });
  }

  describe("variant 2: independent evidence", () => {
    it("D4 (variant 2): event-specific evidence for erasure E is durable before E is acknowledged [PV]", async () => {
      const opts = heldDataOpts();
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          await status(h, g.refreshToken, g.grantId);
          const before = readLossEvidence(evidenceOf(opts));
          assert.ok(before, "the evidence exists");
          const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
          assert.equal(erase.status, 200, "E is acknowledged");
          const journal = readFileSync(journalOf(opts), "utf8").split("\n");
          const eraseLine = journal.findIndex((l) => l.includes('"t":"erase"') && l.includes(g.grantId));
          assert.ok(eraseLine >= 0);
          const offsetAfterE = Buffer.byteLength(journal.slice(0, eraseLine + 1).join("\n") + "\n");
          const after = readLossEvidence(evidenceOf(opts));
          assert.equal(after?.epoch, before.epoch, "the history epoch is unchanged");
          assert.ok((after?.bytes ?? 0) >= offsetAfterE, "the independent evidence covers E's entry");
        },
        opts,
      );
    });

    it("D4 (variant 2): the history loses only the suffix containing E while the evidence and epoch survive; every enabled enforcement point detects the gap and fails closed [PV]", async () => {
      const opts = heldDataOpts();
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          await status(h, g.refreshToken, g.grantId);
          const journal = journalOf(opts);
          const beforeE = statSync(journal).size;
          assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
          const evidence = readLossEvidence(evidenceOf(opts));
          assert.ok((evidence?.bytes ?? 0) > beforeE);
          truncateSync(journal, beforeE); // the history loses only the suffix containing E
          assert.equal(readLossEvidence(evidenceOf(opts))?.bytes, evidence?.bytes, "the evidence survives");
          // Lifecycle, introspection, token endpoint and RS read all fail closed.
          const q = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: g.grantId, token: g.refreshToken }));
          assert.equal(q.status, 503);
          assert.ok(q.headers.get("retry-after"));
          assert.equal((await introspect(g.accessToken)).active, false);
          assert.equal((await fetchJson(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken }))).status, 400);
          assert.notEqual(await rsRead(h, g.accessToken), 200);
          // The processing-authority store on the same journal fails closed as well.
          const leases = TrainingAuthorityStore.open({
            storePath: join(tempDir("pdpp-held-d4-leases-"), "training.sqlite"),
            journalPath: journal,
            issuer: "https://as.example",
            nodeId: "n-d4",
            now: () => Date.now(),
          });
          assert.deepEqual(leases.issueLease({ clientId, grantId: "T" }), { ok: false, reason: "unavailable" });
          leases.close();
          assert.equal(journalAllowsIssuance(journal), false);
        },
        opts,
      );
    });

    it("D4 (variant 2): a failure while advancing the evidence prevents acknowledgement of E [PV]", async () => {
      const opts = heldDataOpts();
      await withServer(
        false,
        async (h) => {
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          await status(h, g.refreshToken, g.grantId);
          const blocker = `${evidenceOf(opts)}.tmp`;
          mkdirSync(blocker); // the evidence replacement cannot be written
          const failed = await fetch(`${h.asUrl}/v1/owner/grants/${g.grantId}/lifecycle/erase`, {
            method: "POST",
            headers: { Authorization: `Bearer ${h.ownerToken}`, "Content-Type": "application/json" },
            body: "{}",
          });
          assert.ok(failed.status >= 400, `E is not acknowledged (got ${failed.status})`);
          rmSync(blocker, { recursive: true });
          const retried = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
          assert.equal(retried.status, 200, JSON.stringify(retried.body));
          assert.equal(erasuresOf(retried.body).length, 1, "one instruction, acknowledged after the evidence advanced");
        },
        opts,
      );
    });
  });

  describe("variant 3: one store, a snapshot predating E is restored", () => {
    const singleStoreOpts = () => heldDataOpts(undefined, { restoreMechanism: "invalidate_on_restore" });

    it("D4 (variant 3): the AS detects the possible rollback and fails closed: no positive assessment and no live credential for E's grant [PV]", async () => {
      await withServer(
        false,
        async (h) => {
          const rt = getHeldDataRuntime()!;
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          assert.equal((await status(h, g.refreshToken, g.grantId)).status, 200);
          const snapshot = join(tempDir("pdpp-held-d4-v3-"), "snapshot");
          copyFileSync(rt.authority.journalPath, snapshot);
          assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200, "E is acknowledged");
          HeldDataAuthority.restoreFromSnapshot({ journalPath: rt.authority.journalPath, snapshotPath: snapshot, now: Date.now });
          installHeldDataRuntime({ ...rt, authority: HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now: Date.now }) });
          await mutateMainDatabase("UPDATE grants SET status = 'active' WHERE grant_id = ?", [g.grantId]);
          await mutateMainDatabase("UPDATE tokens SET revoked = FALSE WHERE grant_id = ?", [g.grantId]);
          await mutateMainDatabase("UPDATE oauth_refresh_tokens SET status = 'active', revoked_at = NULL WHERE grant_id = ?", [g.grantId]);
          const q = await fetch(`${h.asUrl}/oauth/grant-lifecycle`, form({ grant_id: g.grantId, token: g.refreshToken }));
          assert.equal(q.status, 503, "no positive assessment");
          assert.ok(q.headers.get("retry-after"));
          assert.equal((await introspect(g.accessToken)).active, false, "no live credential");
          assert.equal((await fetchJson(`${h.asUrl}/oauth/token`, form({ client_id: clientId, grant_type: "refresh_token", refresh_token: g.refreshToken }))).status, 400);
          assert.notEqual(await rsRead(h, g.accessToken), 200);
          const view = await ownerView(h, g.grantId);
          assert.equal(view.history_state, "restored_not_current");
          assert.match(String(view.durability), /invalidation on restore \(one store, no outside witness\)/);
          assert.match(String((view.durability_detail as { does_not_survive: string[] }).does_not_survive.join(" ")), /single store on a single disk and does not claim the record survives that loss/);
        },
        singleStoreOpts(),
      );
    });
  });

  describe("variant 4: a rollback through a path the AS does not declare", () => {
    it("D4 (variant 4): the durability statement names the path as undetected and states that it can revive revoked grants [AO]", async () => {
      await withServer(
        false,
        async (h) => {
          const rt = getHeldDataRuntime()!;
          const clientId = await registerPublicClient(h);
          const g = await authCodeGrant(h, clientId);
          const snapshot = join(tempDir("pdpp-held-d4-v4-"), "snapshot");
          copyFileSync(rt.authority.journalPath, snapshot); // a virtual-machine snapshot
          assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
          const before = await ownerView(h, g.grantId);
          for (const view of [before]) {
            const detail = view.durability_detail as { undetected: string[] };
            assert.match(detail.undetected.join(" "), /virtual-machine snapshot/);
            assert.match(String(view.durability), /A rollback this AS does not detect, such as a revert of a virtual-machine snapshot, can revive revoked grants and lose recorded deletions\./);
          }
          // The revert goes through no declared procedure, so the AS cannot detect it (the statement is the requirement).
          copyFileSync(snapshot, rt.authority.journalPath);
          installHeldDataRuntime({ ...rt, authority: HeldDataAuthority.open({ journalPath: rt.authority.journalPath, now: Date.now }) });
          const after = await ownerView(h, g.grantId);
          assert.equal((after.durability_detail as { mechanism: string }).mechanism, "invalidate_on_restore");
          assert.match((after.durability_detail as { undetected: string[] }).undetected.join(" "), /outside the declared restore procedure/);
          assert.equal(after.history_state, "current", "nothing marks the revert");
        },
        heldDataOpts(undefined, { restoreMechanism: "invalidate_on_restore" }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// C1a
// ---------------------------------------------------------------------------

describe("C1a. Retry after a failed attempt", () => {
  /** A client that holds a copy of g1 after a positive assessment at T0. */
  async function started() {
    const sim = new Sim();
    sim.sync();
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("g1").ok, true);
    return sim;
  }

  /** Step the client in 5-minute ticks to `until`, returning the start time of every status attempt. */
  async function attemptsUntil(sim: Sim, until: number, useWhileFailing?: () => void) {
    const starts: number[] = [];
    while (sim.t < until) {
      sim.t += 5 * MIN;
      const before = sim.statusCalls;
      await sim.client.tick();
      if (sim.statusCalls > before) {
        starts.push(sim.t);
      }
      useWhileFailing?.();
    }
    return starts;
  }

  /**
   * Two 1 h outages 24 h apart, each covering a scheduled attempt: the first covers the attempt due at T0 + 24 h, the
   * second the attempt that falls due 24 h after the first outage's retry succeeds.
   */
  async function twoOutages(sim: Sim, observeUse?: () => void) {
    const windows: [number, number][] = [[T0 + DAY - MIN, T0 + DAY + HOUR]];
    sim.outages = [...windows];
    const starts = await attemptsUntil(sim, T0 + DAY + 3 * HOUR, observeUse);
    const next = sim.client.nextAttemptAt;
    assert.ok(next !== null && next > sim.t, "the retry succeeded and the daily cadence resumed");
    windows.push([next - MIN, next + HOUR]);
    sim.outages = [...windows];
    starts.push(...(await attemptsUntil(sim, next + 4 * HOUR, observeUse)));
    return { starts, windows };
  }

  it("C1a: after each failed attempt the client attempts again within the retry interval until an attempt succeeds [AO]", async () => {
    const sim = await started();
    const { starts, windows } = await twoOutages(sim);
    assert.equal(windows.length, 2);
    assert.ok(windows[1]![0] - windows[0]![1] > 20 * HOUR, "the outages are about 24 h apart");
    for (const [from, to] of windows) {
      const failedAttempt = starts.find((x) => x >= from + MIN && x < to);
      assert.ok(failedAttempt !== undefined, "an attempt fell due inside the outage and failed");
      // Walk the chain: each failed attempt is followed by another within an hour, until one is made when the AS answers.
      let at = failedAttempt;
      for (;;) {
        const next = starts.find((x) => x > at);
        assert.ok(next !== undefined && next - at <= HOUR, `the next attempt starts within the retry interval of ${new Date(at).toISOString()}`);
        if (next >= to) {
          assert.equal(sim.reachable(next), true, "the chain ends in an attempt that reaches an answer");
          break;
        }
        at = next;
      }
    }
  });

  it("C1a: a failed attempt does not stop use the grant's terms permit [AO]", async () => {
    const sim = await started();
    let unusable = 0;
    let checked = 0;
    await twoOutages(sim, () => {
      checked += 1;
      if (!sim.client.canUse("g1").ok) {
        unusable += 1;
      }
    });
    assert.ok(checked > 0);
    assert.equal(unusable, 0);
  });

  it("C1a: the AS admits at least one query per grant per retry interval from each client; other queries MAY receive 429, which counts as a failed attempt [PV]", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const statuses: number[] = [];
        for (let hour = 0; hour < 6; hour += 1) {
          clock.now += HOUR;
          // A burst inside one retry interval: at least one query is admitted, and any other is a 429.
          const burst = await Promise.all(Array.from({ length: 10 }, () => status(h, g.refreshToken, g.grantId)));
          statuses.push(...burst.map((r) => r.status));
          assert.ok(burst.some((r) => r.status === 200), `hour ${hour}: at least one query is admitted`);
          for (const r of burst) {
            assert.ok(r.status === 200 || r.status === 429, `only 200 or 429 (got ${r.status})`);
          }
        }
        assert.ok(statuses.includes(200));
      },
      heldDataOpts(clock),
    );
  });

  it("C1a: HTTP 429 is a failed attempt: use goes on, Retry-After MAY replace the retry interval, and the 24 h reconciliation attempt still binds [AO]", async () => {
    let t = T0;
    const app = new ToyApp();
    let mode: "ok" | "429" = "ok";
    let retryAfterMs = 2 * HOUR;
    const client = new HeldDataClient({
      now: () => t,
      store: app,
      status: async (ids) =>
        mode === "429"
          ? { ok: false as const, reason: "http_429", retryAfterMs }
          : { ok: true as const, results: ids.map((grant_id) => ({ as_position: 1, assessed_at: t, ending: null, erasures: [], expires_at: null, grant_id, grant_state: "active" as const, ordinary_use: "permitted" as const })) },
    });
    app.attach(client);
    app.sync("g", [{ id: "r", stream: "messages", text: "x" }]);
    await client.reconcile();
    mode = "429";
    t += MIN;
    const first = t;
    await client.reconcile();
    assert.equal(client.nextAttemptAt, first + 2 * HOUR, "the server-directed wait replaces the retry interval");
    assert.equal(client.canUse("g").ok, true, "a failed attempt does not stop permitted use");
    retryAfterMs = 48 * HOUR;
    t = first + 2 * HOUR;
    const second = t;
    await client.reconcile();
    assert.equal(client.nextAttemptAt, second + DAY, "the reconciliation interval takes precedence over Retry-After");
    assert.equal(client.canUse("g").ok, true);
  });

  it("C1a (variant: unanswered request): the next attempt starts within the retry interval of the preceding attempt's start, without waiting for that request to finish [AO]", async () => {
    let t = T0;
    const starts: number[] = [];
    const app = new ToyApp();
    const client = new HeldDataClient({
      now: () => t,
      store: app,
      initialize: true,
      status: () => {
        starts.push(t);
        return new Promise(() => {}); // never answered, no Retry-After received
      },
    });
    app.attach(client);
    app.sync("g9", [{ id: "x", stream: "messages", text: "hi" }]);
    client.onTokenResponse({ grantIds: ["g9"], sentAt: t });
    t += DAY;
    void client.tick(); // attempt 1 starts and never returns
    assert.deepEqual(starts, [T0 + DAY]);
    for (const minutes of [10, 30, 59]) {
      t = T0 + DAY + minutes * MIN;
      void client.tick();
    }
    assert.equal(starts.length, 1, "nothing is owed before the retry interval has passed");
    t = T0 + DAY + HOUR;
    void client.tick();
    assert.deepEqual(starts, [T0 + DAY, T0 + DAY + HOUR], "the next attempt starts at the retry interval, the first still unanswered");
    t += HOUR;
    void client.tick();
    assert.equal(starts[2], T0 + DAY + 2 * HOUR);
    assert.equal(client.canUse("g9").ok, true, "an unanswered attempt does not stop permitted use");
  });

  it("C1a (variant: suspension): the client powers off after a failed attempt: it makes no attempts while off, starts a query before any use on resume, and a failed or unanswered query does not stop use the grant's terms permit [AO]", async () => {
    let t = T0;
    const storage = new MemoryClientCheckpointStorage();
    const app = new ToyApp();
    const attempts: number[] = [];
    const failing: StatusTransport = async () => {
      attempts.push(t);
      return { ok: false, reason: "unreachable" };
    };
    const ok: StatusTransport = async (ids) => ({
      ok: true,
      results: ids.map((grant_id) => ({ as_position: 1, assessed_at: t, ending: null, erasures: [], expires_at: null, grant_id, grant_state: "active" as const, ordinary_use: "permitted" as const })),
    });
    const first = new HeldDataClient({ now: () => t, status: ok, store: app, storage, initialize: true });
    app.attach(first);
    app.sync("g", [{ id: "r", stream: "messages", text: "x" }]);
    await first.reconcile();
    t += DAY;
    const running = new HeldDataClient({ now: () => t, status: failing, store: app, storage });
    app.attach(running);
    await running.tick();
    assert.equal(attempts.length, 1, "an attempt was made and failed");
    const offAt = t + 10 * MIN;
    // Powered off: nothing runs. The retry that was owed one hour after the failed attempt falls due while off.
    t = offAt + 6 * HOUR;
    assert.equal(attempts.length, 1, "no attempt while the client is off");
    const resumed = new HeldDataClient({ now: () => t, status: failing, store: app, storage });
    app.attach(resumed);
    assert.deepEqual(resumed.canUse("g"), { ok: false, reason: "reconcile_required" }, "a query must start before any use");
    await resumed.onResume();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1], t, "the query starts on resume, before use");
    assert.equal(resumed.canUse("g").ok, true, "the failed query does not stop use the grant's terms permit");
    // An unanswered query does not stop it either.
    const hung = new HeldDataClient({ now: () => t, status: () => new Promise(() => {}), store: app, storage });
    app.attach(hung);
    t += 2 * HOUR;
    void hung.onResume();
    assert.equal(hung.canUse("g").ok, true);
  });
});

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

describe("C2. Stop-use bound", () => {
  async function started() {
    const sim = new Sim({ policy: { disposeAt: "deadline" } });
    sim.sync();
    await sim.client.reconcile();
    assert.equal(sim.client.canUse("g1").ok, true);
    return sim;
  }
  const receipt = (sim: Sim) => sim.client.grantState("g1")?.erasures.values().next().value;

  it("C2: the client initiates stopping as soon as practicable after authenticated receipt: queued and in-flight work is cancelled at the receipt time on the declared clock, and nothing completes after it [AO]", async () => {
    const sim = new Sim();
    sim.sync();
    await sim.client.reconcile();
    const inFlight = sim.app.enqueue("g1", "hello");
    assert.equal(sim.app.start(inFlight), true);
    const queued = sim.app.enqueue("g1", "hello");
    sim.t += MIN;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    await sim.runUntil(w + 2 * DAY);
    const e = receipt(sim);
    assert.ok(e);
    const q = e.receivedAt;
    assert.ok(q <= w + 48 * HOUR, "receipt within the stop-use bound");
    assert.equal(e.stoppedUseAt, q, "use stopped at the instant of receipt");
    assert.deepEqual(sim.app.observations.filter((o) => o.kind === "cancel").map((o) => o.at), [q, q], "in-flight and queued work cancelled at q");
    assert.equal(sim.app.finish(inFlight), null);
    assert.equal(sim.app.start(queued), false);
    assert.deepEqual(sim.app.observations.filter((o) => o.kind === "complete"), []);
    assert.equal(sim.client.canUse("g1").ok, false);
  });

  it("C2: no queued or in-flight use occurs after the earliest applicable deadline, including w plus the stop-use bound; the test adds no grace period [AO]", async () => {
    const sim = await started(); // deletion is left to its deadline: stopping is enforced at the use gate only
    sim.t += MIN;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    // The AS answers again at w + 46 h, so the client receives at q <= w + 48 h.
    sim.outages = [[w, w + 46 * HOUR]];
    const inFlight = sim.app.enqueue("g1", "hello");
    assert.equal(sim.app.start(inFlight), true);
    const queued = sim.app.enqueue("g1", "hello");
    await sim.runUntil(w + 48 * HOUR, 5 * MIN);
    const e = receipt(sim);
    assert.ok(e, "the client received the instruction");
    assert.ok(e.receivedAt <= w + 48 * HOUR);
    assert.equal(e.stopUseBy, w + 48 * HOUR, "the recorded deadline is w plus the stop-use bound");
    assert.equal(sim.client.canUse("g1").ok, false, "use is refused from q on");
    // Work that reaches the gate at or after q is refused: nothing starts or completes.
    assert.equal(sim.app.finish(inFlight), null, "an in-flight job cannot complete after q");
    assert.equal(sim.app.start(queued), false, "queued work is not dispatched after q");
    assert.deepEqual(sim.app.observations.filter((o) => (o.kind === "complete" || o.kind === "start") && o.at >= e.receivedAt), []);
    const cancels = sim.app.observations.filter((o) => o.kind === "cancel");
    assert.equal(cancels.length, 2);
    // The toy app learns of the stop at its next gate check (HeldStore has no cancel hook); the check happens on the declared clock.
    assert.ok(cancels.every((o) => o.at >= e.receivedAt));
  });

  it("C2: the AS reports stop_use_by as the effective time plus the stop-use bound (48 h) [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
        const a = await answerOf(h, g.refreshToken, g.grantId);
        assert.equal(a.held_data, "erase");
        assert.equal(Date.parse(a.erasure.stop_use_by) - Date.parse(a.erasure.effective_at), 48 * HOUR);
      },
      heldDataOpts(),
    );
  });

  it("C2 (variant: later receipt): the client stops at once on receipt after w plus the stop-use bound [AO]", async () => {
    const sim = new Sim();
    sim.sync();
    await sim.client.reconcile();
    sim.t += MIN;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    sim.outages = [[w, w + 5 * DAY]];
    const job = sim.app.enqueue("g1", "hello");
    await sim.runUntil(w + 10 * DAY, 15 * MIN);
    const e = receipt(sim);
    assert.ok(e);
    assert.ok(e.receivedAt > w + 48 * HOUR);
    assert.equal(e.learnedLate, true);
    assert.equal(e.stoppedUseAt, e.receivedAt, "stopped at once on receipt");
    assert.equal(sim.app.finish(job), null);
    assert.ok(sim.app.observations.some((o) => o.kind === "cancel" && o.at === e.receivedAt));
  });

  it("C2 (variant: AS unreachable from w until after w plus the stop-use bound): the client stops at once on receipt; the test does not require it to stop before receipt [AO]", async () => {
    const sim = await started();
    sim.t += MIN;
    const w = sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" }).acceptedAt;
    sim.outages = [[w, w + 48 * HOUR + HOUR]];
    const job = sim.app.enqueue("g1", "hello");
    // Before receipt the client has not learned of the instruction; whatever it does then is not asserted.
    const { lastUsable } = await sim.runUntil(w + 4 * DAY, 15 * MIN);
    const e = receipt(sim);
    assert.ok(e);
    assert.ok(e.receivedAt > w + 48 * HOUR, "receipt came after the bound");
    assert.ok(lastUsable !== null && lastUsable < e.receivedAt, "use stopped at the instant of receipt, not later");
    assert.equal(sim.app.finish(job), null);
    assert.deepEqual(sim.app.observations.filter((o) => o.kind === "complete" && o.at >= e.receivedAt), []);
  });
});

// ---------------------------------------------------------------------------
// C4
// ---------------------------------------------------------------------------

describe("C4. Deletion bound", () => {
  async function received() {
    const sim = new Sim({ policy: { disposeAt: "deadline" } });
    sim.sync();
    await sim.client.reconcile();
    sim.t += HOUR;
    sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    await sim.client.reconcile();
    const e = sim.client.grantState("g1")?.erasures.values().next().value;
    assert.ok(e);
    return { sim, q: e.receivedAt };
  }

  it("C4: deletion is complete by q plus the deletion bound [AO]", async () => {
    const { sim, q } = await received();
    assert.equal(sim.client.deleteBy("g1"), q + 30 * DAY);
    const gone = await sim.runUntilGone(q + 31 * DAY, HOUR);
    assert.ok(gone !== null && gone <= q + 30 * DAY, `deleted at q + ${gone === null ? "never" : (gone - q) / DAY} d`);
    assert.deepEqual(sim.app.holds("g1"), { records: 0, indexEntries: 0, summary: false });
  });

  it("C4: redelivery the next day does not move the deadline [AO]", async () => {
    const { sim, q } = await received();
    sim.t = q + DAY;
    await sim.client.reconcile(); // the AS delivers the same instruction again
    assert.equal(sim.client.grantState("g1")?.erasures.size, 1, "one instruction");
    assert.equal(sim.client.grantState("g1")?.erasures.values().next().value?.receivedAt, q, "first receipt kept");
    assert.equal(sim.client.deleteBy("g1"), q + 30 * DAY);
  });

  it("C4: if the client sends a received report it gives q; the AS shows no receipt-based deletion date before such a report [PV+AO]", async () => {
    const sim = new Sim({ policy: { disposeAt: "deadline" } });
    sim.sync();
    await sim.client.reconcile();
    sim.t += HOUR;
    sim.as.requestErasure({ grantId: "g1", origin: "owner_withdrawal" });
    // The AS returns the instruction (a delivery) with no receipt reported: no deletion date.
    const principal = sim.as.authenticateRead({ token: sim.tokens.get("g1") ?? null });
    assert.ok(principal);
    sim.as.status(principal, ["g1"]);
    let view = sim.as.ownerView("g1", 30 * DAY)?.erasures[0];
    assert.ok(view?.delivered_at, "sent");
    assert.equal(view?.receipt_at, null);
    assert.equal(view?.delete_by, null, "no receipt-based deletion date before a receipt report");
    // The client's own receipt, then its report.
    sim.t += 3 * HOUR;
    await sim.client.reconcile();
    const q = sim.client.grantState("g1")?.erasures.values().next().value?.receivedAt;
    assert.ok(q !== undefined);
    view = sim.as.ownerView("g1", 30 * DAY)?.erasures[0];
    assert.equal(view?.receipt_at, q, "the report gives q");
    assert.equal(view?.delete_by, q + 30 * DAY);
  });
});

// ---------------------------------------------------------------------------
// C5a
// ---------------------------------------------------------------------------

describe("C5a. Clock discontinuity", () => {
  const permittedAt = (now: () => number): StatusTransport => async (ids) => ({
    ok: true,
    results: ids.map((grant_id) => ({ as_position: 1, assessed_at: now(), ending: null, erasures: [], expires_at: null, grant_id, grant_state: "active" as const, ordinary_use: "permitted" as const })),
  });
  const down: StatusTransport = async () => ({ ok: false, reason: "unreachable" });
  const rec = [{ id: "r1", stream: "messages", text: "hello world" }];

  /** The two states of the case: an instruction already received, or a record whose retention ceiling is pending. */
  const states = {
    "an erasure instruction has been received": async (c: HeldDataClient, app: ToyApp) => {
      app.sync("g", rec);
      await c.reconcile();
      c.ownerDelete("g");
      return { due: () => c.deleteBy("g") as number };
    },
    "a record's retention ceiling is pending": async (c: HeldDataClient, app: ToyApp) => {
      app.sync("g", rec);
      await c.reconcile();
      return { due: () => T0 + 10 * DAY };
    },
  };

  for (const [state, setup] of Object.entries(states)) {
    describe(state, () => {
      const make = (opts: { monotonic?: () => number; storage?: MemoryClientCheckpointStorage } = {}) => {
        const clock = { t: T0 };
        const app = new ToyApp();
        const c = new HeldDataClient({
          now: () => clock.t,
          status: permittedAt(() => clock.t),
          store: app,
          policy: { retentionCeilingMs: 10 * DAY, disposeAt: "deadline" },
          ...(opts.monotonic ? { monotonicMs: opts.monotonic } : {}),
          ...(opts.storage ? { storage: opts.storage, initialize: true } : {}),
        });
        app.attach(c);
        return { clock, app, c };
      };

      it(`C5a (wall clock moves backwards, ${state}): no deadline moves later; use stops and due disposal completes before further use [AO]`, async () => {
        const { clock, app, c } = make();
        const { due } = await setup(c, app);
        const deadline = due();
        clock.t -= 10 * DAY;
        assert.equal(c.canUse("g").ok, false, "use stops until the client can establish elapsed time");
        await c.tick();
        assert.equal(app.holds("g").records, 0, "a deadline it cannot show to lie ahead is due: disposal completes");
        const after = c.deleteBy("g");
        assert.ok(after === null || after <= deadline, "no deadline moved later");
      });

      it(`C5a (wall clock moves backwards, ${state}, with an elapsed-time clock): the client establishes conservative elapsed time and the true deadline holds [AO]`, async () => {
        let mono = 0;
        const { clock, app, c } = make({ monotonic: () => mono });
        const { due } = await setup(c, app);
        const deadline = due();
        const trueNow = (offsetDays: number) => {
          // True time advances by `offsetDays`; the wall clock jumped back ten days.
          mono += offsetDays * DAY;
          clock.t = T0 + offsetDays * DAY - 10 * DAY;
        };
        trueNow(1);
        await c.tick();
        const afterBack = c.deleteBy("g");
        assert.ok(afterBack === null || afterBack <= deadline, "no deadline moved later");
        // True time reaches the deadline while the wall clock still reads ten days earlier.
        trueNow(deadline - T0 >= DAY ? (deadline - T0) / DAY : 1);
        await c.tick();
        assert.equal(app.holds("g").records, 0, "disposal is done by the deadline in true elapsed time");
        assert.equal(c.canUse("g").ok, false);
      });

      it(`C5a (process restarts from older state, ${state}): the first-acquisition and receipt times are kept, no deadline moves later, and due disposal runs before any use [AO]`, async () => {
        const storage = new MemoryClientCheckpointStorage();
        const { clock, app, c } = make({ storage });
        const { due } = await setup(c, app);
        const deadline = due();
        // The process dies and restarts from the older (persisted) state after the deadline has passed.
        clock.t = deadline + 2 * DAY;
        const restarted = new HeldDataClient({ now: () => clock.t, status: down, store: app, storage, policy: { retentionCeilingMs: 10 * DAY } });
        app.attach(restarted);
        assert.equal(restarted.canUse("g").ok, false, "no use before disposal");
        assert.equal(app.holds("g").records, 0, "overdue disposal completed before any use");
        const after = restarted.deleteBy("g");
        assert.ok(after === null || after <= deadline, "the restart did not move the deadline later");
      });

      it(`C5a (elapsed-time clock omits a suspension, ${state}): a deadline that passed during the suspension is treated as due before further use [AO]`, async () => {
        let mono = 0;
        const { clock, app, c } = make({ monotonic: () => mono });
        const { due } = await setup(c, app);
        const deadline = due();
        // The machine is suspended across the deadline: the wall clock jumps, the elapsed-time clock does not.
        clock.t = deadline + DAY;
        mono += HOUR;
        assert.equal(c.canUse("g").ok, false, "no use until the suspension is accounted for");
        await c.tick();
        assert.equal(app.holds("g").records, 0, "due disposal completed");
        const after = c.deleteBy("g");
        assert.ok(after === null || after <= deadline, "no deadline moved later");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// C9
// ---------------------------------------------------------------------------

describe("C9. Legal retention", () => {
  const invoicesSpec = (end: LegalRetentionSpec["end"]): LegalRetentionSpec => ({
    scope: "invoices for 2026",
    basis: "tax record-keeping law",
    end,
    records: [{ id: "inv1", stream: "invoices" }],
    requiredProcessing: ["tax-audit-disclosure"],
  });
  const covered = [
    { id: "r1", stream: "messages", text: "hello world" },
    { id: "inv1", stream: "invoices", text: "invoice for 2026" },
  ];

  /**
   * An erasure instruction over a copy that includes invoices. The client talks to the AS over HTTP: it queries with its
   * (revoked) refresh token and reports with a recovered lifecycle credential.
   */
  async function journey(h: Harness, end: LegalRetentionSpec["end"]) {
    const clock = { t: Date.now() - 5 * 60_000 };
    const clientId = await registerPublicClient(h);
    const g = await authCodeGrant(h, clientId);
    const app = new ToyApp();
    let spec: LegalRetentionSpec | null = invoicesSpec(end);
    const rec = await recoverLifecycle(h, clientId, [g.grantId]);
    const client = new HeldDataClient({
      now: () => clock.t,
      store: app,
      status: httpStatusTransport({ asBaseUrl: h.asUrl, credentialFor: () => g.refreshToken }),
      report: httpReportTransport({ asBaseUrl: h.asUrl, currentTokenFor: () => rec.access_token, now: () => clock.t }),
      legalRetention: () => spec,
    });
    app.attach(client);
    app.sync(g.grantId, covered);
    client.onTokenResponse({ grantIds: [g.grantId], sentAt: clock.t });
    assert.equal(client.canUse(g.grantId).ok, true);
    assert.equal((await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST")).status, 200);
    clock.t += 60_000;
    await client.reconcile();
    await new Promise((r) => setTimeout(r, 50)); // the report is sent after the checkpoint
    const instructionId = [...(client.grantState(g.grantId)?.erasures.keys() ?? [])][0] as string;
    assert.ok(instructionId, "the client holds the instruction");
    return { clock, clientId, g, app, client, rec, instructionId, setSpec: (s: LegalRetentionSpec | null) => (spec = s) };
  }
  const retainedOf = async (h: Harness, grantId: string) => erasuresOf(await ownerView(h, grantId))[0]!;

  it("C9: the client deletes the other covered data by the deletion bound and processes the invoices only as the obligation requires [AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, app, client } = await journey(h, { kind: "event", text: "close of the 2026 tax audit" });
        assert.deepEqual(app.records.get(g.grantId)?.map((r) => r.id), ["inv1"], "only the invoices remain; the other covered data is deleted");
        assert.equal(client.canUse(g.grantId).ok, false, "ordinary use stays refused");
        assert.deepEqual(client.canProcessRetained(g.grantId, "tax-audit-disclosure"), { ok: true });
        assert.deepEqual(client.canProcessRetained(g.grantId, "marketing"), { ok: false, reason: "not_required" });
      },
      heldDataOpts(),
    );
  });

  it("C9: a retained report carries retained_until as event: text, with basis and scope; the AS shows that end as an event, never as completed deletion [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g } = await journey(h, { kind: "event", text: "close of the 2026 tax audit" });
        const e = await retainedOf(h, g.grantId);
        assert.equal(e.retained.length, 1);
        assert.deepEqual(e.retained[0].retained_until, { form: "event", text: "close of the 2026 tax audit" });
        assert.equal(e.retained[0].retention_basis, "tax record-keeping law");
        assert.equal(e.retained[0].retention_scope, "invoices for 2026");
        assert.match(e.retained[0].retained_until_display, /close of the 2026 tax audit/);
        assert.equal(e.completion, null, "never shown as completed deletion");
        assert.notEqual(e.stages.latest, "completed");
      },
      heldDataOpts(),
    );
  });

  it("C9: a later report with a date-time end corrects the earlier one without overwriting it [PV+AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, clock, client, instructionId } = await journey(h, { kind: "event", text: "close of the 2026 tax audit" });
        const end = { kind: "date" as const, at: clock.t + 400 * DAY };
        assert.equal(client.correctLegalRetention(g.grantId, instructionId, { end }), true);
        await new Promise((r) => setTimeout(r, 50));
        const e = await retainedOf(h, g.grantId);
        assert.equal(e.retained.length, 2, "both reports are kept");
        assert.deepEqual(e.retained[0].retained_until, { form: "event", text: "close of the 2026 tax audit" }, "the earlier report is not overwritten");
        assert.deepEqual(e.retained[1].retained_until, { form: "date-time", at: end.at });
        assert.equal(e.completion, null);
      },
      heldDataOpts(),
    );
  });

  it("C9: the AS rejects a retained_until in none of the three forms, and a date-time earlier than reported_at [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, rec, clock } = await journey(h, { kind: "event", text: "audit" });
        const instruction = (await retainedOf(h, g.grantId)).operation_id as string;
        const reportedAt = new Date(clock.t).toISOString();
        const send = (extra: Record<string, string>) =>
          lifecycle(h, { grant_id: g.grantId, instruction_id: instruction, report: "retained", reported_at: reportedAt, token: rec.access_token, ...extra });
        for (const bad of [{}, { retained_until: "" }, { retained_until: "2026-11-02" }, { retained_until: "event:" }, { retained_until: "next spring" }, { retained_until: new Date(clock.t - 60_000).toISOString() }]) {
          const r = await send(bad);
          assert.equal(r.status, 400, JSON.stringify(bad));
          assert.equal((r.body as unknown as { error: string }).error, "invalid_request");
        }
        assert.equal((await retainedOf(h, g.grantId)).retained.length, 1, "no rejected report left a record");
      },
      heldDataOpts(),
    );
  });

  it("C9 (variant): the client reports unknown; the AS shows the end as unknown, not as completed [PV]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g } = await journey(h, { kind: "unknown" });
        const e = await retainedOf(h, g.grantId);
        assert.deepEqual(e.retained[0].retained_until, { form: "unknown" });
        assert.match(e.retained[0].retained_until_display, /unknown/i);
        assert.equal(e.completion, null);
      },
      heldDataOpts(),
    );
  });

  it("C9: when the obligation ends the client deletes the invoices and reports completed [PV+AO]", async () => {
    await withServer(
      false,
      async (h) => {
        const { g, app, client, clock, instructionId } = await journey(h, { kind: "event", text: "close of the 2026 tax audit" });
        clock.t += DAY;
        assert.equal(client.endLegalRetention(g.grantId, instructionId), true);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(app.holds(g.grantId), { records: 0, indexEntries: 0, summary: false }, "the invoices are deleted");
        const e = await retainedOf(h, g.grantId);
        assert.ok(e.completion, "completed is reported");
        assert.equal(e.stages.latest, "completed");
        assert.equal(e.retained.length, 1, "the retained report stays on record");
      },
      heldDataOpts(),
    );
  });
});

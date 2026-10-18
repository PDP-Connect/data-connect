// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-kill tests for the durable auth boundaries.
 *
 * Each test seeds real storage (a SQLite file, or a private Postgres database)
 * with the production lifecycle functions, runs ONE piece of real auth work in
 * a child process (test/fixtures/crash/auth-kill-child.ts), SIGKILLs the child
 * at a named `crashPoint(...)` in server/auth.ts, reopens the same storage in
 * this process, and asserts what a restarted server would see:
 *
 *   - consent approval and package creation are all-or-nothing;
 *   - an authorization code is redeemable at most once, whatever boundary the
 *     killed exchange had reached, and never yields two tokens or two refresh
 *     families;
 *   - a consent-exchange (handoff) code behaves the same way, including the
 *     recovery-proof retry that is allowed to see the SAME token again;
 *   - a revoked package or grant never keeps a live token, member or refresh
 *     token beneath it, whichever statement of the cascade the kill landed on,
 *     and a retry of the revocation converges.
 *
 * Limit: SIGKILL keeps the kernel page cache. These tests prove recovery from
 * a process crash at each boundary. They do not prove fsync or power-loss
 * durability.
 */

import assert from "node:assert/strict";

import {
  approveGrant,
  consumeConsentExchangeCode,
  createConsentExchangeCode,
  createHostedMcpGrantPackage,
  exchangeOAuthAuthorizationCode,
  getGrantPackageAccess,
  introspect,
  issueOAuthAuthorizationCodeForDeviceCode,
  revokeGrantPackage,
} from "../server/auth.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import {
  approveAndStageOAuthRequest,
  approveReviewedConsent,
  count,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  packageCreationArguments,
  rows,
  type StorageSpec,
  seedInstances,
  startReviewedConsent,
} from "./helpers/auth-kill-fixture.ts";
import {
  assertPackageFullyRevoked,
  assertRevokedPackageIsComplete,
  createScenario,
  eventCount,
  killAt,
  killRevocationAt,
  packageLayer,
  packageWithRefreshToken,
} from "./helpers/auth-kill-scenarios.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const ALREADY_USED = /invalid or already used/;

const scenario = createScenario({
  postgres: POSTGRES_URL
    ? (databaseName, run) =>
        withTemporaryPostgresDatabase(
          {
            closeConnections: closePostgresStorage,
            connectionString: POSTGRES_URL,
            databaseName,
          },
          run
        )
    : null,
});

// ─── Consent approval ──────────────────────────────────────────────────────

scenario("consent approval killed before commit leaves nothing, and a retry approves exactly once", async (spec) => {
  const reviewed = await startReviewedConsent(spec);
  const eventsBefore = await eventCount(spec);
  await killAt(spec, "consent-approve:before-commit", "approve-consent", reviewed);

  const [pending] = await rows<{
    grant_id: string | null;
    status: string;
    token_id: string | null;
  }>(spec, "SELECT status, grant_id, token_id FROM pending_consents WHERE device_code = ?", [reviewed.deviceCode]);
  assert.equal(pending?.status, "pending", "the killed approval must leave the consent pending, not 'approving'");
  assert.equal(pending?.grant_id ?? null, null);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM grants"), 0, "no grant row may survive");
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM tokens"), 0, "no token row may survive");
  assert.equal(await eventCount(spec), eventsBefore, "no approval event may survive");

  const approved = await approveGrant(reviewed.deviceCode, "owner_local", {
    approval_review_revision: reviewed.reviewRevision,
  });
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM grants"), 1);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM tokens"), 1);
  assert.equal((await introspect(approved.token)).active, true);
});

scenario("consent approval killed after commit is complete and a retry returns the same result", async (spec) => {
  const reviewed = await startReviewedConsent(spec);
  await killAt(spec, "consent-approve:after-commit", "approve-consent", reviewed);

  const [pending] = await rows<{
    grant_id: string | null;
    status: string;
    token_id: string | null;
  }>(spec, "SELECT status, grant_id, token_id FROM pending_consents WHERE device_code = ?", [reviewed.deviceCode]);
  assert.equal(pending?.status, "approved");
  assert.ok(pending?.grant_id && pending.token_id, "an approved consent carries its grant and token");
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM grants"), 1);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM tokens"), 1);
  assert.equal((await introspect(pending.token_id)).active, true);

  const retried = await approveGrant(reviewed.deviceCode, "owner_local", {
    approval_review_revision: reviewed.reviewRevision,
  });
  assert.equal(retried.token, pending.token_id, "a retry after the kill must return the committed token");
  assert.equal(retried.grant.grant_id, pending.grant_id);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM grants"), 1, "a retry must not mint a second grant");
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM tokens"), 1, "a retry must not mint a second token");
});

scenario("package creation killed before commit leaves no package, grant, member or token", async (spec) => {
  const instanceIds = await seedInstances(spec, "kill_create", 2);
  const input = packageCreationArguments(instanceIds);
  const eventsBefore = await eventCount(spec);
  await killAt(spec, "package-create:before-commit", "create-package", input);

  for (const table of ["grant_packages", "grants", "grant_package_members", "tokens"]) {
    assert.equal(await count(spec, `SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} must stay empty`);
  }
  assert.equal(await eventCount(spec), eventsBefore, "no issuance event may survive");

  const created = await createHostedMcpGrantPackage(input);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM grant_packages"), 1);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM grant_package_members"), 2);
  assert.equal((await introspect(created.token as string)).active, true);
});

// ─── OAuth authorization code: delivery and exchange ───────────────────────

scenario("auth code killed after the code row committed is redeemable exactly once", async (spec) => {
  const staged = await approveAndStageOAuthRequest(spec);
  await killAt(spec, "oauth-code:after-issue", "issue-oauth-code", staged);

  const issued = await rows<{ code: string | null; status: string }>(
    spec,
    "SELECT status, code FROM oauth_authorization_codes WHERE device_code = ?",
    [staged.deviceCode]
  );
  assert.equal(issued.length, 1);
  assert.equal(issued[0]?.status, "issued", "the committed code row must survive the kill");

  // The caller never saw the code. A retry must hand out the SAME code, not a second one.
  const delivery = await issueOAuthAuthorizationCodeForDeviceCode(staged.deviceCode, {
    grantId: staged.grantId,
    token: staged.token,
  });
  assert.equal(delivery?.code, issued[0]?.code, "recovered delivery must return the persisted code");
  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM oauth_authorization_codes WHERE device_code = ?", [staged.deviceCode]),
    1
  );

  const redeem = () =>
    exchangeOAuthAuthorizationCode({
      clientId: OAUTH_CLIENT_ID,
      code: delivery?.code,
      codeVerifier: staged.pkce.verifier,
      redirectUri: OAUTH_REDIRECT_URI,
    });
  const first = await redeem();
  assert.equal(first.access_token, staged.token);
  await assert.rejects(redeem, ALREADY_USED, "a second redemption of the same code must fail");
});

async function issuedCodeFor(spec: StorageSpec) {
  const staged = await approveAndStageOAuthRequest(spec);
  const delivery = await issueOAuthAuthorizationCodeForDeviceCode(staged.deviceCode, {
    grantId: staged.grantId,
    token: staged.token,
  });
  const code = delivery?.code as string;
  const redeemInput = {
    clientId: OAUTH_CLIENT_ID,
    code,
    codeVerifier: staged.pkce.verifier,
    redirectUri: OAUTH_REDIRECT_URI,
  };
  return { code, redeemInput, staged };
}

scenario("token exchange killed inside the consume transaction rolls back and the code redeems once", async (spec) => {
  const { code, redeemInput, staged } = await issuedCodeFor(spec);
  await killAt(spec, "oauth-exchange:after-consume-update", "exchange-oauth-code", redeemInput);

  const [row] = await rows<{ consumed_at: string | null; status: string }>(
    spec,
    "SELECT status, consumed_at FROM oauth_authorization_codes WHERE code = ?",
    [code]
  );
  assert.equal(row?.status, "issued", "an exchange killed before commit must not consume the code");
  assert.equal(row?.consumed_at ?? null, null);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM oauth_refresh_tokens"), 0);

  const response = await exchangeOAuthAuthorizationCode(redeemInput);
  assert.equal(response.access_token, staged.token);
  assert.equal(typeof response.refresh_token, "string", "the retry must deliver the refresh token");
  await assert.rejects(() => exchangeOAuthAuthorizationCode(redeemInput), ALREADY_USED);
  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE grant_id = ?", [staged.grantId]),
    1,
    "one code yields exactly one refresh family"
  );
});

scenario("token exchange killed after the consume commit cannot be redeemed again", async (spec) => {
  const { code, redeemInput, staged } = await issuedCodeFor(spec);
  await killAt(spec, "oauth-exchange:after-consume-commit", "exchange-oauth-code", redeemInput);

  const [row] = await rows<{ consumed_at: string | null; status: string }>(
    spec,
    "SELECT status, consumed_at FROM oauth_authorization_codes WHERE code = ?",
    [code]
  );
  assert.equal(row?.status, "consumed");
  assert.ok(row?.consumed_at);
  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE grant_id = ?", [staged.grantId]),
    1,
    "the consume and the refresh family commit together"
  );
  const [token] = await rows<{ refresh_family_id: string | null }>(
    spec,
    "SELECT refresh_family_id FROM tokens WHERE token_id = ?",
    [staged.token]
  );
  assert.ok(token?.refresh_family_id, "the access token is linked to the refresh family in the same commit");

  // The response was lost with the process. The code must stay spent: zero-then-double is the defect.
  await assert.rejects(() => exchangeOAuthAuthorizationCode(redeemInput), ALREADY_USED);
  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE grant_id = ?", [staged.grantId]),
    1,
    "a rejected second redemption must not mint another refresh family"
  );
});

// ─── Consent exchange (handoff) code ───────────────────────────────────────

scenario("consent code creation killed before commit keeps the previous code redeemable", async (spec) => {
  const approved = await approveReviewedConsent(spec);
  const material = {
    grant: approved.grant,
    grantId: approved.grantId,
    token: approved.token,
  };
  const previousCode = await createConsentExchangeCode(material);
  await killAt(spec, "consent-exchange:before-create-commit", "create-consent-exchange", material);

  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM consent_exchange_codes"),
    1,
    "the killed creation must not leave a second code"
  );
  const redeemed = await consumeConsentExchangeCode(previousCode);
  assert.equal(redeemed.ok, true, "invalidating the old code and inserting the new one are one commit");
  assert.equal(redeemed.token, approved.token);
});

scenario("consent code redemption killed before commit leaves the code redeemable once", async (spec) => {
  const approved = await approveReviewedConsent(spec);
  const code = await createConsentExchangeCode({
    grant: approved.grant,
    grantId: approved.grantId,
    token: approved.token,
  });
  await killAt(spec, "consent-exchange:before-redeem-commit", "consume-consent-exchange", { code });

  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM consent_exchange_codes WHERE redeemed_at IS NOT NULL"),
    0,
    "a redemption killed before commit must not spend the code"
  );
  const first = await consumeConsentExchangeCode(code);
  assert.equal(first.ok, true);
  const second = await consumeConsentExchangeCode(code);
  assert.deepEqual([second.ok, second.reason], [false, "consumed"]);
});

scenario("consent code redemption killed after commit cannot be redeemed again", async (spec) => {
  const approved = await approveReviewedConsent(spec);
  const code = await createConsentExchangeCode({
    grant: approved.grant,
    grantId: approved.grantId,
    token: approved.token,
  });
  const tokensBefore = await count(spec, "SELECT COUNT(*) AS n FROM tokens");
  await killAt(spec, "consent-exchange:after-redeem-commit", "consume-consent-exchange", { code });

  assert.equal(
    await count(spec, "SELECT COUNT(*) AS n FROM consent_exchange_codes WHERE redeemed_at IS NOT NULL"),
    1,
    "the redeem commit must spend the code before the token is returned"
  );
  const again = await consumeConsentExchangeCode(code);
  assert.deepEqual([again.ok, again.reason, again.token], [false, "consumed", undefined]);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM tokens"), tokensBefore, "no new token may appear");
});

scenario("consent code with a recovery proof returns the SAME token after a kill, never a new one", async (spec) => {
  const approved = await approveReviewedConsent(spec);
  const proof = "recovery-proof-for-kill-test";
  const code = await createConsentExchangeCode({
    grant: approved.grant,
    grantId: approved.grantId,
    recoveryProof: proof,
    token: approved.token,
  });
  const tokensBefore = await count(spec, "SELECT COUNT(*) AS n FROM tokens");
  await killAt(spec, "consent-exchange:after-redeem-commit", "consume-consent-exchange", { code, proof });

  const recovered = await consumeConsentExchangeCode(code, proof);
  assert.equal(recovered.ok, true, "the holder of the proof may retry a lost response");
  assert.equal(recovered.token, approved.token, "the retry returns the committed token");
  const stranger = await consumeConsentExchangeCode(code, "some-other-proof");
  assert.deepEqual([stranger.ok, stranger.reason], [false, "consumed"]);
  assert.equal(await count(spec, "SELECT COUNT(*) AS n FROM tokens"), tokensBefore, "no second token for one code");
});

// ─── Revocation: member loop and package mark ─────────────────────────────

for (const [label, point, hit, revokedMembers] of [
  ["after the first member grant was revoked", "package-revoke:after-member-grant-revoked", 1, 1],
  ["between two member revocations", "package-revoke:after-member-grant-revoked", 2, 2],
  ["after every member grant and before the package row", "package-revoke:before-package-mark", 1, 3],
  ["after the package cascade, before the event", "package-revoke:after-package-mark", 1, 3],
] as const) {
  scenario(`package revocation killed ${label} converges and keeps revoked members unreadable`, async (spec) => {
    const pkg = await packageWithRefreshToken(spec);
    await killRevocationAt(spec, pkg, point, hit);

    const layer = await packageLayer(spec, pkg.packageId);
    // A package marked revoked is revoked all the way down, whatever the cut.
    assertRevokedPackageIsComplete(layer, label);
    // Members whose grant was revoked grant nothing, even while the package row is still active.
    const revokedBeforeRetry = Object.values(layer.grantStatusByToken).filter((status) => status === "revoked").length;
    assert.equal(revokedBeforeRetry, revokedMembers, `${label}: member grants revoked at the kill`);
    for (const [token, status] of Object.entries(layer.grantStatusByToken)) {
      if (status === "revoked") {
        assert.equal((await introspect(token)).active, false, `${label}: token of a revoked member grant`);
      }
    }
    if (layer.packageStatus === "active") {
      const access = await getGrantPackageAccess(pkg.packageId);
      const live = (access?.members as unknown[] | undefined)?.length ?? 0;
      assert.equal(live, 3 - revokedMembers, `${label}: only unrevoked members stay readable`);
    }
    // A restart plus a retry of the revocation reaches the full revoked state.
    await revokeGrantPackage(pkg.packageId);
    await assertPackageFullyRevoked(spec, pkg, `${label}, after retry`);
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AS side of the held-data lifecycle against the final v0.1.0 Core text
 * (`ready/v010-held-data`): lifecycle answers and owner statements, the three
 * forms of `retained_until`, day-only `retention.max_duration`, and lifecycle
 * recovery. HTTP against the RI with the flag on. PROTOTYPE.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { introspect } from "../server/auth.ts";
import { getHeldDataRuntime } from "../server/held-data/runtime.ts";
import { getDb } from "../server/db.ts";
import { parseRetainedUntil, parseRfc3339 } from "../server/held-data/wire.ts";
import {
  approveRecovery,
  authorizeUrl,
  LIFECYCLE_TYPE,
  pkce,
  recoverLifecycle,
  tokenForm,
} from "./helpers/held-data-recovery-flow.ts";
import {
  authCodeGrant,
  DAY,
  eraseAndGetInstruction,
  form,
  heldDataOpts,
  lifecycle,
  ordinaryDetail,
  owner,
  registerPublicClient,
  rsRead,
  status,
} from "./helpers/held-data-as-http.ts";
import { fetchJson, par, withServer } from "./helpers/training-lease-harness.ts";

const HOUR = 60 * 60 * 1000;

describe("wire values (Core: Grant lifecycle operation)", () => {
  it("retained_until is exactly a date-time, event: with text, or unknown", () => {
    assert.deepEqual(parseRetainedUntil("unknown"), { form: "unknown" });
    assert.deepEqual(parseRetainedUntil("event:close of the 2026 tax audit"), { form: "event", text: "close of the 2026 tax audit" });
    assert.deepEqual(parseRetainedUntil("2026-12-31T23:59:60Z"), { form: "date-time", at: Date.UTC(2027, 0, 1) });
    assert.deepEqual(parseRetainedUntil("2026-11-02T08:00:03+02:00"), { form: "date-time", at: Date.UTC(2026, 10, 2, 6, 0, 3) });
    for (const bad of ["2026-11-02", "event:", "event:   ", "Unknown", "soon", "", "2026-02-30T00:00:00Z", "2026-11-02T08:00:03", 5, null]) {
      assert.equal(parseRetainedUntil(bad), null, `${JSON.stringify(bad)} is in none of the three forms`);
    }
  });

  it("reported_at is an RFC 3339 date-time, never a bare date or a loose string", () => {
    assert.equal(parseRfc3339("2026-11-02T08:00:03Z"), Date.UTC(2026, 10, 2, 8, 0, 3));
    assert.equal(parseRfc3339("2026-11-02t08:00:03.250z"), Date.UTC(2026, 10, 2, 8, 0, 3, 250));
    for (const bad of ["2026-11-02", "Nov 2 2026", "2026-13-01T00:00:00Z", "2026-11-02T25:00:00Z", "2026-11-02T08:00:03+24:00"]) {
      assert.equal(parseRfc3339(bad), null, bad);
    }
  });
});

describe("lifecycle answers and owner statements", () => {
  it("stop_use_by is the effective time plus 48 hours; no pause, no long-stop, no maximum delivery delay promised", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId, { retention: { max_duration: "P90D", on_expiry: "delete" } });
        const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        assert.equal(erase.status, 200, JSON.stringify(erase.body));
        const answer = (await status(h, g.refreshToken, g.grantId)).body.grants[0] as {
          erasure: { effective_at: string; stop_use_by: string };
        };
        assert.equal(Date.parse(answer.erasure.stop_use_by) - Date.parse(answer.erasure.effective_at), 2 * DAY);
        const record = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
        const e = (record.body.erasures as Record<string, unknown>[])[0] as Record<string, unknown>;
        for (const removed of ["use_stops_by", "deleted_by_without_receipt"]) {
          assert.equal(Object.hasOwn(e, removed), false, `${removed} came from the removed pause / long-stop`);
        }
        assert.equal(e.stop_use_by, answer.erasure.stop_use_by);
        const text = (e.statements as string[]).join("\n");
        assert.match(text, /stop using covered data as soon as practicable after it receives this request/);
        assert.match(text, new RegExp(`by ${answer.erasure.stop_use_by} if it receives it by then, and at once if it receives it later`));
        assert.match(text, /within 30 days of receiving the request/);
        assert.match(text, /a try is not a received request/);
        assert.match(text, /An app that is not running does not check/);
        assert.match(text, /there is no maximum delay/);
        assert.match(text, /never answers again[^.]*until each record's retention ceiling \(.*plus P90D\)/);
        assert.match(text, /deleting inside it binds the app at once/);
        assert.match(text, /not proof of remote deletion/);
        assert.doesNotMatch(text, /pause|long-stop|long stop/i);
      },
      heldDataOpts(clock),
    );
  });

  it("with no retention limit, the statement says the app may keep using the data with no time limit", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
        const record = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
        const text = ((record.body.erasures as { statements: string[] }[])[0] as { statements: string[] }).statements.join("\n");
        assert.match(text, /no time limit, because the grant states no retention limit/);
      },
      heldDataOpts(),
    );
  });

  it("shows requested, sent, receipt reported, completion; a deletion date only from a reported receipt", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const instruction = await (async () => {
          const erase = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle/erase`, "POST");
          assert.equal(erase.status, 200);
          return (erase.body.erasures as { operation_id: string }[])[0]!.operation_id;
        })();
        const view = async () => {
          const r = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
          return (r.body.erasures as Record<string, any>[])[0]!;
        };
        let e = await view();
        assert.equal(e.stages.latest, "requested");
        assert.equal(e.delete_by, null);
        assert.match(e.owner_message, /Requested on .*; not yet sent\. No deletion date applies yet\./);
        // The first lifecycle answer that carries the instruction is "sent".
        await status(h, g.refreshToken, g.grantId);
        e = await view();
        assert.equal(e.stages.latest, "sent");
        assert.equal(e.delete_by, null, "acceptance and first return start no deletion clock");
        assert.match(e.owner_message, /Sent on .*; no receipt reported\. No deletion date applies yet\./);
        const rec = await recoverLifecycle(h, clientId, [g.grantId]);
        const receivedAt = new Date(Date.now() - 60_000).toISOString();
        const write = (extra: Record<string, string>) =>
          lifecycle(h, { grant_id: g.grantId, instruction_id: instruction, token: rec.access_token, ...extra });
        assert.equal((await write({ report: "received", reported_at: receivedAt })).status, 200);
        e = await view();
        assert.equal(e.stages.latest, "receipt_reported");
        assert.equal(Date.parse(e.delete_by) - Date.parse(receivedAt), 30 * DAY, "the date is measured from the reported receipt");
        assert.match(e.owner_message, /Receipt reported on .*Deletion is due by /);
        assert.equal((await write({ report: "completed", reported_at: new Date(Date.now() - 1000).toISOString() })).status, 200);
        e = await view();
        assert.equal(e.stages.latest, "completed");
        assert.match(e.owner_message, /Completion reported on /);
      },
      heldDataOpts(),
    );
  });
});

describe("report=retained", () => {
  it("accepts the three forms, rejects the rest, keeps every report with its receipt time, and never shows retained as completed", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const instruction = await eraseAndGetInstruction(h, g.grantId, g.refreshToken);
        const rec = await recoverLifecycle(h, clientId, [g.grantId]);
        const reportedAt = new Date(clock.now - 60_000).toISOString();
        const retained = (extra: Record<string, string>) =>
          lifecycle(h, {
            grant_id: g.grantId,
            instruction_id: instruction,
            report: "retained",
            reported_at: reportedAt,
            token: rec.access_token,
            ...extra,
          });
        // Rejected with 400 invalid_request.
        const earlier = new Date(clock.now - 120_000).toISOString();
        for (const bad of [
          {},
          { retained_until: "" },
          { retained_until: "2026-11-02" },
          { retained_until: "event:" },
          { retained_until: "event:   " },
          { retained_until: "UNKNOWN" },
          { retained_until: "next spring" },
          { retained_until: earlier },
          { retained_until: "unknown", retention_basis: "" },
          { retained_until: "unknown", reported_at: new Date(clock.now + DAY).toISOString() },
        ]) {
          const r = await retained(bad);
          assert.equal(r.status, 400, JSON.stringify(bad));
          assert.equal((r.body as unknown as { error: string }).error, "invalid_request");
        }
        const view = async () => {
          const r = await owner(h, `/v1/owner/grants/${g.grantId}/lifecycle`);
          return (r.body.erasures as Record<string, any>[])[0]!;
        };
        assert.equal((await view()).retained.length, 0, "no rejected request left a record");

        const first = await retained({
          retained_until: "event:close of the 2026 tax audit",
          retention_basis: "tax record-keeping law",
          retention_scope: "invoices for 2026",
        });
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.grants[0]?.held_data, "erase", "the entry returned is the lifecycle answer after the write");
        clock.now += 1000;
        let e = await view();
        assert.equal(e.retained.length, 1);
        assert.deepEqual(e.retained[0].retained_until, { form: "event", text: "close of the 2026 tax audit" });
        assert.match(e.retained[0].retained_until_display, /event or condition: close of the 2026 tax audit/);
        assert.equal(e.retained[0].retention_basis, "tax record-keeping law");
        assert.equal(e.retained[0].retention_scope, "invoices for 2026");
        assert.ok(Date.parse(e.retained[0].received_at) > 0, "kept with the time the AS received it");
        assert.equal(e.completion, null, "a retained report is not completed deletion");
        assert.equal(e.stages.latest, "exception_reported");
        assert.match(e.owner_message, /except data the law requires it to keep.*ends at an event or condition: close of the 2026 tax audit.*not reported as deleted/);
        assert.doesNotMatch(e.owner_message, /Completion reported/);

        // An identical repeat changes nothing; a different one corrects without overwriting.
        await retained({
          retained_until: "event:close of the 2026 tax audit",
          retention_basis: "tax record-keeping law",
          retention_scope: "invoices for 2026",
        });
        assert.equal((await view()).retained.length, 1);
        const later = new Date(clock.now + 30 * DAY).toISOString();
        assert.equal((await retained({ retained_until: later })).status, 200);
        assert.equal((await retained({ retained_until: "unknown" })).status, 200);
        e = await view();
        assert.equal(e.retained.length, 3);
        assert.equal(e.retained[0].retained_until.form, "event", "the earlier report is kept, not overwritten");
        assert.deepEqual(e.retained[1].retained_until, { form: "date-time", at: Date.parse(later) });
        assert.deepEqual(e.retained[2].retained_until, { form: "unknown" });
        assert.match(e.retained[2].retained_until_display, /end unknown/);
        assert.equal(e.completion, null);

        // When the obligation ends the client reports completed.
        const done = await lifecycle(h, {
          grant_id: g.grantId,
          instruction_id: instruction,
          report: "completed",
          reported_at: new Date(clock.now - 1000).toISOString(),
          token: rec.access_token,
        });
        assert.equal(done.status, 200);
        e = await view();
        assert.ok(e.completion);
        assert.equal(e.retained.length, 3);
      },
      heldDataOpts(clock),
    );
  });

  it("a report with an unknown instruction or without current authentication is refused, not recorded", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const instruction = await eraseAndGetInstruction(h, g.grantId, g.refreshToken);
        const rec = await recoverLifecycle(h, clientId, [g.grantId]);
        const base = { grant_id: g.grantId, report: "retained", retained_until: "unknown", reported_at: new Date(Date.now() - 1000).toISOString() };
        const wrong = await lifecycle(h, { ...base, instruction_id: "nope", token: rec.access_token });
        assert.equal(wrong.body.grants[0]?.error, "invalid_instruction");
        const stale = await lifecycle(h, { ...base, instruction_id: instruction, token: g.refreshToken });
        assert.equal(stale.body.grants[0]?.error, "current_authentication_required", "a revoked token authenticates no write");
      },
      heldDataOpts(),
    );
  });
});

describe("retention.max_duration is PnD (Core: Retention)", () => {
  const retention = (max_duration: string) => ({ retention: { max_duration, on_expiry: "delete" } });

  it("flag on: PnD is accepted; months, years, weeks, time parts, zero days, and non-durations are invalid_authorization_details", async () => {
    await withServer(
      false,
      async (h) => {
        const ok = await par(h.asUrl, ordinaryDetail(h.connectorId, retention("P90D")));
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        for (const bad of ["P3M", "P1Y", "P2W", "PT36H", "P1DT1H", "P0D", "P1.5D", "p90d", "90D", "P-1D", "P1Y2M3D"]) {
          const r = await par(h.asUrl, ordinaryDetail(h.connectorId, retention(bad)));
          assert.equal(r.status, 400, `${bad}: ${JSON.stringify(r.body)}`);
          assert.equal(r.errorCode, "invalid_authorization_details", bad);
        }
      },
      heldDataOpts(),
    );
  });

  it("flag on: the authorization endpoint rejects it the same way", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const { challenge } = pkce();
        const detail = [ordinaryDetail(h.connectorId, retention("P3M"))];
        const res = await fetch(authorizeUrl(h, clientId, detail, challenge), { redirect: "manual" });
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { error: string }).error, "invalid_authorization_details");
      },
      heldDataOpts(),
    );
  });

  it("flag off: the RI still takes any non-empty string (unchanged behaviour; recorded as a spec finding)", async () => {
    await withServer(false, async (h) => {
      for (const form_ of ["P3M", "P1Y", "PT36H"]) {
        const r = await par(h.asUrl, ordinaryDetail(h.connectorId, retention(form_)));
        assert.equal(r.status, 201, `${form_}: ${JSON.stringify(r.body)}`);
      }
    });
  });
});

describe("lifecycle recovery (Core: Lifecycle recovery)", () => {
  const metadata = (h: { asUrl: string }) =>
    fetchJson<{ pdpp_authorization_details_types_supported?: string[] }>(`${h.asUrl}/.well-known/oauth-authorization-server`);

  it("is advertised with the flag on and absent with it off", async () => {
    await withServer(
      false,
      async (h) => {
        assert.deepEqual((await metadata(h)).body.pdpp_authorization_details_types_supported, [
          "https://pdpp.dev/data-access",
          LIFECYCLE_TYPE,
        ]);
      },
      heldDataOpts(),
    );
    await withServer(false, async (h) => {
      assert.deepEqual((await metadata(h)).body.pdpp_authorization_details_types_supported, ["https://pdpp.dev/data-access"]);
    });
  });

  it("flag off: a lifecycle element is not recovery and starts no review", async () => {
    await withServer(false, async (h) => {
      const clientId = await registerPublicClient(h);
      const res = await fetch(authorizeUrl(h, clientId, [{ type: LIFECYCLE_TYPE, grant_ids: ["g"] }], pkce().challenge), {
        redirect: "manual",
      });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    });
  });

  it("rejects a malformed or mixed request with invalid_authorization_details, and names no failing grant", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const other = await registerPublicClient(h);
        const mine = await authCodeGrant(h, clientId);
        const theirs = await authCodeGrant(h, other);
        const { challenge } = pkce();
        const attempt = async (details: unknown) => {
          const res = await fetch(authorizeUrl(h, clientId, details, challenge), { redirect: "manual" });
          return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null };
        };
        const malformed: unknown[] = [
          [{ type: LIFECYCLE_TYPE }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [] }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [mine.grantId, mine.grantId] }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [""] }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [7] }],
          [{ type: LIFECYCLE_TYPE, grant_ids: mine.grantId }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [mine.grantId], locations: ["x"] }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [mine.grantId] }, { type: LIFECYCLE_TYPE, grant_ids: [mine.grantId] }],
          [{ type: LIFECYCLE_TYPE, grant_ids: [mine.grantId] }, ordinaryDetail(h.connectorId)],
          [ordinaryDetail(h.connectorId), { type: LIFECYCLE_TYPE, grant_ids: [mine.grantId] }],
        ];
        for (const details of malformed) {
          const r = await attempt(details);
          assert.equal(r.status, 400, JSON.stringify(details));
          assert.equal(r.body?.error, "invalid_authorization_details", JSON.stringify(details));
        }
        // Unknown, another client's, and one good plus one bad grant all fail identically.
        const unknown = await attempt([{ type: LIFECYCLE_TYPE, grant_ids: ["grt_unknown"] }]);
        const foreign = await attempt([{ type: LIFECYCLE_TYPE, grant_ids: [theirs.grantId] }]);
        const partial = await attempt([{ type: LIFECYCLE_TYPE, grant_ids: [mine.grantId, theirs.grantId] }]);
        for (const r of [unknown, foreign, partial]) {
          assert.equal(r.status, 400);
          assert.equal(r.body?.error, "invalid_authorization_details");
        }
        assert.equal(unknown.body?.error_description, foreign.body?.error_description);
        assert.equal(unknown.body?.error_description, partial.body?.error_description);
        for (const r of [unknown, foreign, partial]) {
          assert.doesNotMatch(JSON.stringify(r.body), new RegExp(`${theirs.grantId}|${mine.grantId}|grt_unknown`));
        }
      },
      heldDataOpts(),
    );
  });

  it("shows client, source, purpose and issue date; the token covers exactly the approved grants, with no refresh token, inactive at introspection, rejected by the RS, and no positive assessment", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const a = await authCodeGrant(h, clientId);
        const b = await authCodeGrant(h, clientId);
        await owner(h, `/v1/owner/grants/${a.grantId}/lifecycle/erase`, "POST");
        const grantCount = () => (getDb().prepare("SELECT COUNT(*) AS n FROM grants").get() as { n: number }).n;
        const grantsBefore = grantCount();
        const registeredBefore = getHeldDataRuntime()?.authority.grantsOfClient(clientId).length;
        const flow = await approveRecovery(h, clientId, [a.grantId], undefined);
        const review = flow.review as {
          client: { client_id: string };
          grants: { grant_id: string; source: string; purpose: string; issued_at: string }[];
          statement: string;
        };
        assert.equal(review.client.client_id, clientId);
        assert.equal(review.grants.length, 1, "an ended grant can be named");
        assert.equal(review.grants[0]?.grant_id, a.grantId);
        assert.match(review.grants[0]?.source ?? "", /spotify/);
        assert.ok(review.grants[0]?.purpose);
        assert.ok(Date.parse(review.grants[0]?.issued_at ?? "") > 0);
        assert.match(review.statement, /lifecycle queries, report receipt and completion of erasure, and convey erasure requests/);
        assert.match(review.statement, /no read access and no processing authority/);

        const token = await fetchJson<Record<string, any>>(`${h.asUrl}/oauth/token`, tokenForm(clientId, flow.code, flow.verifier));
        assert.equal(token.status, 200, JSON.stringify(token.body));
        assert.equal(Object.hasOwn(token.body, "refresh_token"), false, "no refresh token");
        assert.deepEqual(token.body.authorization_details, [{ type: LIFECYCLE_TYPE, grant_ids: [a.grantId] }], "the approved element is echoed");
        assert.deepEqual(
          Object.keys(token.body).sort(),
          ["access_token", "authorization_details", "expires_in", "token_type"],
          "no grant, no lifecycle answer: the response is not a positive assessment",
        );
        const access = token.body.access_token as string;
        assert.equal((await introspect(access)).active, false);
        assert.equal(await rsRead(h, access), 401, "the RS rejects it");
        assert.equal(grantCount(), grantsBefore, "recovery created no data grant");
        assert.equal(getHeldDataRuntime()?.authority.grantsOfClient(clientId).length, registeredBefore);
        // The ended grant's old tokens still read nothing.
        assert.equal(await rsRead(h, a.accessToken), 403);

        // Queries cover the approved grant only.
        const qa = await status(h, access, a.grantId);
        assert.equal(qa.body.grants[0]?.held_data, "erase");
        const qb = await status(h, access, b.grantId);
        assert.equal(qb.body.grants[0]?.error, "invalid_grant", "B was not approved");

        // The approval, with the exact set and what the owner was shown, is retained evidence.
        const journal = readFileSync(getHeldDataRuntime()!.authority.journalPath, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, any>);
        const evidence = journal.filter((e) => e.t === "hd_recovery_approval");
        assert.equal(evidence.length, 1);
        assert.equal(evidence[0]!.client_id, clientId);
        assert.deepEqual(evidence[0]!.grant_ids, [a.grantId]);
        assert.equal(evidence[0]!.shown[0].grant_id, a.grantId);
        assert.match(evidence[0]!.shown[0].source, /spotify/);
        void clock;
      },
      heldDataOpts(clock),
    );
  });

  it("authenticates writes while unexpired and not disabled; an expired or disabled token authenticates none", async () => {
    const clock = { now: Date.now() };
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const instruction = await eraseAndGetInstruction(h, g.grantId, g.refreshToken);
        const rec = await recoverLifecycle(h, clientId, [g.grantId]);
        const write = (token: string, report: string) =>
          lifecycle(h, {
            grant_id: g.grantId,
            instruction_id: instruction,
            report,
            reported_at: new Date(clock.now - 1000).toISOString(),
            token,
          });
        assert.equal((await write(rec.access_token, "received")).body.grants[0]?.held_data, "erase");
        clock.now += 2 * HOUR; // the recovery token lives one hour here
        assert.equal(
          (await write(rec.access_token, "completed")).body.grants[0]?.error,
          "current_authentication_required",
          "expired",
        );
        assert.equal((await status(h, rec.access_token, g.grantId)).status, 200, "an expired token still reads lifecycle");
        const second = await recoverLifecycle(h, clientId, [g.grantId]);
        getHeldDataRuntime()?.authority.disableCredential(second.access_token);
        assert.equal((await write(second.access_token, "completed")).status, 401, "disabled");
        assert.equal((await status(h, second.access_token, g.grantId)).status, 401);
      },
      heldDataOpts(clock, { recoveryTokenTtlMs: HOUR }),
    );
  });

  it("the code is single use and bound to client, redirect URI and PKCE; a denial returns access_denied", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const flow = await approveRecovery(h, clientId, [g.grantId]);
        const wrongVerifier = await fetchJson(`${h.asUrl}/oauth/token`, tokenForm(clientId, flow.code, "x".repeat(43)));
        assert.equal(wrongVerifier.status, 400);
        const reuse = await fetchJson(`${h.asUrl}/oauth/token`, tokenForm(clientId, flow.code, flow.verifier));
        assert.equal(reuse.status, 400, "a presented code is spent whatever happened");
        const second = await approveRecovery(h, clientId, [g.grantId]);
        const otherClient = await registerPublicClient(h);
        const wrongClient = await fetchJson(`${h.asUrl}/oauth/token`, tokenForm(otherClient, second.code, second.verifier));
        assert.equal(wrongClient.status, 400);

        const { challenge } = pkce();
        const a = await fetch(authorizeUrl(h, clientId, [{ type: LIFECYCLE_TYPE, grant_ids: [g.grantId] }], challenge), { redirect: "manual" });
        const reviewUrl = new URL(a.headers.get("location") as string, h.asUrl).toString();
        const auth = { headers: { Authorization: `Bearer ${h.ownerToken}`, "Content-Type": "application/json" }, method: "POST", body: "{}" };
        const denied = await fetchJson<{ redirect_url: string }>(`${reviewUrl}/deny`, auth);
        assert.equal(denied.status, 200);
        assert.equal(new URL(denied.body.redirect_url).searchParams.get("error"), "access_denied");
        assert.equal((await fetchJson(`${reviewUrl}/approve`, auth)).status, 404, "a settled request cannot be approved");
      },
      heldDataOpts(),
    );
  });

  it("an unauthenticated caller cannot review or approve", async () => {
    await withServer(
      false,
      async (h) => {
        const clientId = await registerPublicClient(h);
        const g = await authCodeGrant(h, clientId);
        const a = await fetch(authorizeUrl(h, clientId, [{ type: LIFECYCLE_TYPE, grant_ids: [g.grantId] }], pkce().challenge), { redirect: "manual" });
        const reviewUrl = new URL(a.headers.get("location") as string, h.asUrl).toString();
        assert.equal((await fetch(reviewUrl)).status, 401);
        assert.equal((await fetch(`${reviewUrl}/approve`, form({}))).status, 401);
      },
      heldDataOpts(),
    );
  });
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { noStoredCredentialReason, resolveAuth, resolveLoginCredentials } from "./auth.ts";
import type { InteractionRequest, InteractionResponse } from "./connector-runtime-protocol.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("env auth alias arrays return the primary credential name", async () => {
  delete process.env.YNAB_PERSONAL_ACCESS_TOKEN;
  process.env.YNAB_PAT = "pat-from-docs";

  const credentials = await resolveAuth(
    { kind: "env", required: [["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"]] },
    {
      connectorName: "ynab",
      sendInteraction: (_req: InteractionRequest): Promise<InteractionResponse> =>
        Promise.reject(new Error("unexpected interaction")),
    }
  );

  assert.deepEqual(credentials, {
    YNAB_PERSONAL_ACCESS_TOKEN: "pat-from-docs",
  });
});

/**
 * `authOptional` — a session-first browser connector must never ASK for a
 * credential it does not need.
 *
 * The `env` strategy had exactly one early return ("everything was filled from
 * the env"). Every other case sent a `credentials` INTERACTION unconditionally
 * and awaited it for up to 1800s. For a connector whose real authenticator is
 * the owner's browser profile that is the wrong question, and it has bitten
 * production twice:
 *
 *   - a SCHEDULED run has nobody to answer, so the prompt timed out and the
 *     run died before the browser ever opened;
 *   - a REPAIR run (live prod run_1788004675387) leased and readied a browser
 *     surface and then showed the owner a username/password form — which a
 *     Google-SSO account cannot answer, blocking the intended journey of
 *     finishing the login inside that streamed browser.
 *
 * These assert on the sendInteraction SPY, not merely on the return value: an
 * empty credential set is reachable both by suppressing the prompt and by
 * recovering from its failure afterwards, and only the call count tells the
 * two apart.
 */

/** Records every interaction a strategy attempts; answers nothing. */
function interactionSpy(): {
  calls: InteractionRequest[];
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
} {
  const calls: InteractionRequest[] = [];
  return {
    calls,
    sendInteraction: (req: InteractionRequest): Promise<InteractionResponse> => {
      calls.push(req);
      // A scheduled run's real shape: the interaction comes back unanswered.
      return Promise.resolve({
        request_id: req.request_id ?? "req_test",
        status: "cancelled",
        type: "INTERACTION_RESPONSE",
      });
    },
  };
}

test("authOptional: a missing credential resolves without ever prompting", async () => {
  delete process.env.CHATGPT_USERNAME;
  delete process.env.CHATGPT_PASSWORD;
  const spy = interactionSpy();

  const credentials = await resolveAuth(
    { kind: "env", required: ["CHATGPT_USERNAME", "CHATGPT_PASSWORD"] },
    { authOptional: true, connectorName: "chatgpt", sendInteraction: spy.sendInteraction }
  );

  assert.deepEqual(credentials, {}, "an absent optional credential resolves to the empty set, not a throw");
  assert.deepEqual(spy.calls, [], "a session-first connector must never raise a credentials interaction");
});

test("authOptional: a PARTIAL credential is reported as missing rather than handed on as half a login", async () => {
  // A username with no password is not a usable sign-in. Handing the partial
  // through let a connector type a username into a real provider form,
  // submit, and then read the resulting page as the PROVIDER misbehaving —
  // the misdiagnosis this both-or-nothing rule exists to prevent. The owner
  // debugs the provider while the true cause is a credential he never saved.
  //
  // Suppressing the PROMPT is what `authOptional` buys; it never meant
  // suppressing the FACT. `missing` still names the absent field so the
  // caller can say precisely what is absent.
  delete process.env.CHATGPT_PASSWORD;
  process.env.CHATGPT_USERNAME = "owner@example.test";
  const spy = interactionSpy();

  const credentials = await resolveAuth(
    { kind: "env", required: ["CHATGPT_USERNAME", "CHATGPT_PASSWORD"] },
    { authOptional: true, connectorName: "chatgpt", sendInteraction: spy.sendInteraction }
  );

  assert.deepEqual(
    credentials,
    {},
    "half a login must not reach the provider's form — a partial resolves empty, so the connector takes its no-credential path"
  );
  assert.deepEqual(spy.calls, [], "a partially-filled optional credential must not prompt for the remainder");
});

/**
 * `resolveLoginCredentials` — the both-or-nothing resolver a connector uses to
 * decide whether it has a sign-in to attempt at all.
 *
 * The owner harm it prevents is a MISDIAGNOSIS, not a crash. With no saved
 * password the old path attempted a login anyway and reported that the
 * provider's sign-in form "did not render" — so the owner went and debugged
 * the provider instead of saving a credential. The honest reason names the
 * CREDENTIAL, never the page, and never leaks a value.
 */

test("resolveLoginCredentials: a complete pair resolves and carries both values", () => {
  const resolved = resolveLoginCredentials(
    { VENMO_PASSWORD: "correct-horse", VENMO_USERNAME: "owner@example.test" },
    { password: ["VENMO_PASSWORD"], username: ["VENMO_USERNAME"] },
    "venmo"
  );

  assert.deepEqual(resolved, {
    kind: "resolved",
    password: "correct-horse",
    username: "owner@example.test",
  });
});

test("resolveLoginCredentials: a username with no password is absent, naming the password", () => {
  const resolved = resolveLoginCredentials(
    { VENMO_USERNAME: "owner@example.test" },
    { password: ["VENMO_PASSWORD"], username: ["VENMO_USERNAME"] },
    "venmo"
  );

  assert.equal(resolved.kind, "absent");
  assert.deepEqual(resolved.kind === "absent" ? resolved.missing : null, ["VENMO_PASSWORD"]);
});

test("resolveLoginCredentials: the reason names the credential and never blames the provider's page", () => {
  const resolved = resolveLoginCredentials(
    undefined,
    { password: ["VENMO_PASSWORD"], username: ["VENMO_USERNAME"] },
    "venmo"
  );

  assert.equal(resolved.kind, "absent");
  const reason = resolved.kind === "absent" ? resolved.reason : "";
  assert.match(reason, /no stored credential for this venmo connection \(missing: VENMO_USERNAME, VENMO_PASSWORD\)/);
  assert.doesNotMatch(
    reason,
    /sign-in form did not render|unexpected UI|page did not render/i,
    "blaming the page is the misdiagnosis: the owner debugs the provider instead of saving a credential"
  );
});

test("resolveLoginCredentials: a blank or whitespace value counts as absent, not as a credential", () => {
  const resolved = resolveLoginCredentials(
    { VENMO_PASSWORD: "   ", VENMO_USERNAME: "" },
    { password: ["VENMO_PASSWORD"], username: ["VENMO_USERNAME"] },
    "venmo"
  );

  assert.equal(resolved.kind, "absent");
  assert.deepEqual(resolved.kind === "absent" ? resolved.missing : null, ["VENMO_USERNAME", "VENMO_PASSWORD"]);
});

test("resolveLoginCredentials: the first non-empty alias wins for each field", () => {
  const resolved = resolveLoginCredentials(
    { VENMO_EMAIL: "owner@example.test", VENMO_PASSWORD: "correct-horse", VENMO_USERNAME: "" },
    { password: ["VENMO_PASSWORD"], username: ["VENMO_USERNAME", "VENMO_EMAIL"] },
    "venmo"
  );

  assert.equal(resolved.kind === "resolved" ? resolved.username : null, "owner@example.test");
});

test("resolveLoginCredentials: no reason ever contains a credential value", () => {
  const resolved = resolveLoginCredentials(
    { VENMO_USERNAME: "owner@example.test" },
    { password: ["VENMO_PASSWORD"], username: ["VENMO_USERNAME"] },
    "venmo"
  );

  const reason = resolved.kind === "absent" ? resolved.reason : "";
  assert.doesNotMatch(reason, /owner@example\.test/, "a reason is owner-visible copy and must carry field names only");
});

test("noStoredCredentialReason: falls back to naming both fields when nothing was recorded", () => {
  assert.match(noStoredCredentialReason("venmo", []), /missing: username, password/);
});

test("authOptional: a fully PRESENT credential is used normally and never prompts", async () => {
  // Auto-login is preserved. `authOptional` makes the credential optional, not
  // ignored — the owner who seals a username/password still gets auto-login.
  process.env.CHATGPT_USERNAME = "owner@example.test";
  process.env.CHATGPT_PASSWORD = "correct-horse";
  const spy = interactionSpy();

  const credentials = await resolveAuth(
    { kind: "env", required: ["CHATGPT_USERNAME", "CHATGPT_PASSWORD"] },
    { authOptional: true, connectorName: "chatgpt", sendInteraction: spy.sendInteraction }
  );

  assert.deepEqual(credentials, {
    CHATGPT_PASSWORD: "correct-horse",
    CHATGPT_USERNAME: "owner@example.test",
  });
  assert.deepEqual(spy.calls, []);
});

test("REGRESSION GUARD: without authOptional a missing credential still prompts and still throws", async () => {
  // Every connector that genuinely needs its secret (github/ynab/notion/
  // amazon/chase/...) depends on this. Prompt suppression is strictly opt-in:
  // absent the flag the owner is still asked, and an unanswered prompt is
  // still terminal. Asserts the prompt COUNT as well as the throw — a change
  // that suppressed prompting globally would still throw here and would slip
  // past a throw-only assertion.
  delete process.env.NOTION_API_TOKEN;
  const spy = interactionSpy();

  await assert.rejects(
    () =>
      resolveAuth(
        { kind: "env", required: ["NOTION_API_TOKEN"] },
        { connectorName: "notion", sendInteraction: spy.sendInteraction }
      ),
    /notion_credentials_missing/,
    "a required credential must remain terminal when the prompt goes unanswered"
  );

  assert.equal(spy.calls.length, 1, "the owner must still be asked for a genuinely required credential");
  assert.equal(spy.calls[0]?.kind, "credentials");
});

test("the credentials prompt makes no false persistence promise", async () => {
  // Owner-submitted interaction values are used for THAT RUN ONLY — they are
  // never written to `.env.local`, durable config, or the spine event payload
  // (the reference implementation says so in its own owner-facing copy). The
  // prompt used to instruct the owner to "Set in .env.local for persistence",
  // describing an operator deployment step as if it were the effect of
  // answering the prompt.
  delete process.env.NOTION_API_TOKEN;
  const spy = interactionSpy();

  await assert.rejects(() =>
    resolveAuth(
      { kind: "env", required: ["NOTION_API_TOKEN"] },
      { connectorName: "notion", sendInteraction: spy.sendInteraction }
    )
  );

  const message = spy.calls[0]?.message ?? "";
  assert.doesNotMatch(message, /\.env\.local/, "the prompt must not tell the owner to edit .env.local");
  assert.doesNotMatch(message, /persistence/i, "the prompt must not promise persistence it does not provide");
  assert.match(message, /NOTION_API_TOKEN/, "the prompt must still name what it needs");
});

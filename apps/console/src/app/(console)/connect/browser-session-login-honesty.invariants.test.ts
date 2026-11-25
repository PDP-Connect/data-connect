// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A browser_session connection reaches `first_sync_running` /
 * `first_sync_pending` from run evidence ALONE — see `hasDraftSetupProgress`
 * in `reference-implementation/runtime/static-secret-setup-status.ts`, which
 * returns true for `setupKind === "browser_session"` whenever an active or
 * last run row exists. For this setup kind the run IS the login attempt: it
 * starts so the owner can sign in inside the streamed browser.
 *
 * So a run row proves a sign-in was ATTEMPTED, never that it completed.
 * `defaultSetupMaterial` pins `present: false` for browser sessions precisely
 * because nothing was captured. The console previously rendered "Login is
 * complete" from that evidence, telling the owner a session was live while the
 * stream still sat on the provider's sign-in form (owner-reported 2026-08-19,
 * Reddit).
 *
 * These are source-text invariants, matching the convention of the sibling
 * `*.invariants.test.ts` files: this page is a React server component with no
 * DOM harness in this suite, so the rendered copy is asserted against the
 * source. See design-notes/browser-stream-status-honesty-2026-08-22.md.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const STATUS_PAGE_FILE = fileURLToPath(new URL("./status/[connectionId]/first-sync-outcome.ts", import.meta.url));

// The claim that must never return: any assertion that the login itself
// succeeded, in any of the phrasings that read as a completed sign-in.
const LOGIN_COMPLETE_CLAIM = /Login is complete|You(?:'re| are) (?:signed|logged) in|Already (?:signed|logged) in/i;
const RUNNING_HEADLINE = /runningHeadline: \(name: string\) => `\$\{name\} is still syncing\.`/;
const NEEDS_YOU_HEADLINE = /needsYouHeadline: \(name: string\) => `\$\{name\} needs you to finish signing in\.`/;

function readStatusPage(): Promise<string> {
  return readFile(STATUS_PAGE_FILE, "utf8");
}

// Design Page 3 ("Still running", "Needs you"): the in-flight sentence says only what is observed.
test("the status outcome never claims the login completed", async () => {
  const src = await readStatusPage();
  assert.doesNotMatch(
    src,
    LOGIN_COMPLETE_CLAIM,
    "a browser_session run row proves only that a sign-in was attempted — the console has no evidence the login succeeded, so it must not assert that it did"
  );
});

test("a running or unfinished sign-in is worded as syncing or needing the person (design Page 3)", async () => {
  const src = await readStatusPage();
  assert.match(src, RUNNING_HEADLINE);
  assert.match(src, NEEDS_YOU_HEADLINE);
});

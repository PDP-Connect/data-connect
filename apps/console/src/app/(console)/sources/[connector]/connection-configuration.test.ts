// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural coverage for the connection configuration surface.
 *
 * The editor is a client component with hooks and this app has no JSX render
 * harness (no jsdom / testing-library), so — like `connection-danger-zone.test.ts`
 * and `rename-connection.test.ts` — the wiring is asserted via source regex.
 * The BEHAVIOURAL guarantee that the draft and review steps never write is
 * proven by execution in `connection-config-view-model.test.ts`; this file pins
 * the structural half that a regex can actually prove:
 *
 *   - the component reaches the server through exactly two named actions, and
 *     neither is called from a render path or an effect;
 *   - the commit button's label comes from the view-model's enforced-kind
 *     descriptor rather than a hard-coded string, so it cannot promise
 *     "Apply changes" for a bundle the server will hold as proposed;
 *   - a 409 stale write preserves the draft and offers an explicit rebase;
 *   - confirmation renders the PERSISTED revision, not the local draft;
 *   - `not_declared` never reads as "this connector has no options";
 *   - machine evidence stays behind Technical details.
 *
 * This file imports no app code (source-regex only), so it runs under the
 * `node:test` runner with native type-stripping even from the bracketed
 * `[connector]` directory.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMPONENT_FILE = `${HERE}connection-configuration.tsx`;
const ACTIONS_FILE = `${HERE}config-actions.ts`;
const VIEW_MODEL_FILE = `${HERE}connection-config-view-model.ts`;
const PAGE_FILE = `${HERE}source-page.tsx`;

// ─── Top-level regex constants (biome useTopLevelRegex) ─────────────────────

const CLIENT_DIRECTIVE_RE = /^"use client";/;
const PROPOSE_IMPORT_RE = /import \{ confirmConfigAction, proposeConfigAction \} from "\.\/config-actions\.ts"/;
/** The ONLY two call sites that may reach the server. */
const PROPOSE_CALL_RE = /await proposeConfigAction\(\{/;
const CONFIRM_CALL_RE = /await confirmConfigAction\(\{/;
const PROPOSE_CALL_COUNT_RE = /proposeConfigAction\(/g;
const CONFIRM_CALL_COUNT_RE = /confirmConfigAction\(/g;
/**
 * The two sentences live in the view-model's `resolveAvailability`, so the
 * distinction is pinned where it is authored: the `not_declared` message must
 * say the options are undescribed, and must not assert the connector has none.
 */
const VM_NOT_DECLARED_MESSAGE_RE =
  /kind: "not_declared",\s*message:\s*\n?\s*"[^"]*not available for this data source yet[^"]*"/;
/** Both writes must be owner-initiated, i.e. inside a transition callback. */
const COMMIT_IN_TRANSITION_RE = /startTransition\(async \(\) => \{\s*const result = await proposeConfigAction/;
const CONFIRM_IN_TRANSITION_RE = /startTransition\(async \(\) => \{\s*const result = await confirmConfigAction/;
/** A write must never be triggered by rendering or by an effect. */
const NO_EFFECT_RE = /useEffect/;

const REVIEW_STEP_RE = /step === "review"/;
const EDIT_STEP_RE = /step === "edit"/;
const DIFF_FROM_VIEW_MODEL_RE = /diffDraft\(schema, config\.active_revision, draft\)/;
const COMMIT_FROM_VIEW_MODEL_RE = /describeCommit\(changes\)/;

const STALE_BRANCH_RE = /result\.failure === "stale"/;
const STALE_SETS_STATE_RE = /setStale\(parseStaleConflict\(result\.message\)\)/;
const REVIEW_AGAINST_LATEST_RE = /Review against latest/;
const DRAFT_PRESERVED_RE = /Your edits are still here/;
/** The draft must not be reset on the stale path. */
const STALE_RESETS_DRAFT_RE = /result\.failure === "stale"[\s\S]{0,220}setDraft\(/;

const PERSISTED_STATE_RE = /setPersisted\(result\.revision\)/;
const APPLIED_STATE_RE = /setApplied\(result\.revision\)/;
const RENDERS_PERSISTED_STATUS_RE = /result\.revision\.status === "active"/;
const PENDING_FROM_PERSISTED_RE = /revision\.config\[key\]/;
const CONFIRM_BY_NUMBER_RE = /onConfirm\(revision\.revision\)/;
const TECHNICAL_DETAILS_RE = /<summary className="cursor-pointer text-muted-foreground">Technical details<\/summary>/;
const DATA_SOURCE_DEFAULT_RE = /Data source default/;

/** Owner copy must not leak protocol nouns. */
const RAW_COLLECTION_SCOPE_COPY_RE = />[^<]*collection_scope[^<]*</;
const RAW_TRANSPORT_COPY_RE = />[^<]*\btransport\b[^<]*</;

const ACT_SERVER_DIRECTIVE_RE = /^"use server";/;
const ACT_REQUIRE_ACCESS_RE = /await requireDashboardAccess\(/;
const ACT_PROPOSE_FN_RE = /export async function proposeConfigAction/;
const ACT_CONFIRM_FN_RE = /export async function confirmConfigAction/;
const ACT_STALE_CODE_RE = /const STALE_CODE = "connector_instance_config_stale_write"/;
const ACT_STALE_CLASSIFY_RE = /err\.status === 409 && err\.code === STALE_CODE/;
const ACT_CONFLICT_CLASSIFY_RE = /err\.status === 409/;
const ACT_NO_REDIRECT_RE = /redirect\(/;
const ACT_REVALIDATE_RE = /revalidatePath\(`\/sources\/\$\{connectorId\}`\)/;
const ACT_CONFIRM_TAKES_REVISION_RE = /confirmConnectionConfigRevision\(input\.connectionId, input\.revision\)/;
const ACT_ECHOES_BASE_RE = /baseEpoch: input\.baseEpoch,\s*baseRevision: input\.baseRevision/;

const PAGE_RENDERS_CONFIG_RE = /<ConnectionConfiguration/;

async function read(file: string): Promise<string> {
  return await readFile(file, "utf8");
}

test("the editor reaches the server through exactly two owner-initiated actions", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, CLIENT_DIRECTIVE_RE);
  assert.match(src, PROPOSE_IMPORT_RE);
  assert.match(src, PROPOSE_CALL_RE);
  assert.match(src, CONFIRM_CALL_RE);
  // One call site each. A second would be a path the invariant has not seen.
  // Exactly one invocation each (the import names them without parentheses).
  assert.equal(src.match(PROPOSE_CALL_COUNT_RE)?.length, 1, "propose has exactly one call site");
  assert.equal(src.match(CONFIRM_CALL_COUNT_RE)?.length, 1, "confirm has exactly one call site");
});

test("no write can be triggered by rendering or by an effect", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, COMMIT_IN_TRANSITION_RE);
  assert.match(src, CONFIRM_IN_TRANSITION_RE);
  // No effects at all in this component: an effect is the one place a write
  // could fire without the owner pressing anything.
  assert.doesNotMatch(src, NO_EFFECT_RE);
});

test("the review step is rendered from the pure view-model, not from a server response", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, EDIT_STEP_RE);
  assert.match(src, REVIEW_STEP_RE);
  assert.match(src, DIFF_FROM_VIEW_MODEL_RE);
  assert.match(src, COMMIT_FROM_VIEW_MODEL_RE);
});

test("the commit button's promise comes from the enforced kind, never a hard-coded label", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, /commit.expectedStatus === "active"/);
  assert.match(src, /This change needs your confirmation before it takes effect/);
  assert.match(src, /isPending \? "Saving…" : "Save"/);
});

test("a stale write preserves the draft and offers an explicit rebase", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, STALE_BRANCH_RE);
  assert.match(src, STALE_SETS_STATE_RE);
  assert.match(src, REVIEW_AGAINST_LATEST_RE);
  assert.match(src, DRAFT_PRESERVED_RE);
  // Never merged, never discarded: the stale branch must not touch the draft.
  assert.doesNotMatch(src, STALE_RESETS_DRAFT_RE);
});

test("the outcome rendered is the one the server persisted", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, RENDERS_PERSISTED_STATUS_RE);
  assert.match(src, PERSISTED_STATE_RE);
  assert.match(src, APPLIED_STATE_RE);
});

test("a pending proposal is rendered from the persisted revision and confirmed by number", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, PENDING_FROM_PERSISTED_RE);
  assert.match(src, CONFIRM_BY_NUMBER_RE);
});

test("an undeclared schema never claims the connector has no options", async () => {
  const src = await read(COMPONENT_FILE);
  assert.match(src, /availability.kind !== "editable"\) return null/);
  assert.match(await read(VIEW_MODEL_FILE), VM_NOT_DECLARED_MESSAGE_RE);
});

test("defaults are labelled as data source defaults and machine evidence stays disclosed", async () => {
  const component = await read(COMPONENT_FILE);
  const viewModel = await read(VIEW_MODEL_FILE);
  assert.match(component, TECHNICAL_DETAILS_RE);
  // DIRECTION.md §One data source: labels use plain product language.
  assert.match(viewModel, DATA_SOURCE_DEFAULT_RE);
});

test("owner-visible copy carries no protocol vocabulary", async () => {
  const src = await read(COMPONENT_FILE);
  assert.doesNotMatch(src, RAW_COLLECTION_SCOPE_COPY_RE);
  assert.doesNotMatch(src, RAW_TRANSPORT_COPY_RE);
});

test("both actions re-verify access, keep the message, and echo the base they read", async () => {
  const src = await read(ACTIONS_FILE);
  assert.match(src, ACT_SERVER_DIRECTIVE_RE);
  assert.match(src, ACT_PROPOSE_FN_RE);
  assert.match(src, ACT_CONFIRM_FN_RE);
  assert.match(src, ACT_REQUIRE_ACCESS_RE);
  assert.match(src, ACT_ECHOES_BASE_RE);
  assert.match(src, ACT_REVALIDATE_RE);
  // A redirect would discard the owner's draft on a refused write.
  assert.doesNotMatch(src, ACT_NO_REDIRECT_RE);
});

test("the actions separate a stale write from every other conflict", async () => {
  const src = await read(ACTIONS_FILE);
  assert.match(src, ACT_STALE_CODE_RE);
  assert.match(src, ACT_STALE_CLASSIFY_RE);
  assert.match(src, ACT_CONFLICT_CLASSIFY_RE);
});

test("confirmation sends a revision number, never a config body", async () => {
  const src = await read(ACTIONS_FILE);
  assert.match(src, ACT_CONFIRM_TAKES_REVISION_RE);
});

test("the source controls render before settings and Details", async () => {
  const src = await read(PAGE_FILE);
  assert.match(src, PAGE_RENDERS_CONFIG_RE);
  // DIRECTION.md §One data source: this data source's controls precede Settings and Details.
  assert.ok(src.indexOf("<ConnectionConfiguration") < src.indexOf("<ConnectionDangerZone"));
});

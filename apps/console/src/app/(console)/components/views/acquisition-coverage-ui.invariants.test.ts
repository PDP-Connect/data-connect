// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acquisition/coverage UI tranche invariants.
 *
 * Pins the owner-facing copy for the first slice toward the
 * `define-collection-acquisition-coverage` SLVP choreography so it cannot
 * silently regress back to single-status / provider-credential framing:
 *
 *   1. The source catalog presents a source JOURNEY (name, recommended next
 *      action, current support fact, low-noise path to detail) — never "one
 *      status and one next action".
 *   2. The manual/upload page reads as a coverage-assistant start: generated
 *      from the manifest, primary acquisition methods first with advanced paths
 *      behind one disclosure, validate-before-commit language, and an import
 *      (not "first sync") call to action for an owner artifact.
 *   3. The setup status page uses import/receipt language for `manual_upload`
 *      and never implies provider credential semantics for an import.
 *
 * These are JSX/React server components that cannot be imported under node:test
 * without a full resolver, so — mirroring sources-ia.invariants.test.ts — we
 * assert their critical structural copy from source.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MANUAL_UPLOAD_FILE = `${HERE}../../connect/manual-upload/[connectorId]/page.tsx`;
const MANUAL_UPLOAD_FORM_FILE = `${HERE}../../connect/manual-upload/[connectorId]/manual-upload-form.tsx`;
const STATUS_FILE = `${HERE}../../connect/status/[connectionId]/page.tsx`;
const STATUS_OUTCOME_FILE = `${HERE}../../connect/status/[connectionId]/first-sync-outcome.ts`;
const STATUS_BODY_FILE = `${HERE}../../connect/status/[connectionId]/first-sync-body.tsx`;
const STATUS_LINKS_FILE = `${HERE}../../connect/status/[connectionId]/connect-status-links.ts`;

// The status page's own sourceRecordsHref/sourceDetailHref now live in
// connect-status-links.ts (extracted so setupHref's connection-id regression
// — the draft-deadlock fix — is directly unit-testable). Same contract, same
// helper names, different file.
const STATUS_SOURCE_RECORDS_HELPER = /export function sourceRecordsHref[\s\S]*new URLSearchParams\(\{ connection:/;
const STATUS_SOURCE_DETAIL_HELPER = /export function sourceDetailHref[\s\S]*new URLSearchParams\(\{ connection_id:/;
// RAISE-RULES.md 2 / setup-pages brief 4: the filled action after success is "Open <Source>".
const CONNECTOR_LEVEL_STATUS_RECORDS_LINK = /href=\{`\/sources\/\$\{encodeURIComponent\(status\.connector_id\)\}`\}/;
// RAISE-RULES.md 4 bans "coverage" on screen; the receipt stays revisitable through the status page link.
const COVERAGE_RECEIPT_COPY = /\/connect\/status\/\$\{encodeURIComponent\(connectionId\)\}/;
const OLD_FIRST_SYNC_CTA = /Upload and start first sync/;
const PROVIDER_CREDENTIAL_COPY = /provider account sign-in is required|provider credential/;
const DEPLOYMENT_SEMANTICS_COPY = /pnpm --dir|packages\/[a-z]|connector_instance_id|source_instance_id/;

// ── 2. Manual/upload page is a coverage-assistant start ─────────────────────

// Design "File services": the page prints the service's own export steps and offers "Import" and "Check the file first".
test("manual upload page prints the export steps and checks the file before importing", async () => {
  const pageSrc = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  const formSrc = await readFile(MANUAL_UPLOAD_FORM_FILE, "utf8");
  const bodies = await readFile(`${HERE}../../sources/add/connect-bodies.tsx`, "utf8");
  assert.match(bodies, /data-testid="export-steps"/);
  assert.match(bodies, /data-testid="export-links"/);
  assert.match(pageSrc, /exportInstructions\(/);
  // It speaks of a durable receipt the owner can revisit.
  assert.match(formSrc, COVERAGE_RECEIPT_COPY);
});

test("manual upload page leads with primary methods and lists other ways as plain links", async () => {
  const src = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  const steps = await readFile(`${HERE}../../connect/manual-upload/[connectorId]/manual-upload-steps.ts`, "utf8");
  assert.match(src, /exportInstructions\(setup\.acquisition_methods\)/);
  assert.match(steps, /method\.posture === "primary"/);
  assert.doesNotMatch(src, /<details/);
});

test("manual upload CTA imports an owner artifact rather than starting a sync", async () => {
  const src = await readFile(MANUAL_UPLOAD_FORM_FILE, "utf8");
  // The owner artifact is imported/validated, never "first sync".
  assert.match(src, /fileCopy\.button[\s\S]*fileCopy\.checkFirst/);
  assert.doesNotMatch(src, OLD_FIRST_SYNC_CTA);
});

test("manual upload page does not imply provider credential or deployment semantics", async () => {
  const pageSrc = await readFile(MANUAL_UPLOAD_FILE, "utf8");
  const formSrc = await readFile(MANUAL_UPLOAD_FORM_FILE, "utf8");
  assert.doesNotMatch(`${pageSrc}\n${formSrc}`, PROVIDER_CREDENTIAL_COPY);
  assert.doesNotMatch(`${pageSrc}\n${formSrc}`, DEPLOYMENT_SEMANTICS_COPY);
});

// ── 3. Setup status page: one outcome sentence per design "Page 3" ───────────
// Design "Page 3" and "Every item": the receipt table, the import-progress card and the
// "Details" fold are removed; the page says the outcome in one sentence and offers the next button.

test("status page says the outcome and offers the data (design Page 3: worked)", async () => {
  const src = await readFile(STATUS_FILE, "utf8");
  const outcomeSrc = await readFile(STATUS_OUTCOME_FILE, "utf8");
  const bodySrc = await readFile(STATUS_BODY_FILE, "utf8");
  const linksSrc = await readFile(STATUS_LINKS_FILE, "utf8");
  assert.match(linksSrc, STATUS_SOURCE_RECORDS_HELPER);
  assert.match(linksSrc, STATUS_SOURCE_DETAIL_HELPER);
  assert.match(outcomeSrc, /sourceRecordsHref\(status\)/);
  assert.match(outcomeSrc, /See your \$\{name\} data/);
  assert.match(bodySrc, /<LinkButton link=\{outcome\.primary\} primary \/>/);
  assert.doesNotMatch(src + outcomeSrc + bodySrc, CONNECTOR_LEVEL_STATUS_RECORDS_LINK);
});

test("status page no longer prints receipts, progress phases or a fold (design Page 3, banned list 1 and 9)", async () => {
  const all = (await readFile(STATUS_FILE, "utf8")) +
    (await readFile(STATUS_OUTCOME_FILE, "utf8")) +
    (await readFile(STATUS_BODY_FILE, "utf8"));
  assert.doesNotMatch(all, /<details|Coverage preview|Import progress|Health projected|Setup state/);
  assert.doesNotMatch(all, /status\.connection_id\}<\/dd>/);
});

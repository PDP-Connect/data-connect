// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * biome-ignore-all lint/performance/useTopLevelRegex: These invariant tests use
 * local regex assertions to keep the source-contract checks readable.
 *
 * Asserts that the device-exporters enrollment form surfaces the canonical
 * `@pdpp/local-collector` enroll / run invocations via the shared
 * helpers in apps/console/src/lib/pdpp-cli-command.ts, and exposes stable test
 * hooks for the rendered commands. The operator-readiness runbook in
 * docs/operator/local-collector-runbook.md depends on this surface; if it
 * drifts, the runbook drifts with it.
 *
 * See openspec/changes/introduce-local-collector-runner and
 * openspec/changes/design-local-collector-state-sync.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../../../", import.meta.url);

function read(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

const FORM_PATH = "apps/console/src/app/(console)/device-exporters/enrollment-form.tsx";
const ACTIONS_PATH = "apps/console/src/app/(console)/device-exporters/actions.ts";

const COLLECTOR_SETUP_HELPER = /pdppLocalCollectorSetupCommand/;
const COLLECTOR_ENROLL_HELPER = /pdppLocalCollectorEnrollCommand/;
const COLLECTOR_RUN_HELPER = /pdppLocalCollectorRunCommand/;
const LOCAL_COLLECTOR_PACKAGE = /@pdpp\/local-collector/;
const BROWSER_COLLECTOR_MONOREPO_COPY =
  /PDPP monorepo checkout|pnpm --dir|packages\/polyfill-connectors|browser-collector run command/;
const ENROLL_TESTID = /data-testid="collector-enroll-command"/;
const RUN_TESTID_CLAUDE = /data-testid={`collector-run-command-/;
const COLLECTOR_RUN_CONNECTORS_IMPORT_RE =
  /import \{ SUPPORTED_LOCAL_COLLECTOR_CONNECTORS as COLLECTOR_RUN_CONNECTORS \} from "\.\.\/lib\/connection-modality\.ts";/;

test("enrollment form derives the canonical local collector commands via shared helpers", async () => {
  const src = await read(FORM_PATH);
  assert.doesNotMatch(
    src,
    COLLECTOR_SETUP_HELPER,
    "form must not render pdppLocalCollectorSetupCommand: `setup`/`--sample` are not in the published @pdpp/local-collector package"
  );
  assert.match(src, COLLECTOR_ENROLL_HELPER, "form must call pdppLocalCollectorEnrollCommand");
  assert.match(src, COLLECTOR_RUN_HELPER, "form must call pdppLocalCollectorRunCommand");
  assert.match(src, LOCAL_COLLECTOR_PACKAGE, "form must surface the public @pdpp/local-collector path");
  assert.doesNotMatch(src, BROWSER_COLLECTOR_MONOREPO_COPY, "normal form must not surface browser monorepo commands");
});

test("enrollment form exposes stable test hooks for the rendered commands", async () => {
  const src = await read(FORM_PATH);
  assert.match(src, ENROLL_TESTID, "enroll command must carry a stable data-testid");
  assert.match(src, RUN_TESTID_CLAUDE, "run command must carry a stable per-connector data-testid");
});

test("enroll command appears before the run command in the rendered form", async () => {
  const src = await read(FORM_PATH);
  const enrollIndex = src.indexOf('data-testid="collector-enroll-command"');
  const runIndex = src.indexOf("data-testid={`collector-run-command-");
  assert.ok(enrollIndex > -1, "enroll command block must be present");
  assert.ok(runIndex > -1, "run command block must be present");
  assert.ok(enrollIndex < runIndex, "enroll must render before run, matching the two-step CLI contract");
});

test("enrollment form never renders a local-collector setup invocation", async () => {
  // Direct regression test for the fresh-install blocker: the published
  // @pdpp/local-collector CLI (confirmed against the live 1.1.0 tarball) has
  // no `setup` subcommand and no `--sample` flag. Guard the LITERAL rendered
  // string, not just the helper import, so a future inline command build
  // cannot reintroduce the unpublished subcommand.
  const src = await read(FORM_PATH);
  assert.doesNotMatch(src, /local-collector setup/, "form must never render `local-collector setup`");
  assert.doesNotMatch(src, /--sample/, "form must never render the unpublished --sample flag");
});

test("enrollment form advertises every connector bundled in the published @pdpp/local-collector npx path", async () => {
  // Derived, not hardcoded. `LOCAL_COLLECTOR_DEFINITIONS` in
  // packages/polyfill-connectors/src/collector-registry.ts is the single source
  // of truth for what the published npx bundle actually ships. The form now
  // imports its connector list directly from `SUPPORTED_LOCAL_COLLECTOR_CONNECTORS`
  // (via connection-modality.ts) instead of pinning a separate literal, so the
  // two cannot drift silently (a pinned literal is exactly how `signal` broke
  // this test previously).
  const src = await read(FORM_PATH);
  assert.match(
    src,
    COLLECTOR_RUN_CONNECTORS_IMPORT_RE,
    "the form must import its connector list from SUPPORTED_LOCAL_COLLECTOR_CONNECTORS, not a pinned literal"
  );
});

test("enrollment action only mints packaged local collector enrollment codes", async () => {
  const src = await read(ACTIONS_PATH);
  assert.match(src, /isSupportedLocalCollectorConnector\(connectorId\)/);
  assert.match(src, /only creates packaged local collector enrollments/);
  assert.doesNotMatch(src, /isSupportedBrowserCollectorConnector/);
});

const RUNBOOK_CROSS_REF = /docs\/operator\/local-collector-runbook\.md/;
const PDPP_COLLECTOR_ENROLL_LITERAL = /@pdpp\/local-collector enroll/;

test("local-device-exporter runbook cross-references the operator runbook", async () => {
  const legacyDoc = await read("reference-implementation/docs/local-device-exporter.md");
  assert.match(
    legacyDoc,
    RUNBOOK_CROSS_REF,
    "legacy lane doc must point operators at the supported pdpp collector flow"
  );
  assert.match(
    legacyDoc,
    PDPP_COLLECTOR_ENROLL_LITERAL,
    "legacy lane doc must surface the canonical @pdpp/local-collector enroll command"
  );
});

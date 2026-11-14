// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigurationDraft as Draft, RouteView as Route, Candidate as RouteCandidate } from "@tnunamak/gozar";
import { requireRouteApproval, requireSetupApproval } from "../server/reachability/approvals.ts";
import { readConfigurationDraft } from "../server/reachability/draft-read.ts";
import { ConfigurationDraftSession, configurationFromSetup } from "../server/reachability/drafts.ts";
import { hostCapability, observationText, routePresentation } from "../server/reachability/presentation.ts";
import { createHostSecretBackend } from "../server/reachability/secret-backend.ts";
import fixture from "./fixtures/reachability/configuration.json" with { type: "json" };

const draft = fixture as Draft;
const action = draft.configuration.actions[0]!;

test("host rejects route approval at setup before any effect", () => {
  let effects = 0;
  assert.throws(
    () => {
      requireSetupApproval(action, { candidateToken: "route-token", kind: "route" });
      effects++;
    },
    { code: "consent_kind_mismatch" }
  );
  assert.equal(effects, 0);
});

test("host rejects setup approval at start before any effect", () => {
  let effects = 0;
  assert.throws(
    () => {
      requireRouteApproval({} as RouteCandidate, { digest: action.digest, kind: "setup" });
      effects++;
    },
    { code: "consent_kind_mismatch" }
  );
  assert.equal(effects, 0);
});

test("setup snapshot must agree with result revision and scope", () => {
  const result = {
    catalogRevision: "catalog-one",
    configuration: draft.configuration,
    configurationRevision: draft.configuration.revision,
    nextAction: null,
    schemaVersion: 1 as const,
    scopeId: draft.scopeId,
    state: "complete" as const,
  };
  assert.equal(configurationFromSetup(result), draft.configuration);
  assert.throws(() => configurationFromSetup({ ...result, configurationRevision: "other" }), {
    code: "setup_configuration_inconsistent",
  });
  assert.throws(() => configurationFromSetup({ ...result, scopeId: "other" }), {
    code: "setup_configuration_inconsistent",
  });
});

test("reload resumes from the public current draft, never cached actions", async () => {
  const session = new ConfigurationDraftSession(null);
  assert.throws(() => session.action(action.id, draft.configuration.revision), { code: "draft_read_required" });
  let reads = 0;
  await session.reload(
    {
      readConfigurationDraft: async (request) => {
        assert.equal(request.draftId, draft.draftId);
        reads++;
        return draft;
      },
    },
    { draftId: draft.draftId, home: "fixture-home", providerId: action.consent!.scope.providerId }
  );
  assert.equal(reads, 1);
  assert.equal(session.action(action.id, draft.configuration.revision), action);
  assert.throws(() => session.action(action.id, "stale"), { code: "configuration_stale" });
  session.invalidate();
  assert.throws(() => session.action(action.id, draft.configuration.revision), { code: "draft_read_required" });
});

test("missing draft read and unknown draft fail explicitly and invalidate held actions", async () => {
  const request = { draftId: "unknown-draft", home: "fixture-home", providerId: action.consent!.scope.providerId };
  await assert.rejects(readConfigurationDraft({}, request), { code: "draft_read_unavailable" });
  const session = new ConfigurationDraftSession(draft);
  await assert.rejects(
    session.reload(
      {
        readConfigurationDraft: async () => {
          throw Object.assign(new Error("unknown draft"), { code: "draft_not_found" });
        },
      },
      request
    ),
    { code: "draft_not_found" }
  );
  assert.throws(() => session.snapshot, { code: "draft_read_required" });
});

test("host capabilities preserve denied and undeclared states", () => {
  assert.deepEqual(hostCapability({}, "new.capability"), { known: false, reason: "host-capability-undeclared" });
  assert.deepEqual(hostCapability({ "new.capability": { known: true, value: false } }, "new.capability"), {
    known: true,
    value: false,
  });
  assert.equal(observationText({ known: true, value: false }), "false");
  assert.equal(observationText({ known: true, value: 0 }), "0");
  assert.equal(observationText({ known: true, value: "" }), "(empty)");
});

test("missing secret bridge is unknown with no file fallback", async () => {
  const backend = createHostSecretBackend(null);
  assert.deepEqual(await backend.presence({ handle: "handle", scopeId: "scope" }), {
    known: false,
    reason: "secret_backend_unavailable",
  });
  await assert.rejects(async () => backend.withSecret({ handle: "handle", scopeId: "scope" }, async () => true), {
    code: "secret_backend_unavailable",
  });
});

test("unsupported proof refresh is unpublished and offers only stop", () => {
  const result = routePresentation({} as Route, null, 0, "proof_refresh_unsupported");
  assert.deepEqual(result, { actions: ["stop"], label: "Unpublished", reason: "proof_refresh_unsupported" });
});

test("host journal records intent before effects and marks a lost reply unknown, possibly live", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ReachabilityOperations } = await import("../server/reachability/operations.ts");
  const root = await mkdtemp(join(tmpdir(), "reachability-journal-"));
  try {
    const operations = new ReachabilityOperations(root);
    let sawIntent = false;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await operations.start("start", null, async (operationId) => {
      const intent = JSON.parse(await readFile(join(root, `${operationId}.json`), "utf8"));
      sawIntent = intent.operationId === operationId && intent.stage === "applying";
      release();
      return new Promise<never>(() => {
        /* Simulate a reply lost with the old host. */
      });
    });
    await wait;
    assert.equal(sawIntent, true);
    // A replacement host has no running task or returned handle. It must not
    // call a library effect or describe this durable intent as Off/failed.
    const replacement = new ReachabilityOperations(root);
    const recovered = await replacement.read(started.operationId);
    assert.equal(recovered.stage, "unknown-possibly-live");
    assert.equal(recovered.handle, null);
    assert.equal((await replacement.list())[0]?.stage, "unknown-possibly-live");
    await replacement.requestStop(started.operationId);
    assert.equal((await new ReachabilityOperations(root).read(started.operationId)).stopTombstone, true);
    assert.deepEqual(recovered.recovery, { available: false, reason: "public_operation_recovery_unavailable" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

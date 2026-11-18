// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The console decides which connectors can enroll a local collector from the
 * server's connector templates. These tests pin that the answer follows the
 * connector's manifest and not a connector key.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { buildConnectionSetupPlan } from "pdpp-reference-implementation/connection-setup-plan";
import { resolveCommittedManifestsDirForTests } from "./connector-manifests-dir.ts";
import {
  type LocalCollectorTemplate,
  localCollectorEnrollmentKeys,
  resolveLocalCollectorEnrollmentKey,
} from "./local-collector-support.ts";

function enrollable(connectorKey: string, enrollmentKey: string): LocalCollectorTemplate {
  return {
    connector_key: connectorKey,
    setup_plan: { catalog_disposition: "local_collector_enroll", enrollment_key: enrollmentKey },
  };
}

test("a connector the server offers for enrollment resolves, whatever its key", () => {
  const templates = [enrollable("brand-new-notes-app", "brand-new-notes-app"), enrollable("claude-code", "claude-code")];
  assert.deepEqual(localCollectorEnrollmentKeys(templates), ["brand-new-notes-app", "claude-code"]);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "brand-new-notes-app"), "brand-new-notes-app");
});

test("a connector resolves by enrollment key, canonical key, or registry URL", () => {
  const templates = [enrollable("claude-code", "claude-code")];
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "claude-code"), "claude-code");
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "https://registry.pdpp.dev/connectors/claude-code"), "claude-code");
});

test("a connector without the local-collector-enroll disposition does not resolve", () => {
  const templates: LocalCollectorTemplate[] = [
    { connector_key: "amazon", setup_plan: { catalog_disposition: "browser_collector_manual", enrollment_key: "amazon" } },
    { connector_key: "signal", setup_plan: { catalog_disposition: "local_collector_unproven", enrollment_key: "signal" } },
    { connector_key: "no-plan" },
    { connector_key: "no-key", setup_plan: { catalog_disposition: "local_collector_enroll" } },
  ];
  assert.deepEqual(localCollectorEnrollmentKeys(templates), []);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "amazon"), null);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "signal"), null);
});

test("resolver rejects templates with no plan, no enrollment key, or a blank enrollment key", () => {
  const templates: LocalCollectorTemplate[] = [
    { connector_key: "no-plan" },
    { connector_key: "no-key", setup_plan: { catalog_disposition: "local_collector_enroll" } },
    { connector_key: "null-key", setup_plan: { catalog_disposition: "local_collector_enroll", enrollment_key: null } },
    { connector_key: "empty-key", setup_plan: { catalog_disposition: "local_collector_enroll", enrollment_key: "" } },
    { connector_key: "blank-key", setup_plan: { catalog_disposition: "local_collector_enroll", enrollment_key: "   " } },
  ];
  assert.deepEqual(localCollectorEnrollmentKeys(templates), []);
  for (const id of ["no-plan", "no-key", "null-key", "empty-key", "blank-key"]) {
    assert.equal(resolveLocalCollectorEnrollmentKey(templates, id), null, id);
    assert.equal(resolveLocalCollectorEnrollmentKey(templates, `https://registry.pdpp.dev/connectors/${id}`), null, id);
  }
});

test("canonical key and enrollment key are separate forms; an unadvertised alias does not resolve", () => {
  const templates = [enrollable("notes-app", "notes-collector")];
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "notes-collector"), "notes-collector");
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "notes-app"), "notes-collector");
  assert.equal(
    resolveLocalCollectorEnrollmentKey(templates, "https://registry.pdpp.dev/connectors/notes-app"),
    "notes-collector"
  );
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "notes"), null);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "notes-app-legacy"), null);
});

test("empty and missing ids do not resolve", () => {
  const templates = [enrollable("codex", "codex")];
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, ""), null);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "  "), null);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, null), null);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, undefined), null);
  assert.equal(resolveLocalCollectorEnrollmentKey([], "codex"), null);
});

test("the shipped manifests that claim local collection enroll, and the others do not", async () => {
  // Builds the same plans the server projects into its templates, from the
  // committed manifests. The enrollable set is whatever the manifests claim.
  const manifestsDir = resolveCommittedManifestsDirForTests();
  const files = (await readdir(manifestsDir)).filter((file) => file.endsWith(".json"));
  const templates: LocalCollectorTemplate[] = [];
  const claimed: string[] = [];
  for (const file of files) {
    const manifest = JSON.parse(await readFile(`${manifestsDir}/${file}`, "utf8"));
    const plan = buildConnectionSetupPlan({ manifest });
    templates.push({
      connector_id: manifest.connector_id,
      setup_plan: { catalog_disposition: plan.catalogDisposition, enrollment_key: plan.enrollmentKey ?? null },
    });
    if (manifest.capabilities?.proven?.local_collector === true) {
      claimed.push(plan.enrollmentKey ?? "");
    }
  }
  const keys = localCollectorEnrollmentKeys(templates);
  assert.deepEqual([...keys].sort(), [...claimed].sort());
  for (const expected of ["claude-code", "codex", "google-takeout", "imessage", "apple-photos", "google-messages"]) {
    assert.ok(keys.includes(expected), `${expected} must be enrollable`);
  }
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "amazon"), null);
  assert.equal(resolveLocalCollectorEnrollmentKey(templates, "signal"), null);
});

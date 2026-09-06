// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fleet-wide fail-before test for the systemic defect this closes: setup
 * classification (`connection-setup-plan.ts`'s manifest-driven
 * `isStaticSecretConnector`) and runtime injection
 * (`static-secret-injection.ts`'s generated-registry-driven
 * `isStaticSecretConnector`) must agree for every shipped manifest AND for a
 * synthetic new one — not just the manifests that happened to exist when
 * someone last remembered to update both.
 *
 * Before the fix, venmo.json declared `setup.modality: "static_secret"` (setup
 * recognized it), but `STATIC_SECRET_CONNECTOR_REGISTRY` — a hand-maintained
 * connector-id map runtime injection consulted independently — had no venmo
 * entry, so every run silently refused to inject a credential and reported
 * `interaction_required` forever. This test would have failed red on that
 * state: venmo would appear in `setupSaysYes` but not `runtimeSaysYes`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPolyfillManifests } from "@pdpp/polyfill-connectors/manifests";
import {
  type ConnectorManifestLike,
  isStaticSecretConnector as isStaticSecretConnectorForSetup,
} from "../server/connection-setup-plan.ts";

const LABEL_DIAGNOSTIC = /label/i;
const ENV_DIAGNOSTIC = /env/i;

/** Writes every manifest `@pdpp/polyfill-connectors` ships into `scratchDir`,
 * so a test can seed a scratch manifest directory (for
 * `PDPP_POLYFILL_MANIFESTS_DIR`-overridden regeneration) that starts from the
 * real shipped set. */
function seedScratchDirWithShippedManifests(scratchDir: string): void {
  for (const entry of readPolyfillManifests()) {
    writeFileSync(join(scratchDir, entry.file), JSON.stringify(entry.manifest));
  }
}

function connectorKeyOf(manifest: ConnectorManifestLike): string | null {
  return manifest.connector_key?.trim() || manifest.connector_id?.trim() || null;
}

test("every shipped manifest: setup's isStaticSecretConnector and runtime injection's isStaticSecretConnector agree", async () => {
  const { isStaticSecretConnector: isStaticSecretConnectorForInjection } = await import(
    "@pdpp/polyfill-connectors/static-secret-injection"
  );
  const entries = readPolyfillManifests();
  assert.ok(entries.length > 0, "expected at least one shipped connector manifest");

  const disagreements: string[] = [];
  for (const entry of entries) {
    const manifest = entry.manifest as ConnectorManifestLike;
    const connectorKey = connectorKeyOf(manifest);
    if (!connectorKey) {
      continue;
    }
    const setupSaysYes = isStaticSecretConnectorForSetup(connectorKey, manifest);
    const runtimeSaysYes = isStaticSecretConnectorForInjection(connectorKey);
    if (setupSaysYes !== runtimeSaysYes) {
      disagreements.push(`${connectorKey}: setup=${setupSaysYes} runtime=${runtimeSaysYes}`);
    }
  }
  assert.deepEqual(
    disagreements,
    [],
    `setup and runtime static-secret classification disagree for: ${disagreements.join(", ")} — this is exactly ` +
      "the venmo onboarding gap (setup recognized it, runtime injection's hand-maintained registry did not)"
  );
});

test("venmo specifically: setup and runtime agree it is a static-secret connector (regression for the fixed gap)", async () => {
  const { isStaticSecretConnector: isStaticSecretConnectorForInjection } = await import(
    "@pdpp/polyfill-connectors/static-secret-injection"
  );
  const venmoEntry = readPolyfillManifests().find((candidate) => candidate.file === "venmo.json");
  if (!venmoEntry) {
    throw new Error("no polyfill manifest found for venmo.json");
  }
  const manifest = venmoEntry.manifest as ConnectorManifestLike;
  assert.equal(isStaticSecretConnectorForSetup("venmo", manifest), true);
  assert.equal(isStaticSecretConnectorForInjection("venmo"), true);
});

test("password-without-secret probe: setup and runtime agree it is static-secret (closes F1 — the shape that let the pre-shared-normalizer parity test pass while setup and the generator disagreed)", async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-authority-parity-pwtype-"));
  const probeKey = "zzz-test-authority-parity-pwtype";
  try {
    seedScratchDirWithShippedManifests(scratchDir);
    // No explicit secret:true — only type:"password". Before the shared
    // normalizer, setup's normalizeStaticSecretFieldType treated this as
    // secret while the generator's normalizeField (secret === true only) did
    // not, so this exact shape would satisfy setup and vanish from the
    // generated runtime registry.
    const probeManifest: ConnectorManifestLike = {
      connector_id: `https://registry.pdpp.dev/connectors/${probeKey}`,
      connector_key: probeKey,
      display_name: "Authority Parity Probe — password type implies secret (test fixture, not a real connector)",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: {
        credential_capture: {
          fields: [
            { env: ["ZZZ_TEST_AUTHORITY_PARITY_PWTYPE_TOKEN"], label: "Probe token", name: "secret", type: "password" },
          ],
          kind: "api_key",
          label: "Probe token",
        },
        modality: "static_secret",
      },
    };
    writeFileSync(join(scratchDir, `${probeKey}.json`), JSON.stringify(probeManifest, null, 2));

    assert.equal(
      isStaticSecretConnectorForSetup(probeKey, probeManifest),
      true,
      'setup must classify a type:"password" field as secret even without secret:true'
    );

    const { execFileSync } = await import("node:child_process");
    // Resolved from the installed @pdpp/polyfill-connectors package (never a
    // hardcoded relative repo path). data-connectors#68 ships this script
    // compiled (scripts/generate-static-secret-registry.js, in place next to
    // the .ts source) specifically so it can be spawned as a real subprocess
    // once vendored into a consumer's node_modules — spawn the compiled
    // output directly, no TS loader needed.
    const packageDir = join(
      dirname(fileURLToPath(import.meta.resolve("@pdpp/polyfill-connectors/manifests"))),
      ".."
    );
    const outPath = join(scratchDir, "static-secret-registry.pwtype-probe.generated.ts");
    execFileSync(
      "node",
      [join(packageDir, "scripts/generate-static-secret-registry.js"), outPath],
      { cwd: packageDir, env: { ...process.env, PDPP_POLYFILL_MANIFESTS_DIR: scratchDir }, stdio: "pipe" }
    );
    const generatedSource = readFileSync(outPath, "utf8");
    assert.ok(
      generatedSource.includes(JSON.stringify(probeKey)),
      'runtime injection\'s generated registry must recognize a type:"password" field as secret too — the shared ' +
        "normalizer, not two independent predicates, decides this"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("missing-label probe: a secret field with no label fails manifest generation with a diagnostic instead of setup and runtime silently disagreeing (closes F2)", async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-authority-parity-nolabel-"));
  const probeKey = "zzz-test-authority-parity-nolabel";
  try {
    seedScratchDirWithShippedManifests(scratchDir);
    // Before the shared normalizer, setup silently dropped a label-less
    // secret field (returning null / not-static-secret) while the generator
    // kept it (no label requirement at all) — runtime would inject a
    // credential setup could never collect. Now both sides call the same
    // normalizer, which throws instead of silently disagreeing.
    const probeManifest = {
      connector_id: `https://registry.pdpp.dev/connectors/${probeKey}`,
      connector_key: probeKey,
      display_name: "Authority Parity Probe — secret field missing label (test fixture, not a real connector)",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: {
        credential_capture: {
          fields: [{ env: ["ZZZ_TEST_AUTHORITY_PARITY_NOLABEL_TOKEN"], name: "secret", secret: true }],
          kind: "api_key",
          label: "Probe token",
        },
        modality: "static_secret",
      },
    };
    writeFileSync(join(scratchDir, `${probeKey}.json`), JSON.stringify(probeManifest, null, 2));

    assert.throws(
      () => isStaticSecretConnectorForSetup(probeKey, probeManifest as ConnectorManifestLike),
      LABEL_DIAGNOSTIC,
      "setup must fail loud on a secret field with no label, not silently classify the connector as non-static-secret"
    );

    const { execFileSync } = await import("node:child_process");
    // Resolved from the installed @pdpp/polyfill-connectors package (never a
    // hardcoded relative repo path). data-connectors#68 ships this script
    // compiled (scripts/generate-static-secret-registry.js, in place next to
    // the .ts source) specifically so it can be spawned as a real subprocess
    // once vendored into a consumer's node_modules — spawn the compiled
    // output directly, no TS loader needed.
    const packageDir = join(
      dirname(fileURLToPath(import.meta.resolve("@pdpp/polyfill-connectors/manifests"))),
      ".."
    );
    const outPath = join(scratchDir, "static-secret-registry.nolabel-probe.generated.ts");
    assert.throws(
      () =>
        execFileSync(
          "node",
          [join(packageDir, "scripts/generate-static-secret-registry.js"), outPath],
          { cwd: packageDir, env: { ...process.env, PDPP_POLYFILL_MANIFESTS_DIR: scratchDir }, stdio: "pipe" }
        ),
      LABEL_DIAGNOSTIC,
      "manifest generation must fail with a diagnostic naming the offending field, not silently ship a runtime " +
        "registry entry setup could never present a form for"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("empty-env probe: a secret field with zero env aliases fails manifest generation with a diagnostic (closes F4)", async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-authority-parity-emptyenv-"));
  const probeKey = "zzz-test-authority-parity-emptyenv";
  try {
    seedScratchDirWithShippedManifests(scratchDir);
    const probeManifest = {
      connector_id: `https://registry.pdpp.dev/connectors/${probeKey}`,
      connector_key: probeKey,
      display_name: "Authority Parity Probe — secret field with zero env aliases (test fixture, not a real connector)",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: {
        credential_capture: {
          fields: [{ env: [], label: "Probe token", name: "secret", secret: true }],
          kind: "api_key",
          label: "Probe token",
        },
        modality: "static_secret",
      },
    };
    writeFileSync(join(scratchDir, `${probeKey}.json`), JSON.stringify(probeManifest, null, 2));

    assert.throws(
      () => isStaticSecretConnectorForSetup(probeKey, probeManifest as ConnectorManifestLike),
      ENV_DIAGNOSTIC,
      "setup must fail loud on a secret field with zero env aliases, since it would never be injectable at runtime"
    );

    const { execFileSync } = await import("node:child_process");
    // Resolved from the installed @pdpp/polyfill-connectors package (never a
    // hardcoded relative repo path). data-connectors#68 ships this script
    // compiled (scripts/generate-static-secret-registry.js, in place next to
    // the .ts source) specifically so it can be spawned as a real subprocess
    // once vendored into a consumer's node_modules — spawn the compiled
    // output directly, no TS loader needed.
    const packageDir = join(
      dirname(fileURLToPath(import.meta.resolve("@pdpp/polyfill-connectors/manifests"))),
      ".."
    );
    const outPath = join(scratchDir, "static-secret-registry.emptyenv-probe.generated.ts");
    assert.throws(
      () =>
        execFileSync(
          "node",
          [join(packageDir, "scripts/generate-static-secret-registry.js"), outPath],
          { cwd: packageDir, env: { ...process.env, PDPP_POLYFILL_MANIFESTS_DIR: scratchDir }, stdio: "pipe" }
        ),
      ENV_DIAGNOSTIC,
      "manifest generation must fail with a diagnostic naming the offending field, never silently emit an " +
        "unreachable secretEnvVars: []"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

test("fail-before counterweight: a synthetic new static-secret manifest is recognized by BOTH setup and runtime with no code change beyond adding the manifest", async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "static-secret-authority-parity-probe-"));
  const probeKey = "zzz-test-authority-parity-probe";
  try {
    seedScratchDirWithShippedManifests(scratchDir);
    const probeManifest: ConnectorManifestLike = {
      connector_id: `https://registry.pdpp.dev/connectors/${probeKey}`,
      connector_key: probeKey,
      display_name: "Authority Parity Probe (test fixture, not a real connector)",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: {
        credential_capture: {
          fields: [
            {
              env: ["ZZZ_TEST_AUTHORITY_PARITY_PROBE_TOKEN"],
              label: "Probe token",
              name: "secret",
              required: true,
              secret: true,
              type: "password",
            },
          ],
          kind: "api_key",
          label: "Probe token",
        },
        modality: "static_secret",
      },
    };
    writeFileSync(join(scratchDir, `${probeKey}.json`), JSON.stringify(probeManifest, null, 2));

    // Setup reads this exact manifest object directly — no filesystem needed.
    assert.equal(isStaticSecretConnectorForSetup(probeKey, probeManifest), true);

    // Runtime injection must regenerate its registry from a manifest
    // directory that includes the probe to pick it up — proving the
    // authority is the manifest, not a hand-maintained list this test would
    // otherwise have to remember to update too.
    const { execFileSync } = await import("node:child_process");
    // Resolved from the installed @pdpp/polyfill-connectors package (never a
    // hardcoded relative repo path). data-connectors#68 ships this script
    // compiled (scripts/generate-static-secret-registry.js, in place next to
    // the .ts source) specifically so it can be spawned as a real subprocess
    // once vendored into a consumer's node_modules — spawn the compiled
    // output directly, no TS loader needed.
    const packageDir = join(
      dirname(fileURLToPath(import.meta.resolve("@pdpp/polyfill-connectors/manifests"))),
      ".."
    );
    const outPath = join(scratchDir, "static-secret-registry.probe.generated.ts");
    execFileSync(
      "node",
      [join(packageDir, "scripts/generate-static-secret-registry.js"), outPath],
      { cwd: packageDir, env: { ...process.env, PDPP_POLYFILL_MANIFESTS_DIR: scratchDir }, stdio: "pipe" }
    );
    const generatedSource = readFileSync(outPath, "utf8");
    assert.ok(
      generatedSource.includes(JSON.stringify(probeKey)),
      "runtime injection's generated registry must include a manifest-declared static-secret connector with no " +
        "hand-edit — regenerating from a manifest directory that includes it must be sufficient"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});

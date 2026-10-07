// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The collector installs its connectors from pinned, signed Collection
 * Profiles. These tests cover the pins themselves, the install store around
 * the installer core, and the CLI seam that installs before a run.
 *
 * The installer core is replaced by a fake here: its OCI and Sigstore checks
 * are data-connectors' tests to own, and pack-install-run exercises the real
 * one against GHCR. Set PDPP_TEST_LIVE_COLLECTION_PROFILES=1 to also install
 * a real pin from GHCR in this file.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { parseArgs, prepareConnectorSpec } from "../bin/pdpp-local-collector.ts";
import { ALLOW_CUSTOM_COMMAND_ENV } from "../src/errors.ts";
import { COLLECTION_PROFILE_PINS } from "../src/generated/collection-profile-pins.generated.ts";
import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/generated/collector-definitions.generated.ts";
import {
  type CollectionProfileInstallerCore,
  type CollectionProfilePin,
  ensureCollectionProfileInstalled,
  installedCollectionProfile,
} from "../src/managed/collection-profiles.ts";

const REFERENCE_PROFILE_DIR = new URL("../../../reference-implementation/server/local-collector-profiles/", import.meta.url);

const scratch = mkdtempSync(join(tmpdir(), "pdpp-collection-profiles-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface ReferencePin {
  readonly connector_key: string;
  readonly digest: string;
  readonly profile_sha256: string;
  readonly version: string;
}

function readReferencePin(connectorKey: string): ReferencePin {
  return JSON.parse(readFileSync(new URL(`${connectorKey}.pin.json`, REFERENCE_PROFILE_DIR), "utf8")) as ReferencePin;
}

function readReferenceProfile(connectorKey: string): { runtime_requirements: { bindings: Record<string, { required: boolean }> }; connector_key: string; version: string } {
  return JSON.parse(readFileSync(new URL(`${connectorKey}.json`, REFERENCE_PROFILE_DIR), "utf8"));
}

test("the reference server's profiles are the collector's pins, byte for byte", () => {
  for (const pin of COLLECTION_PROFILE_PINS) {
    assert.deepEqual(readReferencePin(pin.connectorKey), {
      connector_key: pin.connectorKey,
      version: pin.version,
      digest: pin.digest,
      profile_sha256: pin.profileSha256,
    });
    const bytes = readFileSync(new URL(`${pin.connectorKey}.json`, REFERENCE_PROFILE_DIR));
    assert.equal(sha256(bytes), pin.profileSha256, `${pin.connectorKey}.json`);
  }
  const files = readdirSync(REFERENCE_PROFILE_DIR).sort();
  assert.deepEqual(
    files,
    COLLECTION_PROFILE_PINS.flatMap((pin) => [`${pin.connectorKey}.json`, `${pin.connectorKey}.pin.json`]).sort()
  );
});

test("pins follow definition order and name only defined connectors", () => {
  const definitionOrder = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definition.connector_id);
  const pinned = COLLECTION_PROFILE_PINS.map((pin) => pin.connectorId);
  assert.deepEqual(
    pinned,
    definitionOrder.filter((id) => pinned.includes(id))
  );
  for (const pin of COLLECTION_PROFILE_PINS) {
    assert.equal(pin.connectorKey, pin.connectorId.replaceAll("_", "-"));
  }
});

test("each pinned profile is the release it pins and declares its definition's bindings", () => {
  for (const pin of COLLECTION_PROFILE_PINS) {
    const definition = LOCAL_COLLECTOR_DEFINITIONS.find((candidate) => candidate.connector_id === pin.connectorId);
    assert.ok(definition, pin.connectorId);
    const profile = readReferenceProfile(pin.connectorKey);
    assert.equal(profile.connector_key, pin.connectorKey);
    assert.equal(profile.version, pin.version);
    for (const [name, binding] of Object.entries(definition.bindings)) {
      assert.equal(
        profile.runtime_requirements.bindings[name]?.required,
        binding.required,
        `${pin.connectorId} binding ${name}`
      );
    }
  }
});

test("the collector build compiles no connector code", () => {
  const tsconfig = readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8");
  assert.doesNotMatch(tsconfig, /polyfill-connectors\/(connectors|src)/);
});

// --- install store -----------------------------------------------------------

const PROFILE_BYTES = `${JSON.stringify({ connector_key: "fake-connector", version: "1.0.0" })}\n`;
const ENTRYPOINT_BYTES = "console.log('fake connector');\n";

function fakePin(overrides: Partial<CollectionProfilePin> = {}): CollectionProfilePin {
  return {
    connectorId: "fake_connector",
    connectorKey: "fake-connector",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    profileSha256: sha256(PROFILE_BYTES),
    entrypointSha256: sha256(ENTRYPOINT_BYTES),
    ...overrides,
  };
}

interface FakeCore extends CollectionProfileInstallerCore {
  readonly calls: Record<string, unknown>[];
}

function fakeCore(write: (connectorRoot: string) => void = writeGoodRelease, fail?: Error): FakeCore {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY: "https://example.test/publish.yml@refs/heads/main",
    installFromLock(options) {
      calls.push(options);
      if (fail) {
        return Promise.reject(fail);
      }
      const lock = options.lock as { connectors: { connectorId: string }[] };
      write(join(options.installRoot as string, "collection-profiles", lock.connectors[0]?.connectorId ?? ""));
      return Promise.resolve({});
    },
  };
}

function writeGoodRelease(connectorRoot: string): void {
  mkdirSync(join(connectorRoot, "profile"), { recursive: true });
  mkdirSync(join(connectorRoot, "dist"), { recursive: true });
  writeFileSync(join(connectorRoot, "profile", "collection-profile.json"), PROFILE_BYTES);
  writeFileSync(join(connectorRoot, "dist", "collection-profile.mjs"), ENTRYPOINT_BYTES);
  writeFileSync(join(connectorRoot, "provenance.json"), "{}\n");
}

function roots(name: string): { installRoot: string; durableRoot: string } {
  const base = join(scratch, name);
  return { installRoot: join(base, "collection-profiles"), durableRoot: join(base, "collectors") };
}

function leftovers(installRoot: string): string[] {
  const connectorDir = join(installRoot, "connectors", "fake-connector");
  return existsSync(connectorDir) ? readdirSync(connectorDir).filter((name) => name.includes(".staging-")) : [];
}

test("a fresh install lands the pinned files under the digest directory and passes the pin to the core", async () => {
  const { installRoot, durableRoot } = roots("fresh");
  const core = fakeCore();
  const release = await ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => core });

  assert.equal(release.entrypoint, installedCollectionProfile(installRoot, fakePin()).entrypoint);
  assert.equal(readFileSync(release.entrypoint, "utf8"), ENTRYPOINT_BYTES);
  assert.deepEqual(leftovers(installRoot), []);

  assert.equal(core.calls.length, 1);
  const call = core.calls[0] as {
    lock: { connectors: { oci: unknown; version: string; artifactKind: string }[] };
    ociCertificateIdentityResolver: (input: { registry: string; repository: string }) => string | null;
    artifactCertificateIdentityResolver: () => unknown;
  };
  assert.deepEqual(call.lock.connectors[0]?.oci, {
    digest: fakePin().digest,
    registry: "ghcr.io",
    repository: "pdp-connect/connector/fake-connector",
  });
  assert.equal(call.lock.connectors[0]?.version, "1.0.0");
  assert.equal(call.lock.connectors[0]?.artifactKind, "pdpp-collection-profile");
  assert.equal(
    call.ociCertificateIdentityResolver({ registry: "ghcr.io", repository: "pdp-connect/connector/fake-connector" }),
    core.DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY
  );
  assert.equal(call.ociCertificateIdentityResolver({ registry: "ghcr.io", repository: "pdp-connect/connector/other" }), null);
  assert.equal(call.ociCertificateIdentityResolver({ registry: "docker.io", repository: "pdp-connect/connector/fake-connector" }), null);
  assert.equal(call.artifactCertificateIdentityResolver(), null);
});

test("a cached release that matches its pin is used without the network", async () => {
  const { installRoot, durableRoot } = roots("cached");
  await ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => fakeCore() });
  const second = fakeCore(undefined, new Error("the network must not be touched"));
  const release = await ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => second });
  assert.equal(second.calls.length, 0);
  assert.equal(readFileSync(release.entrypoint, "utf8"), ENTRYPOINT_BYTES);
});

test("a modified cached release is moved aside and installed again", async () => {
  const { installRoot, durableRoot } = roots("tampered");
  const release = await ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => fakeCore() });
  writeFileSync(release.entrypoint, "console.log('not the pinned bytes');\n");

  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.message);
  process.on("warning", onWarning);
  const core = fakeCore();
  try {
    await ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => core });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", onWarning);
  }

  assert.equal(core.calls.length, 1);
  assert.equal(readFileSync(release.entrypoint, "utf8"), ENTRYPOINT_BYTES);
  const aside = readdirSync(join(installRoot, "connectors", "fake-connector")).filter((name) => name.includes(".invalid-"));
  assert.equal(aside.length, 1);
  assert.ok(warnings.some((message) => message.includes("did not match its pin")));
});

test("a verified artifact whose files differ from the pin is refused and leaves nothing installed", async () => {
  const { installRoot, durableRoot } = roots("pin-mismatch");
  const core = fakeCore((connectorRoot) => {
    writeGoodRelease(connectorRoot);
    writeFileSync(join(connectorRoot, "dist", "collection-profile.mjs"), "console.log('other release');\n");
  });
  await assert.rejects(
    ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => core }),
    /does not match its pin: entrypoint/
  );
  assert.equal(existsSync(installedCollectionProfile(installRoot, fakePin()).directory), false);
  assert.deepEqual(leftovers(installRoot), []);
});

test("an installer core refusal (for example a bad signature) propagates and leaves nothing installed", async () => {
  const { installRoot, durableRoot } = roots("refused");
  const core = fakeCore(undefined, new Error("signature was not made by the pinned identity"));
  await assert.rejects(
    ensureCollectionProfileInstalled({ pin: fakePin(), installRoot, durableRoot, loadCore: async () => core }),
    /signature was not made by the pinned identity/
  );
  assert.equal(existsSync(installedCollectionProfile(installRoot, fakePin()).directory), false);
  assert.deepEqual(leftovers(installRoot), []);
});

test("an install store inside the durable root is refused before anything is fetched", async () => {
  const base = join(scratch, "nested");
  const core = fakeCore();
  await assert.rejects(
    ensureCollectionProfileInstalled({
      pin: fakePin(),
      installRoot: join(base, "collectors", "profiles"),
      durableRoot: join(base, "collectors"),
      loadCore: async () => core,
    })
  );
  assert.equal(core.calls.length, 0);
});

test("a malformed pin is refused before anything is fetched", async () => {
  const { installRoot, durableRoot } = roots("bad-pin");
  const core = fakeCore();
  await assert.rejects(
    ensureCollectionProfileInstalled({ pin: fakePin({ digest: "latest" }), installRoot, durableRoot, loadCore: async () => core }),
    /invalid digest/
  );
  assert.equal(core.calls.length, 0);
});

// --- CLI seam ----------------------------------------------------------------

const RUN_ARGS = ["run", "--base-url", "http://127.0.0.1:7662", "--device-id", "d", "--device-token", "t", "--connection-id", "c"];

test("prepareConnectorSpec installs the pinned profile before a pinned connector runs", async () => {
  const installed: CollectionProfilePin[] = [];
  const spec = await prepareConnectorSpec(parseArgs([...RUN_ARGS, "--connector", "codex"]), async (options) => {
    installed.push(options.pin);
    return installedCollectionProfile(options.installRoot, options.pin);
  });
  assert.deepEqual(
    installed.map((pin) => pin.connectorId),
    ["codex"]
  );
  const pin = installed[0] as CollectionProfilePin;
  assert.ok(
    (spec.args[0] as string).endsWith(join("connectors", "codex", pin.digest.replace(":", "-"), "dist", "collection-profile.mjs")),
    String(spec.args[0])
  );
});

test("prepareConnectorSpec installs nothing for a custom --command", async () => {
  const previous = process.env[ALLOW_CUSTOM_COMMAND_ENV];
  process.env[ALLOW_CUSTOM_COMMAND_ENV] = "1";
  try {
    let calls = 0;
    await prepareConnectorSpec(
      parseArgs([...RUN_ARGS, "--connector", "codex", "--command", process.execPath, "--args", "/tmp/fixture.mjs"]),
      async (options) => {
        calls += 1;
        return installedCollectionProfile(options.installRoot, options.pin);
      }
    );
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) {
      delete process.env[ALLOW_CUSTOM_COMMAND_ENV];
    } else {
      process.env[ALLOW_CUSTOM_COMMAND_ENV] = previous;
    }
  }
});

test(
  "live: the claude_code pin installs from GHCR through the real installer core",
  { skip: process.env.PDPP_TEST_LIVE_COLLECTION_PROFILES === "1" ? false : "set PDPP_TEST_LIVE_COLLECTION_PROFILES=1" },
  async () => {
    const pin = COLLECTION_PROFILE_PINS.find((candidate) => candidate.connectorId === "claude_code");
    assert.ok(pin);
    const { installRoot, durableRoot } = roots("live");
    const release = await ensureCollectionProfileInstalled({ pin, installRoot, durableRoot });
    assert.equal(sha256(readFileSync(release.entrypoint)), pin.entrypointSha256);
  }
);

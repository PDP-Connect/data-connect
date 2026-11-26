// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The verified Core source declaration reaches registration through the install record.
 *
 * `normalizeCoreInstallLayout` moves the verified `source-declaration.json` into the install root. The
 * install record must bind that file's digest, and registration must read the declaration from the
 * verified record, not from the profile alone. These tests drive the real install service with a
 * trusted verified-layout artifact through its installation seam (`installArtifact`, which stands in for
 * the pinned OCI verifier); they do not exercise signatures. Registration here is a collector; the real
 * registry and activation journey is covered by connector-install-registry-integration.test.ts.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ConnectorCatalogEntry,
  type ConnectorInstallStore,
  createConnectorInstallService,
  createFileConnectorInstallStore,
  inspectActiveConnector,
} from "../server/connector-install/index.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";
import { readCollectionProfileFixture } from "./helpers/installed-collection-profiles.ts";

const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;
const SLUG = "fixture-oci-custom";
const INTEGRITY_REFUSAL = /source declaration bytes failed integrity verification/;
const SIDECAR_REFUSAL = /source declaration|Invalid SourceDeclaration/i;
const CONFLICT_REFUSAL = /conflicts with the verified source declaration/;
const SIDECAR_INVALID = /Verified source declaration is invalid/;
const PROFILE_TOO_LARGE = /Connector profile exceeds the 1 MiB RI limit/;
const REGISTRATION_REFUSED = /registration refused/;
const PINNED_SIDECAR_MISSING = /Verified source declaration is missing/;
const PINNED_SIDECAR_MISMATCH = /does not match installer-core verification/;
const MIB = 1024 * 1024;

interface Layout {
  readonly entry: ConnectorCatalogEntry;
  readonly install?: (root: string) => void;
  /**
   * Set for a pinned install: the source-declaration bytes the pinned installer core verified. The installer
   * reports their digest, and the sidecar on disk (`sidecar`) may then differ or be absent.
   */
  readonly pinnedDeclaration?: string;
  readonly profileBytes: string;
  readonly sidecar: string | null;
}

/** A signed-shape profile (streams and capabilities from the github fixture), re-keyed to a custom slug. */
function profileFixture(version = "1.0.0"): Record<string, unknown> {
  return {
    ...readCollectionProfileFixture("github"),
    connector_id: SLUG,
    connector_key: SLUG,
    manifest_uri: `https://registry.pdpp.dev/connectors/${SLUG}`,
    version,
  };
}

function declarationOf(manifest: Record<string, unknown>): Record<string, unknown> {
  const declared = withFixtureSourceDeclaration(manifest) as Record<string, unknown>;
  return declared.source_declaration as Record<string, unknown>;
}

function entryFor(bytes: string): ConnectorCatalogEntry {
  return {
    config_digest: CONFIG_DIGEST,
    connector_id: SLUG,
    connector_key: SLUG,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    tier: "supported",
    version: "1.0.0",
  };
}

/** A layout whose catalog entry digests the profile bytes it installs, so the two can never disagree. */
function layoutOf(
  profile: Record<string, unknown>,
  sidecar: string | null = JSON.stringify(declarationOf(profile), null, 2)
): Layout {
  const profileBytes = JSON.stringify(profile, null, 2);
  return { entry: entryFor(profileBytes), profileBytes, sidecar };
}

/** Writes the layout that `normalizeCoreInstallLayout` produces: profile, dist, provenance, sidecar. */
function writeVerifiedLayout(root: string, profileBytes: string, sidecarBytes: string | null): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "profile", "collection-profile.json"), profileBytes);
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
  if (sidecarBytes !== null) {
    writeFileSync(join(root, "source-declaration.json"), sidecarBytes);
  }
}

/** The real install service over a durable store, with a collector in place of the registry. */
function serviceOver(
  dataDir: string,
  store: ConnectorInstallStore,
  layouts: readonly Layout[],
  options: { readonly failRegistrationOn?: number } = {}
) {
  const registered: Record<string, unknown>[] = [];
  const service = createConnectorInstallService({
    catalogLoader: async () => layouts.map((layout) => layout.entry),
    dataDir,
    installArtifact: (root, entry) => {
      const layout = layouts.find((candidate) => candidate.entry.digest === entry.digest);
      if (!layout) {
        throw new Error("no fixture layout for the requested digest");
      }
      if (layout.install) {
        layout.install(root);
      } else {
        writeVerifiedLayout(root, layout.profileBytes, layout.sidecar);
      }
      return layout.pinnedDeclaration === undefined
        ? undefined
        : { configDigest: CONFIG_DIGEST, sourceDeclarationSha256: digestOfText(layout.pinnedDeclaration) };
    },
    registerManifest: (manifest) => {
      registered.push(manifest);
      if (options.failRegistrationOn === registered.length) {
        return Promise.reject(new Error("registration refused (test)"));
      }
      return Promise.resolve();
    },
    store,
  });
  return { registered, service };
}

function harness(dataDir: string, layout: Layout) {
  const store = createFileConnectorInstallStore(dataDir);
  const { registered, service } = serviceOver(dataDir, store, [layout]);
  return { entry: layout.entry, registered, service, store };
}

function sidecarOf(declaration: Record<string, unknown>): string {
  return JSON.stringify(declaration, null, 2);
}

function digestOfText(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Fails only the first lstat of the staged `source-declaration.json` with EIO. Every other filesystem call
 * is the real one. The builtin export is swapped through the CJS object and resynced; callers restore it.
 */
function injectFirstSidecarStatEio(): { readonly faults: () => number; readonly restore: () => void } {
  const realLstat = fs.lstatSync;
  let faults = 0;
  fs.lstatSync = ((path: fs.PathLike, options?: fs.StatOptions) => {
    if (faults === 0 && String(path).endsWith("/next/source-declaration.json")) {
      faults += 1;
      throw Object.assign(new Error(`EIO: i/o error, lstat '${String(path)}'`), {
        code: "EIO",
        errno: -5,
        path: String(path),
        syscall: "lstat",
      });
    }
    return realLstat(path, options as never);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  return {
    faults: () => faults,
    restore: () => {
      fs.lstatSync = realLstat;
      syncBuiltinESMExports();
    },
  };
}

test("the verified source declaration reaches registration from the install record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-"));
  try {
    const profile = profileFixture();
    const declaration = declarationOf(profile);
    const { entry, registered, service, store } = harness(dataDir, layoutOf(profile, sidecarOf(declaration)));

    const record = await service.install(entry.connector_id, entry.digest);

    assert.equal(registered.length, 1);
    assert.notEqual(registered[0]?.source_declaration, undefined, "registration received no source declaration");
    assert.deepEqual(registered[0]?.source_declaration, declaration);
    assert.deepEqual(record.manifest.source_declaration, declaration);
    const inspected = await inspectActiveConnector(store, SLUG);
    assert.equal(inspected.status, "active");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a modified source declaration sidecar is refused on read verification", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-tamper-"));
  try {
    const profile = profileFixture();
    const { entry, service, store } = harness(dataDir, layoutOf(profile, sidecarOf(declarationOf(profile))));
    const record = await service.install(entry.connector_id, entry.digest);

    writeFileSync(join(record.root, "source-declaration.json"), '{"source":"changed"}\n');

    const inspected = await inspectActiveConnector(store, SLUG);
    assert.ok(inspected.status === "invalid");
    assert.match(inspected.reason, INTEGRITY_REFUSAL);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a missing source declaration sidecar is refused on read verification", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-missing-"));
  try {
    const profile = profileFixture();
    const { entry, service, store } = harness(dataDir, layoutOf(profile, sidecarOf(declarationOf(profile))));
    const record = await service.install(entry.connector_id, entry.digest);

    rmSync(join(record.root, "source-declaration.json"));

    const inspected = await inspectActiveConnector(store, SLUG);
    assert.ok(inspected.status === "invalid");
    assert.match(inspected.reason, INTEGRITY_REFUSAL);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a symlinked source declaration sidecar is refused before publication", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-outside-"));
  try {
    const profile = profileFixture();
    const profileBytes = JSON.stringify(profile, null, 2);
    const declarationPath = join(outside, "declaration.json");
    writeFileSync(declarationPath, sidecarOf(declarationOf(profile)));
    const layout: Layout = {
      entry: entryFor(profileBytes),
      install: (root) => {
        writeVerifiedLayout(root, profileBytes, null);
        symlinkSync(declarationPath, join(root, "source-declaration.json"));
      },
      profileBytes,
      sidecar: null,
    };
    const { entry, registered, service, store } = harness(dataDir, layout);

    await assert.rejects(() => service.install(entry.connector_id, entry.digest), SIDECAR_REFUSAL);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a profile that embeds a conflicting source declaration is refused before publication", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-conflict-"));
  try {
    // The catalog digests the embedded profile that is actually installed (version 2.0.0), so the refusal
    // is the intended conflict between the embedded declaration and the sidecar, not a digest mismatch.
    const sidecarDeclaration = declarationOf(profileFixture());
    const embedded = withFixtureSourceDeclaration({ ...profileFixture("2.0.0"), version: "2.0.0" });
    const layout = layoutOf(embedded, sidecarOf(sidecarDeclaration));
    const { entry, registered, service, store } = harness(dataDir, layout);

    await assert.rejects(() => service.install(entry.connector_id, entry.digest), CONFLICT_REFUSAL);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("same-digest reuse re-registers the verified declaration and keeps the recorded sidecar digest", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-reuse-"));
  try {
    const profile = profileFixture();
    const declaration = declarationOf(profile);
    const { entry, registered, service } = harness(dataDir, layoutOf(profile, sidecarOf(declaration)));
    const first = await service.install(entry.connector_id, entry.digest);
    assert.equal(typeof first.sourceDeclarationSha256, "string", "the install record binds the sidecar digest");

    const second = await service.install(entry.connector_id, entry.digest);

    assert.equal(registered.length, 2, "reuse re-registers the verified manifest");
    assert.deepEqual(registered[1]?.source_declaration, declaration);
    assert.equal(second.sourceDeclarationSha256, first.sourceDeclarationSha256);
    assert.equal(second.manifestSha256, first.manifestSha256, "the raw profile bytes and hash are unchanged");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("restart: a new store instance and a new service read the same declaration from the record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-restart-"));
  try {
    const profile = profileFixture();
    const declaration = declarationOf(profile);
    const layout = layoutOf(profile, sidecarOf(declaration));
    const first = harness(dataDir, layout);
    const installed = await first.service.install(SLUG, layout.entry.digest);

    const restartedStore = createFileConnectorInstallStore(dataDir);
    const inspected = await inspectActiveConnector(restartedStore, SLUG);
    assert.equal(inspected.status, "active");
    assert.equal(inspected.record.sourceDeclarationSha256, installed.sourceDeclarationSha256);
    assert.deepEqual(inspected.record.manifest.source_declaration, declaration);

    const restarted = serviceOver(dataDir, restartedStore, [layout]);
    const reinstalled = await restarted.service.install(SLUG, layout.entry.digest);
    assert.deepEqual(restarted.registered[0]?.source_declaration, declaration);
    assert.equal(reinstalled.sourceDeclarationSha256, installed.sourceDeclarationSha256);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("restart: a sidecar tampered while stopped is refused and no tampered bytes are registered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-restart-tamper-"));
  try {
    const profile = profileFixture();
    const declaration = declarationOf(profile);
    const layout = layoutOf(profile, sidecarOf(declaration));
    const first = harness(dataDir, layout);
    const installed = await first.service.install(SLUG, layout.entry.digest);
    writeFileSync(join(installed.root, "source-declaration.json"), '{"source":"tampered"}\n');

    const restartedStore = createFileConnectorInstallStore(dataDir);
    const inspected = await inspectActiveConnector(restartedStore, SLUG);
    assert.equal(inspected.status, "invalid");
    assert.match(inspected.reason, INTEGRITY_REFUSAL);

    const restarted = serviceOver(dataDir, restartedStore, [layout]);
    await restarted.service.install(SLUG, layout.entry.digest);
    assert.ok(restarted.registered.length >= 1);
    for (const manifest of restarted.registered) {
      assert.deepEqual(manifest.source_declaration, declaration, "only the verified declaration is registered");
    }
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("restart: a missing sidecar is refused by a new store instance", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-restart-missing-"));
  try {
    const profile = profileFixture();
    const layout = layoutOf(profile, sidecarOf(declarationOf(profile)));
    const installed = await harness(dataDir, layout).service.install(SLUG, layout.entry.digest);
    rmSync(join(installed.root, "source-declaration.json"));

    const inspected = await inspectActiveConnector(createFileConnectorInstallStore(dataDir), SLUG);
    assert.equal(inspected.status, "invalid");
    assert.match(inspected.reason, INTEGRITY_REFUSAL);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a legacy record without the sidecar digest does not trust a newly supplied sidecar", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-legacy-"));
  try {
    const profile = profileFixture();
    const layout = layoutOf(profile, null);
    const first = harness(dataDir, layout);
    const installed = await first.service.install(SLUG, layout.entry.digest);
    assert.equal(installed.sourceDeclarationSha256, undefined);

    // Simulate a record written before the sidecar digest existed, then supply a sidecar afterwards.
    const statePath = join(dataDir, "connector-install-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Record<string, unknown>>;
    const record = state[SLUG];
    assert.ok(record, "the install state holds the installed connector");
    Reflect.deleteProperty(record, "sourceDeclarationSha256");
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    writeFileSync(join(installed.root, "source-declaration.json"), sidecarOf(declarationOf(profileFixture())));

    const inspected = await inspectActiveConnector(createFileConnectorInstallStore(dataDir), SLUG);
    assert.equal(inspected.status, "active");
    assert.equal(inspected.record.manifest.source_declaration, undefined, "the unrecorded sidecar is not trusted");
    assert.equal(inspected.record.manifestSha256, installed.manifestSha256);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an oversize sidecar is refused before publication and nothing is registered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-oversize-"));
  try {
    const profile = profileFixture();
    const padded = `${sidecarOf(declarationOf(profile))}${" ".repeat(MIB)}`;
    const { entry, registered, service, store } = harness(dataDir, layoutOf(profile, padded));

    await assert.rejects(() => service.install(entry.connector_id, entry.digest), SIDECAR_INVALID);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
    assert.equal(existsSync(join(dataDir, "connectors", SLUG, entry.digest)), false, "the staged root is removed");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an oversize profile is refused before publication and nothing is registered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-profile-oversize-"));
  try {
    const profile = { ...profileFixture(), padding: "x".repeat(MIB) };
    const { entry, registered, service, store } = harness(
      dataDir,
      layoutOf(profile, sidecarOf(declarationOf(profile)))
    );

    await assert.rejects(() => service.install(entry.connector_id, entry.digest), PROFILE_TOO_LARGE);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a sidecar that is valid JSON but not a valid Core declaration is refused and nothing is registered", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-shape-"));
  try {
    const profile = profileFixture();
    const invalid = { ...declarationOf(profile), protocol_version: "9.9.9" };
    const { entry, registered, service, store } = harness(dataDir, layoutOf(profile, sidecarOf(invalid)));

    await assert.rejects(() => service.install(entry.connector_id, entry.digest), SIDECAR_REFUSAL);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a failed registration of a new version rolls back to the previous good install", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-rollback-"));
  try {
    const v1 = layoutOf(profileFixture("1.0.0"));
    const v2 = layoutOf(profileFixture("1.1.0"));
    const store = createFileConnectorInstallStore(dataDir);
    const good = serviceOver(dataDir, store, [v1]);
    const previous = await good.service.install(SLUG, v1.entry.digest);

    const failing = serviceOver(dataDir, store, [v1, v2], { failRegistrationOn: 1 });
    await assert.rejects(() => failing.service.install(SLUG, v2.entry.digest), REGISTRATION_REFUSED);

    const active = await store.getActive(SLUG);
    assert.equal(active?.digest, previous.digest, "the previous good install stays active");
    assert.equal(active?.sourceDeclarationSha256, previous.sourceDeclarationSha256);
    assert.equal(existsSync(join(dataDir, "connectors", SLUG, v2.entry.digest)), false, "the failed root is removed");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an unreadable sidecar fails the install instead of being recorded as absent", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-eio-"));
  try {
    const v1 = layoutOf(profileFixture("1.0.0"));
    const v2 = layoutOf(profileFixture("1.1.0"));
    const store = createFileConnectorInstallStore(dataDir);
    const previous = await serviceOver(dataDir, store, [v1]).service.install(SLUG, v1.entry.digest);

    const failing = serviceOver(dataDir, store, [v1, v2]);
    const fault = injectFirstSidecarStatEio();
    try {
      await assert.rejects(() => failing.service.install(SLUG, v2.entry.digest), { code: "EIO" });
    } finally {
      fault.restore();
    }

    assert.equal(fault.faults(), 1, "the fault fired on the staged sidecar");
    assert.equal(failing.registered.length, 0, "nothing is registered from the unreadable install");
    const active = await store.getActive(SLUG);
    assert.equal(active?.digest, previous.digest, "the previous good install stays active");
    assert.equal(active?.sourceDeclarationSha256, previous.sourceDeclarationSha256);
    assert.equal(existsSync(join(dataDir, "connectors", SLUG, v2.entry.digest)), false, "the staged root is removed");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a pinned install records the Core-verified sidecar digest and registers the verified declaration", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-pinned-"));
  try {
    const profile = profileFixture();
    const sidecar = sidecarOf(declarationOf(profile));
    const layout: Layout = { ...layoutOf(profile, sidecar), pinnedDeclaration: sidecar };
    const { entry, registered, service } = harness(dataDir, layout);

    const record = await service.install(SLUG, entry.digest);

    assert.equal(record.sourceDeclarationSha256, digestOfText(sidecar));
    assert.deepEqual(registered[0]?.source_declaration, declarationOf(profile));
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a pinned install whose verified sidecar is missing after normalization is refused, not recorded as legacy", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-pinned-missing-"));
  try {
    const profile = profileFixture();
    const verified = sidecarOf(declarationOf(profile));
    const layout: Layout = { ...layoutOf(profile, null), pinnedDeclaration: verified };
    const { entry, registered, service, store } = harness(dataDir, layout);

    await assert.rejects(() => service.install(SLUG, entry.digest), PINNED_SIDECAR_MISSING);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a pinned install whose sidecar bytes differ from the verified digest is refused", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-pinned-mismatch-"));
  try {
    const profile = profileFixture();
    const verified = sidecarOf(declarationOf(profile));
    const layout: Layout = { ...layoutOf(profile, '{"source":"other"}\n'), pinnedDeclaration: verified };
    const { entry, registered, service, store } = harness(dataDir, layout);

    await assert.rejects(() => service.install(SLUG, entry.digest), PINNED_SIDECAR_MISMATCH);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a transient EIO on a pinned install's sidecar refuses the install and registers nothing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-pinned-eio-"));
  try {
    const profile = profileFixture();
    const sidecar = sidecarOf(declarationOf(profile));
    const layout: Layout = { ...layoutOf(profile, sidecar), pinnedDeclaration: sidecar };
    const { entry, registered, service, store } = harness(dataDir, layout);
    const fault = injectFirstSidecarStatEio();
    try {
      await assert.rejects(() => service.install(SLUG, entry.digest), { code: "EIO" });
    } finally {
      fault.restore();
    }

    assert.equal(fault.faults(), 1);
    assert.equal(registered.length, 0);
    assert.equal((await store.getActive(SLUG)) ?? null, null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a legacy install with no sidecar stays legacy and records no sidecar digest", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-oci-declaration-legacy-absent-"));
  try {
    const profile = profileFixture();
    const { entry, registered, service } = harness(dataDir, layoutOf(profile, null));

    const record = await service.install(SLUG, entry.digest);

    assert.equal(record.sourceDeclarationSha256, undefined);
    assert.equal(registered[0]?.source_declaration, undefined);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

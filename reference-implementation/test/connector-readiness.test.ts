// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser-setup readiness projection, over real install and local-source
 * stores. Each test states one row of the state table in
 * `projectBrowserEnrollmentReadiness` in `server/connector-readiness.ts`: the
 * signed catalog, the selected artifact, and the host decide the action and the reason. Roster membership
 * and the listing tier are not inputs, so none appear here.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ConnectorCatalogEntry,
  type ConnectorInstallService,
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import {
  type BrowserEnrollmentReadiness,
  createBrowserEnrollmentReadinessResolver,
  projectBrowserEnrollmentReadiness,
  READINESS_ACTIONS,
  READINESS_REASONS,
} from "../server/connector-readiness.ts";
import { createBrowserArtifactFixtures, setBrowserHostCapability } from "./helpers/browser-artifact-fixtures.ts";

const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;
const DIGEST_V1 = `sha256:${"a".repeat(64)}`;
const DIGEST_V2 = `sha256:${"b".repeat(64)}`;

const BROWSER_BINDINGS = { browser: { required: true }, network: { required: true } };
const NETWORK_BINDINGS = { network: { required: true } };

function catalogEntry(
  connectorId: string,
  digest: string,
  version: string,
  bindings: Record<string, unknown> = BROWSER_BINDINGS
): ConnectorCatalogEntry {
  return {
    bindings,
    config_digest: CONFIG_DIGEST,
    connector_id: connectorId,
    connector_key: connectorId,
    digest,
    latest: true,
    tier: "development",
    version,
  };
}

function writeArtifact(root: string, connectorId: string, version: string, bindings: Record<string, unknown>): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    JSON.stringify({ connector_id: connectorId, runtime_requirements: { bindings }, version })
  );
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

interface Harness {
  readonly dataDir: string;
  readonly install: (connectorId: string, digest: string) => Promise<void>;
  readonly resolve: (connectorKey: string) => Promise<BrowserEnrollmentReadiness>;
  readonly service: ConnectorInstallService;
  setCatalog: (entries: readonly ConnectorCatalogEntry[] | Error) => void;
}

/**
 * A real install service over a temp data dir. `fixtures` supplies the
 * developer-local store; the catalog is whatever the test sets, never the
 * network.
 */
function harness(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-readiness-"));
  let catalog: readonly ConnectorCatalogEntry[] | Error = [];
  let pending: ConnectorCatalogEntry | undefined;
  const service = createConnectorInstallService({
    catalogLoader: async () => {
      if (catalog instanceof Error) {
        throw catalog;
      }
      return catalog;
    },
    dataDir,
    installArtifact: (root) => {
      if (!pending) {
        throw new Error("no catalog entry is being installed");
      }
      writeArtifact(root, pending.connector_id, pending.version ?? "1.0.0", (pending.bindings ?? {}) as Record<string, unknown>);
    },
    localSourceStore: createFileLocalConnectorSourceStore(process.env.PDPP_DATA_DIR),
    registerManifest: () => Promise.resolve(),
    store: createFileConnectorInstallStore(dataDir),
  });
  const resolver = createBrowserEnrollmentReadinessResolver({ installService: service });
  return {
    dataDir,
    install: async (connectorId, digest) => {
      pending = Array.isArray(catalog) ? catalog.find((entry) => entry.digest === digest) : undefined;
      await service.install(connectorId, digest);
    },
    resolve: (connectorKey) => resolver.resolve(connectorKey),
    service,
    setCatalog: (next) => {
      catalog = next;
    },
  };
}

async function withHarness(
  run: (h: Harness, fixtures: ReturnType<typeof createBrowserArtifactFixtures>) => Promise<void>,
  options: { browserHost?: boolean } = {}
): Promise<void> {
  const fixtures = createBrowserArtifactFixtures();
  const restoreHost = setBrowserHostCapability(options.browserHost ?? true);
  const h = harness();
  try {
    await run(h, fixtures);
  } finally {
    restoreHost();
    fixtures.close();
    rmSync(h.dataDir, { force: true, recursive: true });
  }
}

function browserManifest(connectorId: string): Record<string, unknown> {
  return {
    connector_id: connectorId,
    connector_key: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: BROWSER_BINDINGS },
    streams: [{ name: "orders", primary_key: ["id"], schema: { properties: { id: { type: "string" } }, type: "object" } }],
    version: "1.0.0",
  };
}

// ─── Catalog × no artifact ──────────────────────────────────────────────────

test("published but not installed: install, with the catalog as the reason it is offered", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "install");
    assert.equal(readiness.reason, "not_installed");
    assert.equal(readiness.catalog, "offered");
    assert.equal(readiness.artifact.state, "none");
    assert.equal(readiness.browser_bound, true);
  });
});

test("published connector that does not use a browser is never offered browser setup", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-api", DIGEST_V1, "1.0.0", NETWORK_BINDINGS)]);
    const readiness = await h.resolve("acme-api");
    assert.equal(readiness.action, "unavailable");
    assert.equal(readiness.reason, "not_browser_bound");
    assert.equal(readiness.browser_bound, false);
  });
});

test("in no catalog and nothing installed: unavailable, not published", async () => {
  await withHarness(async (h) => {
    h.setCatalog([]);
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "unavailable");
    assert.equal(readiness.reason, "not_published");
    assert.equal(readiness.catalog, "not_offered");
  });
});

test("catalog unreachable and nothing installed: retry, not a claim that it does not exist", async () => {
  await withHarness(async (h) => {
    h.setCatalog(new Error("ghcr.io is unreachable"));
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "retry");
    assert.equal(readiness.reason, "catalog_unavailable");
    assert.equal(readiness.catalog, "unavailable");
  });
});

// ─── Installed artifact ─────────────────────────────────────────────────────

test("an installed, verified browser artifact on a browser host: connect", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
    await h.install("acme-shop", DIGEST_V1);
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "connect");
    assert.equal(readiness.reason, "runnable");
    assert.equal(readiness.host, "ready");
    assert.deepEqual(
      { source: readiness.artifact.source, state: readiness.artifact.state, version: readiness.artifact.version },
      { source: "installed", state: "verified", version: "1.0.0" }
    );
  });
});

test("an older installed version stays runnable when the catalog offers a newer one", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
    await h.install("acme-shop", DIGEST_V1);
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V2, "2.0.0")]);
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "connect");
    assert.equal(readiness.artifact.version, "1.0.0");
    // The catalog is not consulted once an artifact is selected.
    assert.equal(readiness.catalog, "not_consulted");
  });
});

test("an installed connector stays runnable while the catalog is down", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
    await h.install("acme-shop", DIGEST_V1);
    h.setCatalog(new Error("ghcr.io is unreachable"));
    assert.equal((await h.resolve("acme-shop")).action, "connect");
  });
});

test("an installed artifact whose bytes changed: repair, never connect", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
    await h.install("acme-shop", DIGEST_V1);
    const [record] = await h.service.status();
    assert.ok(record);
    appendFileSync(join(record.root, record.entrypointPath), "// tampered\n");
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "repair");
    assert.equal(readiness.reason, "artifact_invalid");
    assert.equal(readiness.artifact.state, "invalid");
    assert.ok(readiness.detail, "the owner sees why");
  });
});

test("an installed artifact on a bare host with no browser variables: connect, attended setup needs no scheduler surface", async () => {
  await withHarness(
    async (h) => {
      h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
      await h.install("acme-shop", DIGEST_V1);
      const readiness = await h.resolve("acme-shop");
      assert.equal(readiness.action, "connect");
      assert.equal(readiness.host, "ready");
    },
    { browserHost: false }
  );
});

// ─── Host result: blocked, throwing, reused ─────────────────────────────────

function activeArtifact(runtimeRequirements: unknown = { bindings: BROWSER_BINDINGS }) {
  return {
    digest: DIGEST_V1,
    manifest: { connector_id: "acme-shop", runtime_requirements: runtimeRequirements },
    source: "installed" as const,
    status: "active" as const,
    version: "1.0.0",
  };
}

test("a host that cannot run the connector: configure, with the host's reason as detail only", async () => {
  const resolver = createBrowserEnrollmentReadinessResolver({
    checkHost: async () => ({ ready: false, reason: "required tool 'ffmpeg' was not found" }),
    installService: { catalog: async () => [], inspectSelected: async () => activeArtifact() },
  });
  const readiness = await resolver.resolve("acme-shop");
  assert.equal(readiness.action, "configure");
  assert.equal(readiness.reason, "host_requirement_unmet");
  assert.equal(readiness.host, "blocked");
  assert.equal(readiness.detail, "required tool 'ffmpeg' was not found");
});

test("one connector's malformed requirements or throwing host probe is that connector's retry, never a failed list", async () => {
  const service = {
    catalog: async () => [],
    inspectSelected: async (key: string) =>
      key === "acme-bad" ? activeArtifact({ bindings: BROWSER_BINDINGS, external_tools: 5 }) : activeArtifact(),
  };
  // The real host rules: a non-iterable `external_tools` throws inside them.
  const resolver = createBrowserEnrollmentReadinessResolver({ installService: service });
  const [bad, good] = await resolver.resolveMany(["acme-bad", "acme-shop"]);
  assert.ok(bad);
  assert.ok(good);
  assert.equal(bad.action, "retry");
  assert.equal(bad.reason, "inspection_unavailable");
  assert.equal(good.action, "connect");

  const throwing = createBrowserEnrollmentReadinessResolver({
    checkHost: async () => {
      throw new Error("spawn EAGAIN");
    },
    installService: service,
  });
  assert.equal((await throwing.resolve("acme-shop")).reason, "inspection_unavailable");
});

test("a list reuses a host result for a short time; a single read asks the host afresh", async () => {
  let clock = 0;
  let probes = 0;
  const resolver = createBrowserEnrollmentReadinessResolver({
    checkHost: async () => {
      probes += 1;
      return { ready: true };
    },
    installService: { catalog: async () => [], inspectSelected: async () => activeArtifact() },
    now: () => clock,
  });
  await resolver.resolveMany(["acme-shop"]);
  await resolver.resolveMany(["acme-shop"]);
  assert.equal(probes, 1, "the second list read reuses the result");
  await resolver.resolve("acme-shop");
  assert.equal(probes, 2, "the action-time read always asks the host");
  clock += 31_000;
  await resolver.resolveMany(["acme-shop"]);
  assert.equal(probes, 3, "an expired result is asked for again");
});

test("a catalog that never answers is retry, within the bound", async () => {
  const resolver = createBrowserEnrollmentReadinessResolver({
    catalogTimeoutMs: 20,
    installService: { catalog: () => new Promise(() => undefined), inspectSelected: async () => ({ status: "none" as const }) },
  });
  const readiness = await resolver.resolve("acme-shop");
  assert.equal(readiness.action, "retry");
  assert.equal(readiness.reason, "catalog_unavailable");
});

test("an installed artifact that does not use a browser: unavailable for browser setup", async () => {
  await withHarness(async (h) => {
    h.setCatalog([catalogEntry("acme-api", DIGEST_V1, "1.0.0", NETWORK_BINDINGS)]);
    await h.install("acme-api", DIGEST_V1);
    const readiness = await h.resolve("acme-api");
    assert.equal(readiness.action, "unavailable");
    assert.equal(readiness.reason, "not_browser_bound");
  });
});

// ─── Developer-local source ─────────────────────────────────────────────────

test("a runnable unpublished developer-local source: connect, whatever the catalog says", async () => {
  await withHarness(async (h, fixtures) => {
    h.setCatalog([]);
    await fixtures.publish(browserManifest("acme-local"));
    const readiness = await h.resolve("acme-local");
    assert.equal(readiness.action, "connect");
    assert.equal(readiness.artifact.source, "developer_local");
    assert.equal(readiness.catalog, "not_consulted");
  });
});

test("a developer-local source that changed on disk blocks, even over a valid install", async () => {
  await withHarness(async (h, fixtures) => {
    h.setCatalog([catalogEntry("acme-shop", DIGEST_V1, "1.0.0")]);
    await h.install("acme-shop", DIGEST_V1);
    await fixtures.publish(browserManifest("acme-shop"));
    fixtures.corrupt("acme-shop");
    const readiness = await h.resolve("acme-shop");
    assert.equal(readiness.action, "repair");
    assert.equal(readiness.artifact.source, "developer_local");
  });
});

// ─── Inspection failure ─────────────────────────────────────────────────────

test("a store that cannot be read: retry, and the cause is shown", async () => {
  const service = {
    catalog: async () => [],
    inspectSelected: async () => {
      throw new Error("sqlite is locked");
    },
  };
  const readiness = await createBrowserEnrollmentReadinessResolver({ installService: service }).resolve("acme-shop");
  assert.equal(readiness.action, "retry");
  assert.equal(readiness.reason, "inspection_unavailable");
  assert.equal(readiness.detail, "sqlite is locked");
});

test("a corrupted artifact is still reported browser-bound from the registered manifest", async () => {
  const service = {
    catalog: async () => [],
    inspectSelected: async () => ({ reason: "bytes changed", source: "installed" as const, status: "invalid" as const }),
  };
  const withManifest = createBrowserEnrollmentReadinessResolver({
    installService: service,
    registeredManifest: async () => browserManifest("acme-shop"),
  });
  const without = createBrowserEnrollmentReadinessResolver({ installService: service });
  assert.equal((await withManifest.resolve("acme-shop")).browser_bound, true);
  assert.equal((await without.resolve("acme-shop")).browser_bound, false);
  // A manifest the caller already holds replaces the hook's lookup.
  assert.equal((await without.resolve("acme-shop", browserManifest("acme-shop"))).browser_bound, true);
  // resolveMany answers exactly what resolve answers.
  assert.deepEqual(await withManifest.resolveMany(["acme-shop"]), [await withManifest.resolve("acme-shop")]);
});

// ─── Pure table ─────────────────────────────────────────────────────────────

test("tier, roster membership and the connector's name are not inputs", async () => {
  await withHarness(async (h) => {
    // The same artifact under a known-scaffold name and an invented one.
    h.setCatalog([
      catalogEntry("anthropic", DIGEST_V1, "1.0.0"),
      catalogEntry("zzz-unknown", DIGEST_V2, "1.0.0"),
    ]);
    await h.install("anthropic", DIGEST_V1);
    await h.install("zzz-unknown", DIGEST_V2);
    const [a, b] = await Promise.all([h.resolve("anthropic"), h.resolve("zzz-unknown")]);
    assert.equal(a.action, "connect");
    assert.equal(b.action, "connect");
  });
});

test("projection rows are evaluated top to bottom: an invalid artifact beats the catalog and the host", () => {
  const projected = projectBrowserEnrollmentReadiness({
    artifact: { reason: "bytes changed", source: "installed", status: "invalid" },
    catalog: "offered",
    catalogBrowserBound: true,
    connectorKey: "acme-shop",
    hintBrowserBound: true,
    host: { ready: false, reason: "no browser" },
  });
  assert.equal(projected.action, "repair");
  assert.equal(projected.host, "not_evaluated");
});

test("a registered manifest alone is not an artifact: it names the connector browser-bound but is never runnable", () => {
  const projected = projectBrowserEnrollmentReadiness({
    artifact: { status: "none" },
    catalog: "not_offered",
    catalogBrowserBound: null,
    connectorKey: "acme-shop",
    hintBrowserBound: true,
    host: null,
  });
  assert.equal(projected.action, "unavailable");
  assert.equal(projected.reason, "not_published");
  assert.equal(projected.browser_bound, true);
});

test("the console's readiness vocabulary matches the server's", async () => {
  // The console cannot import the server module (it pulls in the install
  // service), so it keeps its own copy of the vocabulary. This test is the
  // single check that the two copies agree.
  //
  // The specifier is built at runtime and the result typed by hand, so tsc
  // never resolves apps/console's module graph under this package's compiler
  // options (apps/console has its own tsconfig and typecheck script).
  const consoleLibDirectory = ["..", "..", "apps", "console", "src", "app", "(console)", "lib"].join("/");
  const consoleContract: { READINESS_ACTIONS: readonly string[]; READINESS_REASONS: readonly string[] } = await import(
    `${consoleLibDirectory}/connector-readiness-contract.ts`
  );
  assert.deepEqual([...consoleContract.READINESS_ACTIONS], [...READINESS_ACTIONS]);
  assert.deepEqual([...consoleContract.READINESS_REASONS], [...READINESS_REASONS]);
});

// ─── A verified package that declares it does not collect ───────────────────

test("a verified, browser-bound package that declares no collection is unavailable, not connect", async () => {
  let hostAsked = false;
  const stub = {
    ...activeArtifact(),
    manifest: {
      capabilities: { collection: { implemented: false } },
      connector_id: "acme-stub",
      runtime_requirements: { bindings: BROWSER_BINDINGS },
    },
  };
  const resolver = createBrowserEnrollmentReadinessResolver({
    checkHost: async () => {
      hostAsked = true;
      return { ready: true };
    },
    installService: { catalog: async () => [], inspectSelected: async () => stub },
  });
  const readiness = await resolver.resolve("acme-stub");
  assert.equal(readiness.action, "unavailable");
  assert.equal(readiness.reason, "not_implemented");
  assert.equal(readiness.browser_bound, true, "the routes stay reachable for an existing connection");
  assert.equal(hostAsked, false, "no host probe for a package that cannot collect");
});

test("only an explicit implemented:false withholds connect; an absent or other declaration does not", async () => {
  for (const capabilities of [undefined, {}, { collection: {} }, { collection: { implemented: true } }]) {
    const resolver = createBrowserEnrollmentReadinessResolver({
      checkHost: async () => ({ ready: true }),
      installService: {
        catalog: async () => [],
        inspectSelected: async () => ({
          ...activeArtifact(),
          manifest: { capabilities, connector_id: "acme-shop", runtime_requirements: { bindings: BROWSER_BINDINGS } },
        }),
      },
    });
    assert.equal((await resolver.resolve("acme-shop")).action, "connect", JSON.stringify(capabilities));
  }
});

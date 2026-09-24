// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ConnectorCatalogEntry,
  createConfigLimitedFetch,
  createConnectorInstallStore,
  createConnectorInstallService,
  createFileConnectorInstallStore,
  inspectActiveConnector,
  normalizeCoreInstallLayout,
  resolveActiveConnectorPath,
} from "../server/connector-install/index.ts";
import { mountOwnerConnectorInstall } from "../server/routes/owner-connector-install.ts";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const configDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RE_INTERRUPTED = /interrupted/;
const RE_ONE_MIB = /1 MiB/;
const RE_STATE_COMMIT_FAILED = /state commit failed/;
const RE_ROLLBACK = /rollback/;
const RE_INSTALL_IN_PROGRESS = /Another connector installation is in progress/;
const RE_SYMBOLIC_LINK = /symbolic-link/;
const RE_UPDATE_FAILED = /crashed while staging update/;
const RE_UPDATE_TARGET_MISSING = /no verified update target/;
const RE_REGISTRATION_FAILED = /manifest registration failed/;
const entry: ConnectorCatalogEntry = {
  bindings: { browser: "optional" },
  config_digest: configDigest,
  connector_id: "github",
  connector_key: "github",
  digest,
  tier: "supported",
  version: "1.0.0",
};

test("PDPP_CONNECTOR_PRELOAD_DIR selects the file-backed install store", () => {
  const previous = process.env.PDPP_CONNECTOR_PRELOAD_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-preload-"));
  process.env.PDPP_CONNECTOR_PRELOAD_DIR = dataDir;
  try {
    assert.equal(createConnectorInstallStore().dataDir, dataDir);
  } finally {
    if (previous === undefined) {
      delete process.env.PDPP_CONNECTOR_PRELOAD_DIR;
    } else {
      process.env.PDPP_CONNECTOR_PRELOAD_DIR = previous;
    }
    rmSync(dataDir, { force: true, recursive: true });
  }
});

function writeFixture(root: string): void {
  mkdirSync(join(root, "profile"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    JSON.stringify({ connector_id: "github", version: "1.0.0" })
  );
  writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
  writeFileSync(join(root, "provenance.json"), "{}\n");
}

test("installs into an immutable digest root and resolves the active verified entrypoint", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    assert.equal(active.digest, digest);
    assert.equal(
      await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"),
      join(active.root, "dist", "collection-profile.mjs")
    );
    assert.equal((await service.status())[0]?.tier, "supported");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a corrupted active entrypoint fails closed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    writeFileSync(join(active.root, "dist", "collection-profile.mjs"), "tampered\n");
    assert.equal(await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"), null);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("status skips a stale active record with missing bytes and reinstall repairs it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    rmSync(active.root, { force: true, recursive: true });

    assert.deepEqual(await service.status(), []);
    assert.equal(await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"), null);

    const repaired = await service.install("github", digest);
    assert.equal(repaired.digest, digest);
    assert.equal((await service.status())[0]?.digest, digest);
    assert.equal(existsSync(join(repaired.root, "dist", "collection-profile.mjs")), true);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("status skips a corrupt expected root and reinstall replaces it safely", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    writeFileSync(join(active.root, "dist", "collection-profile.mjs"), "tampered\n");

    assert.deepEqual(await service.status(), []);

    const repaired = await service.install("github", digest);
    assert.equal((await service.status())[0]?.digest, digest);
    assert.equal(readFileSync(join(repaired.root, "dist", "collection-profile.mjs"), "utf8"), "export {};\n");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("reinstall refuses to replace a symlinked active digest root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    rmSync(active.root, { force: true, recursive: true });
    symlinkSync(outsideDir, active.root, "dir");

    assert.deepEqual(await service.status(), []);
    await assert.rejects(() => service.install("github", digest), /already exists without a matching active record/);
    assert.deepEqual(readdirSync(outsideDir), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("an active root outside the configured data directory is invalid", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    const statePath = join(dataDir, "connector-install-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, Record<string, unknown>>;
    const { github } = state;
    assert.ok(github);
    github.root = join(outsideDir, "connectors", "github", digest);
    writeFileSync(statePath, JSON.stringify(state));
    assert.equal((await inspectActiveConnector(createFileConnectorInstallStore(dataDir), "github")).status, "invalid");
    assert.equal(await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"), null);
    assert.equal(active.connectorId, "github");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("a symlinked active path component fails closed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install("github", digest);
    mkdirSync(join(outsideDir, "dist"), { recursive: true });
    writeFileSync(join(outsideDir, "dist", "collection-profile.mjs"), "export {};\n");
    rmSync(join(active.root, "dist"), { force: true, recursive: true });
    symlinkSync(join(outsideDir, "dist"), join(active.root, "dist"), "dir");
    assert.equal((await inspectActiveConnector(createFileConnectorInstallStore(dataDir), "github")).status, "invalid");
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("a symlinked connectors parent is refused before publication", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "pdpp-connector-outside-"));
  try {
    symlinkSync(outsideDir, join(dataDir, "connectors"), "dir");
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.install("github", digest), RE_SYMBOLIC_LINK);
    assert.deepEqual(await service.status(), []);
    assert.deepEqual(readdirSync(outsideDir), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
    rmSync(outsideDir, { force: true, recursive: true });
  }
});

test("a failed stage leaves no active root or state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: () => {
        throw new Error("interrupted");
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.install("github", digest), RE_INTERRUPTED);
    assert.deepEqual(await service.status(), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("an oversized materialized profile cannot be activated", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
        writeFileSync(join(root, "profile", "collection-profile.json"), "x".repeat(1024 * 1024 + 1));
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.install("github", digest), RE_ONE_MIB);
    assert.deepEqual(await service.status(), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a failed active-state commit removes the newly published root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const baseStore = createFileConnectorInstallStore(dataDir);
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: {
        ...baseStore,
        activate: () => {
          throw new Error("state commit failed");
        },
      },
    });
    await assert.rejects(() => service.install("github", digest), RE_STATE_COMMIT_FAILED);
    assert.equal(existsSync(join(dataDir, "connectors", "github", digest)), false);
    assert.deepEqual(await baseStore.listActive(), []);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a pre-existing digest root without active state is discarded before reinstall", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    mkdirSync(join(dataDir, "connectors", "github", digest), { recursive: true });
    let called = false;
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        called = true;
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await service.install("github", digest);
    assert.equal(called, true);
    assert.equal((await service.status())[0]?.digest, digest);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("catalog high-water persists generated_at across service restarts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const store = createFileConnectorInstallStore(dataDir);
  try {
    const first = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-16T12:00:00Z" }),
      dataDir,
      registerManifest: () => Promise.resolve(),
      store,
    });
    await first.catalog();
    assert.equal(await store.getCatalogHighWater(), "2026-09-16T12:00:00Z");
    const older = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-16T11:00:00Z" }),
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => older.catalog(), RE_ROLLBACK);
    const equal = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-16T12:00:00Z" }),
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    assert.equal((await equal.catalog())[0]?.digest, digest);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("update refuses a catalog without an explicit latest target", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    await assert.rejects(() => service.update("github"), RE_UPDATE_TARGET_MISSING);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("concurrent installs are serialized by the process-safe lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  let enteredResolve: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const stageReleased = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: async (root) => {
        enteredResolve?.();
        await stageReleased;
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const first = service.install("github", digest);
    await entered;
    await assert.rejects(() => service.install("github", digest), RE_INSTALL_IN_PROGRESS);
    releaseStage?.();
    await first;
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("catalog remains readable while an install holds the install lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  let enteredResolve: (() => void) | undefined;
  let releaseStage: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const stageReleased = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => ({ entries: [entry], generatedAt: "2026-09-24T00:00:00.000Z" }),
      dataDir,
      installArtifact: async (root) => {
        enteredResolve?.();
        await stageReleased;
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const installing = service.install("github", digest);
    await entered;

    assert.equal((await service.catalog())[0]?.digest, digest);

    releaseStage?.();
    await installing;
  } finally {
    releaseStage?.();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("the RI transport bounds signed config and profile blobs", async () => {
  const profileDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  let oversized = false;
  const limited = createConfigLimitedFetch((input) => {
    const url = String(input);
    if (url.includes("/manifests/")) {
      return Response.json({
        config: { digest: configDigest },
        layers: [{ digest: profileDigest, mediaType: "application/vnd.pdpp.connector.profile.v1+json" }],
      });
    }
    oversized = true;
    return new Response("x".repeat(1024 * 1024 + 1), {
      headers: { "content-length": String(1024 * 1024 + 1) },
    });
  });
  const manifest = await limited.fetchImpl(`https://ghcr.io/v2/pdp-connect/connector/github/manifests/${digest}`);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/json");
  await manifest.arrayBuffer();
  await assert.rejects(
    () => limited.fetchImpl(`https://ghcr.io/v2/pdp-connect/connector/github/blobs/${configDigest}`),
    RE_ONE_MIB
  );
  assert.equal(oversized, true);
});

test("normalizes the pinned core collection-profiles layout before verification", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-connector-install-layout-"));
  try {
    writeFixture(join(root, "collection-profiles", "github"));
    mkdirSync(join(root, "collection-profiles", "github", "licenses"), { recursive: true });
    mkdirSync(join(root, "collection-profiles", "github", "assets"), { recursive: true });
    writeFileSync(join(root, "collection-profiles", "github", "licenses", "NOTICE"), "notice");
    writeFileSync(join(root, "collection-profiles", "github", "assets", "icon.svg"), "<svg />");
    normalizeCoreInstallLayout(root, "github");
    assert.equal(existsSync(join(root, "profile", "collection-profile.json")), true);
    assert.equal(existsSync(join(root, "dist", "collection-profile.mjs")), true);
    assert.equal(existsSync(join(root, "licenses", "NOTICE")), true);
    assert.equal(existsSync(join(root, "assets", "icon.svg")), true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a failed update retains the previously active digest root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const next = {
    ...entry,
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    latest: true,
    version: "2.0.0",
  };
  let current = entry;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root, candidate) => {
        if (candidate.digest === next.digest) {
          throw new Error("crashed while staging update");
        }
        writeFixture(root);
      },
      registerManifest: () => Promise.resolve(),
      store: createFileConnectorInstallStore(dataDir),
    });
    const previous = await service.install("github", digest);
    current = next;
    await assert.rejects(() => service.update("github"), RE_UPDATE_FAILED);
    assert.equal((await service.status())[0]?.digest, previous.digest);
    assert.equal(
      await resolveActiveConnectorPath(createFileConnectorInstallStore(dataDir), "github"),
      join(previous.root, "dist", "collection-profile.mjs")
    );
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("a post-publication registration failure restores the previous active root", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-connector-install-"));
  const next = {
    ...entry,
    config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    latest: true,
    version: "2.0.0",
  };
  let current = entry;
  let registrationCount = 0;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [current],
      dataDir,
      installArtifact: (root) => {
        writeFixture(root);
      },
      registerManifest: () => {
        registrationCount += 1;
        return registrationCount === 2 ? Promise.reject(new Error("manifest registration failed")) : Promise.resolve();
      },
      store: createFileConnectorInstallStore(dataDir),
    });
    const previous = await service.install("github", digest);
    current = next;
    await assert.rejects(() => service.update("github"), RE_REGISTRATION_FAILED);
    assert.equal((await service.status())[0]?.digest, previous.digest);
    assert.equal(existsSync(join(dataDir, "connectors", "github", next.digest)), false);
  } finally {
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("owner install route rejects missing installation fields", async () => {
  type RegisteredHandler = (
    req: { body?: Record<string, unknown> },
    res: {
      json: (value: unknown) => unknown;
      status: (value: number) => unknown;
    }
  ) => Promise<void>;
  const routes = new Map<string, RegisteredHandler>();
  const registrations = new Map<string, unknown[]>();
  const app = {
    get(path: string, ...args: unknown[]) {
      registrations.set(`GET ${path}`, args);
      routes.set(`GET ${path}`, args.at(-1) as RegisteredHandler);
      return this;
    },
    post(path: string, ...args: unknown[]) {
      registrations.set(`POST ${path}`, args);
      routes.set(`POST ${path}`, args.at(-1) as RegisteredHandler);
      return this;
    },
  };
  const tokenGuard = () => undefined;
  const ownerGuard = () => undefined;
  mountOwnerConnectorInstall(app as never, {
    handleError: () => assert.fail("unexpected error"),
    pdppError: (_res, statusCode, code, message, param) => {
      status = statusCode;
      body = { code, message, param };
    },
    requireOwner: ownerGuard,
    requireToken: tokenGuard,
    service: {
      catalog: async () => [],
      install: async () => assert.fail("should not install"),
      status: async () => [],
      update: async () => assert.fail("should not update"),
    },
  });
  let status = 200;
  let body: unknown;
  await routes.get("POST /v1/owner/connector-install/install")?.(
    { body: {} },
    {
      json(value: unknown) {
        body = value;
        return this;
      },
      status(value: number) {
        status = value;
        return this;
      },
    }
  );
  assert.equal(status, 400);
  assert.deepEqual(body, { code: "invalid_request", message: "connector_id is required", param: "connector_id" });
  assert.equal(registrations.get("POST /v1/owner/connector-install/install")?.[0], tokenGuard);
  assert.equal(registrations.get("POST /v1/owner/connector-install/install")?.[1], ownerGuard);
});

test("owner catalog route returns the verified catalog projection", async () => {
  type RegisteredHandler = (
    req: Record<string, never>,
    res: { json: (value: unknown) => unknown }
  ) => Promise<void>;
  const routes = new Map<string, RegisteredHandler>();
  const app = {
    get(path: string, ...args: unknown[]) {
      routes.set(`GET ${path}`, args.at(-1) as RegisteredHandler);
      return this;
    },
    post() {
      return this;
    },
  };
  mountOwnerConnectorInstall(app as never, {
    handleError: () => assert.fail("unexpected error"),
    pdppError: () => assert.fail("unexpected error"),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    service: {
      catalog: async () => [
        {
          ...entry,
          display_name: "GitHub",
          latest: true,
          published_at: "2026-09-16T12:00:00Z",
          setup_modality: "oauth",
        },
      ],
      install: async () => assert.fail("should not install"),
      status: async () => [],
      update: async () => assert.fail("should not update"),
    },
  });
  let body: unknown;
  await routes.get("GET /v1/owner/connector-install/catalog")?.({}, {
    json(value: unknown) {
      body = value;
      return this;
    },
  });
  assert.deepEqual(body, {
    data: [
      {
        bindings: { browser: "optional" },
        connector_id: "github",
        connector_key: "github",
        digest,
        display_name: "GitHub",
        latest: true,
        published_at: "2026-09-16T12:00:00Z",
        setup_modality: "oauth",
        tier: "supported",
        version: "1.0.0",
      },
    ],
    object: "connector_install_catalog",
  });
});

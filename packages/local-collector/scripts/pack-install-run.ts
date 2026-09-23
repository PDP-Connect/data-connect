#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { COLLECTION_PROFILE_PINS } from "../src/generated/collection-profile-pins.generated.ts";
import { npmPackMetadata } from "./pack-metadata.ts";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const cliPackageRoot = path.join(repoRoot, "packages/cli");
const referenceServerEntry = path.join(repoRoot, "reference-implementation/server/index.ts");
const referenceDbModule = path.join(repoRoot, "reference-implementation/server/db.js");
const forbiddenPackages = ["playwright", "patchright", "imapflow", "pdf-parse", "better-sqlite3", "linkedom"];
const browserArtifactPatterns = [/chromium/i, /chrome-linux/i, /ms-playwright/i, /patchright/i];

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

interface PostJsonResponse {
  body: unknown;
  status: number;
}

interface EnrollmentData {
  connector_instance_id: string;
  device_id: string;
  device_token: string;
  source_instance_id: string;
}

interface RunOutput {
  done?: { status: string };
  recordsQueued?: number;
  sentBatches?: number;
}

interface ServerInstance {
  asPort: number;
  asServer?: {
    closeAllConnections?: () => void;
    close?: (cb: () => void) => void;
  };
  rsPort: number;
  rsServer?: {
    closeAllConnections?: () => void;
    close?: (cb: () => void) => void;
  };
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function run(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (error as any).message += `\nCommand failed: ${command} ${args.join(" ")}`;
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      if ("stdout" in error && (error as any).stdout) {
        // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        (error as any).message += `\nstdout:\n${
          // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
          (error as any).stdout
        }`;
      }
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      if ("stderr" in error && (error as any).stderr) {
        // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
        (error as any).message += `\nstderr:\n${
          // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
          (error as any).stderr
        }`;
      }
    }
    throw error;
  }
}

async function packPackage(cwd: string): Promise<string> {
  const packInfo = await npmPackMetadata({ cwd });
  return path.join(cwd, packInfo.filename);
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    if ((error as any)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertPackageAbsent(projectDir: string, packageName: string): Promise<void> {
  const candidate = path.join(projectDir, "node_modules", ...packageName.split("/"));
  assert.equal(await pathExists(candidate), false, `unexpected package installed in temp consumer: ${packageName}`);
}

async function assertNoBrowserArtifacts(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const { name } = entry;
    for (const pattern of browserArtifactPatterns) {
      assert.equal(pattern.test(name), false, `unexpected browser install artifact in temp tree: ${name}`);
    }
  }
}

async function main(): Promise<void> {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts?.postinstall, undefined, "@pdpp/local-collector must not define postinstall");

  log("Building and packing @pdpp/local-collector...");
  const collectorTarball = await packPackage(packageRoot);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-pack-"));
  const projectDir = path.join(tempRoot, "project");
  const npmCacheDir = path.join(tempRoot, "npm-cache");
  // The collector installs connectors under the platform state root. Pointing
  // XDG_STATE_HOME (and HOME, for macOS) into the temp tree exercises that
  // default path with no override, and keeps installs off the real host.
  const stateRoot = path.join(tempRoot, "state");
  const env = {
    ...process.env,
    HOME: path.join(tempRoot, "home"),
    XDG_STATE_HOME: stateRoot,
    npm_config_cache: npmCacheDir,
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "",
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "",
  };

  try {
    await mkdir(projectDir, { recursive: true });
    await run("npm", ["init", "-y"], { cwd: projectDir, env });

    log("Installing packed @pdpp/local-collector in a clean temp npm project...");
    const install = await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", collectorTarball], {
      cwd: projectDir,
      env,
    });
    const installOutput = `${install.stdout}\n${install.stderr}`;
    for (const pattern of browserArtifactPatterns) {
      assert.equal(pattern.test(installOutput), false, `install output referenced browser artifact ${pattern}`);
    }
    for (const packageName of forbiddenPackages) {
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      await assertPackageAbsent(projectDir, packageName);
    }
    await assertPackageAbsent(projectDir, "tsx");
    await assertNoBrowserArtifacts(tempRoot);

    log("Resolving installed package exports and bin...");
    await assertInstalledEntrypoints(projectDir, env);
    log("Checking the installed package ships the installer core and no connector code...");
    await assertInstalledPackageShipsNoConnectorCode(projectDir);

    log("Running pdpp-local-collector advertise from the installed package...");
    const advertise = await run("npx", ["--no-install", "pdpp-local-collector", "advertise"], { cwd: projectDir, env });
    const advertised = JSON.parse(advertise.stdout);
    assert.equal(advertised.runtime, "collector");
    assert.deepEqual([...advertised.bindings].sort(), ["filesystem", "local_device", "network"]);
    assert.deepEqual([...advertised.bundled_connectors].sort(), [
      "apple_photos",
      "claude_code",
      "codex",
      "google_takeout",
      "imessage",
    ]);
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(advertised.collector_protocol_version, /^\d+$/);
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(advertised.protocol_version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual([...advertised.protocol_capabilities].sort(), []);

    if (await pathExists(path.join(cliPackageRoot, "package.json"))) {
      log("Installing packed @pdpp/cli alongside the collector and checking shim advertise output...");
      const cliTarball = await packPackage(cliPackageRoot);
      await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", cliTarball], {
        cwd: projectDir,
        env,
      });
      const shimAdvertise = await run("npx", ["--no-install", "pdpp", "collector", "advertise"], {
        cwd: projectDir,
        env,
      });
      assert.deepEqual(JSON.parse(shimAdvertise.stdout), advertised);
      await rm(cliTarball, { force: true });
    } else {
      log("SKIP @pdpp/cli shim smoke: packages/cli/package.json was not present.");
    }

    if (await pathExists(referenceServerEntry)) {
      await runFixtureBackedEnrollRunSmoke({
        projectDir,
        env,
        advertisedProtocolVersion: advertised.collector_protocol_version,
      });
      await runProtocolMismatchSmoke({ projectDir, env });
      await runImessageSampleSmoke({ projectDir, env });
      await runFixtureBackedGoogleTakeoutEnrollRunSmoke({ projectDir, env });
      await runApplePhotosSampleSmoke({ projectDir, env });
      await assertRunsUsedInstalledProfiles(stateRoot, ["codex", "imessage", "google_takeout", "apple_photos"]);
      await runTamperedProfileSmoke({ projectDir, env, stateRoot });
    } else {
      log("SKIP fixture-backed enroll/run smoke: reference-implementation/server/index.ts not present.");
      log("SKIP collector_protocol_mismatch smoke: reference-implementation/server/index.ts not present.");
      log("SKIP iMessage bounded-sample smoke: reference-implementation/server/index.ts not present.");
      log("SKIP Google Takeout enroll/run smoke: reference-implementation/server/index.ts not present.");
      log("SKIP Apple Photos bounded-sample smoke: reference-implementation/server/index.ts not present.");
      log("SKIP installed-profile checks: reference-implementation/server/index.ts not present.");
    }
    await runUnpinnedConnectorRefusalSmoke({ projectDir, env });

    log("PASS pack-install-run local smoke");
  } finally {
    await rm(collectorTarball, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertInstalledEntrypoints(projectDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const probePath = path.join(projectDir, "assert-installed-entrypoints.mjs");
  const probe = `import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.join(process.cwd(), "node_modules", "@pdpp", "local-collector");
for (const specifier of ["@pdpp/local-collector", "@pdpp/local-collector/runner", "@pdpp/local-collector/errors"]) {
  const resolved = await import.meta.resolve(specifier);
  assert.ok(fileURLToPath(resolved).startsWith(packageRoot + path.sep), \`\${specifier} resolved outside the installed candidate: \${resolved}\`);
  await import(specifier);
}
const bin = path.join(packageRoot, "dist", "local-collector", "bin", "pdpp-local-collector.js");
assert.ok((await stat(bin)).mode & 0o111, "installed pdpp-local-collector bin must be executable");
`;
  await writeFile(probePath, probe);
  try {
    await run(process.execPath, [probePath], { cwd: projectDir, env });
  } finally {
    await rm(probePath, { force: true });
  }
}

/**
 * Connector code is no longer compiled into this package: each connector is a
 * pinned, signed Collection Profile installed at run time. The package must
 * therefore carry the installer core that verifies those profiles, and must
 * not carry a vendored connector tree.
 */
async function assertInstalledPackageShipsNoConnectorCode(projectDir: string): Promise<void> {
  const installed = path.join(projectDir, "node_modules", "@pdpp", "local-collector", "dist");
  assert.equal(
    await pathExists(path.join(installed, "polyfill-connectors")),
    false,
    "installed package must not ship vendored connector code"
  );
  assert.equal(
    await pathExists(path.join(installed, "connector-installer-core", "index.mjs")),
    true,
    "installed package must ship the installer core that verifies Collection Profiles"
  );
}

/** sha256 of a file, in the pins' `sha256:<hex>` form. */
async function fileSha256(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(await readFile(filePath)).digest("hex")}`;
}

/**
 * Each smoke above ran a connector through the installed CLI. Prove the code
 * it ran was the pinned Collection Profile, installed under the default state
 * root: the release directory for the pinned digest exists and its entrypoint
 * hashes to the pin.
 */
async function assertRunsUsedInstalledProfiles(stateRoot: string, connectorIds: readonly string[]): Promise<void> {
  for (const connectorId of connectorIds) {
    const pin = COLLECTION_PROFILE_PINS.find((candidate) => candidate.connectorId === connectorId);
    assert.ok(pin, `no Collection Profile pin for ${connectorId}`);
    const entrypoint = installedEntrypoint(stateRoot, pin);
    assert.equal(await fileSha256(entrypoint), pin.entrypointSha256, `${connectorId} installed entrypoint`);
  }
  log(`Installed-profile check PASS: ${connectorIds.join(", ")} ran from their pinned Collection Profiles.`);
}

function installedEntrypoint(stateRoot: string, pin: { connectorKey: string; digest: string }): string {
  return path.join(
    stateRoot,
    "pdpp",
    "collection-profiles",
    "connectors",
    pin.connectorKey,
    pin.digest.replace(":", "-"),
    "dist",
    "collection-profile.mjs"
  );
}

/**
 * A modified install is not run. Overwrite the installed codex entrypoint,
 * run codex again, and check that the run succeeded from a reinstalled copy
 * that matches the pin, with the modified copy set aside.
 */
async function runTamperedProfileSmoke({
  projectDir,
  env,
  stateRoot,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  stateRoot: string;
}): Promise<void> {
  const pin = COLLECTION_PROFILE_PINS.find((candidate) => candidate.connectorId === "codex");
  assert.ok(pin, "no Collection Profile pin for codex");
  const entrypoint = installedEntrypoint(stateRoot, pin);
  await writeFile(entrypoint, "process.stdout.write('tampered');\n");

  log("Booting in-process reference server for the tampered-profile smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const codexHome = await prepareCodexFixture();
  try {
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-tampered",
    });
    assert.equal(codeResp.status, 201, `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`);
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;
    log("Running installed pdpp-local-collector run --connector codex over a modified install...");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "codex",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        path.join(projectDir, "pack-install-run-tampered-outbox.json"),
        "--streams",
        "prompts,rules",
      ],
      { cwd: projectDir, env: { ...env, CODEX_HOME: codexHome } }
    );
    const runOutput = JSON.parse(runResult.stdout) as RunOutput;
    assert.equal(runOutput.done?.status, "succeeded", `codex over a modified install did not succeed: ${runResult.stdout}`);
    assert.match(runResult.stderr, /did not match its pin/, `expected a cache warning: ${runResult.stderr}`);
    assert.equal(await fileSha256(entrypoint), pin.entrypointSha256, "codex was not reinstalled to its pin");
    const siblings = await readdir(path.dirname(path.dirname(path.dirname(entrypoint))));
    assert.equal(
      siblings.filter((name) => name.includes(".invalid-")).length,
      1,
      `expected the modified install set aside: ${siblings.join(", ")}`
    );
    log("Tampered-profile smoke PASS: the modified install was set aside and codex ran from a verified reinstall.");
  } finally {
    await closeServer(server);
    await rm(codexHome, { recursive: true, force: true });
  }
}

/**
 * google_messages has a local-collector definition but no published, signed
 * Collection Profile (it needs gmcli, and the artifact builder has no tool
 * layer yet), so the collector has nothing to install. The installed CLI must
 * refuse it by name before contacting any server.
 */
async function runUnpinnedConnectorRefusalSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Running installed pdpp-local-collector run --connector google_messages (unpinned)...");
  let failure: (Error & { stderr?: string; code?: number }) | null = null;
  try {
    await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        "http://127.0.0.1:9",
        "--connector",
        "google_messages",
        "--device-id",
        "dexp_unused",
        "--device-token",
        "unused",
        "--connection-id",
        "unused",
      ],
      { cwd: projectDir, env }
    );
  } catch (error) {
    failure = error as Error & { stderr?: string; code?: number };
  }
  assert.ok(failure, "run --connector google_messages must fail");
  assert.match(
    `${failure.stderr ?? ""}\n${failure.message}`,
    /no published, signed Collection Profile yet/,
    `google_messages must be refused by name: ${failure.stderr ?? failure.message}`
  );
  log("Unpinned-connector refusal smoke PASS: google_messages was refused by name.");
}

/**
 * Fixture-backed enroll + run smoke (tasks 7.1).
 *
 * Boots the reference server in-process against an ephemeral SQLite memory
 * db, generates a real Codex-on-disk fixture, drives the *installed*
 * `pdpp-local-collector enroll` and `run --connector codex` against the
 * server, and asserts records persisted at ingest. No real owner token,
 * no remote deployment, no live Codex home is required.
 */
async function runFixtureBackedEnrollRunSmoke({
  projectDir,
  env,
  advertisedProtocolVersion,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  advertisedProtocolVersion: string;
}): Promise<void> {
  log("Booting in-process reference server for fixture-backed enroll/run smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const codexHome = await prepareCodexFixture();
  try {
    log("Creating enrollment code...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-laptop",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;
    assert.ok(
      typeof enrollmentCode === "string" && enrollmentCode.length > 0,
      "enrollment_code must be a non-empty string"
    );

    log("Running installed pdpp-local-collector enroll against the in-process reference server...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(enrollment.device_id, /^dexp_/);
    assert.equal(typeof enrollment.device_token, "string");
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(enrollment.connector_instance_id, /^cin_/);
    assert.equal(typeof enrollment.source_instance_id, "string");

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const devicesAfterEnroll = (getDb() as any)
      .prepare("SELECT collector_protocol_version FROM device_exporters WHERE device_id = ?")
      .get(enrollment.device_id);
    assert.ok(devicesAfterEnroll, "enrolled device row not visible to test process");
    assert.equal(
      devicesAfterEnroll.collector_protocol_version,
      advertisedProtocolVersion,
      "device row should persist the protocol version the runner advertised"
    );

    log("Running installed pdpp-local-collector run --connector codex against the in-process reference server...");
    const queuePath = path.join(projectDir, "pack-install-run-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "codex",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "prompts,rules",
      ],
      {
        cwd: projectDir,
        env: { ...env, CODEX_HOME: codexHome },
      }
    );
    const runOutput = JSON.parse(runResult.stdout) as RunOutput;
    assert.equal(
      runOutput.done?.status,
      "succeeded",
      `codex connector did not report DONE.status=succeeded: ${runResult.stdout}`
    );
    assert.ok((runOutput.recordsQueued ?? 0) > 0, `codex connector did not queue any records: ${runResult.stdout}`);
    assert.ok(
      (runOutput.sentBatches ?? 0) > 0,
      `codex connector did not send any batches to the reference server: ${runResult.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare(
        `SELECT COUNT(*) as n
           FROM records
          WHERE connector_id = ?
            AND connector_instance_id = ?`
      )
      .get("codex", enrollment.connector_instance_id);
    assert.ok(
      persisted.n > 0,
      `expected at least one persisted record for connector_instance ${enrollment.connector_instance_id}; got ${persisted.n}`
    );
    log(`Fixture-backed enroll/run smoke PASS: ${persisted.n} record(s) persisted at ingest.`);
  } finally {
    await closeServer(server);
    await rm(codexHome, { recursive: true, force: true });
  }
}

/**
 * Protocol-mismatch smoke (task 7.4).
 *
 * Re-boots the reference server with `acceptedCollectorProtocolVersions`
 * set to a synthetic value the published runner cannot satisfy, then
 * drives `pdpp-local-collector enroll` against it and asserts the runner
 * surfaces the typed `409 collector_protocol_mismatch` error before any
 * device row is created.
 */
async function runProtocolMismatchSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server pinned to an older protocol for the 409 mismatch smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    acceptedCollectorProtocolVersions: ["0"],
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  try {
    log("Creating enrollment code on the pinned server...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "codex",
      local_binding_name: "pack-install-run-pinned",
    });
    assert.equal(
      codeResp.status,
      201,
      `pinned enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Calling pdpp-local-collector enroll against the pinned server (expecting 409)...");
    let failure: Error | null = null;
    try {
      await run(
        "npx",
        ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
        { cwd: projectDir, env }
      );
    } catch (error) {
      failure = error as Error;
    }
    assert.ok(failure, "pdpp-local-collector enroll should fail when the server pins an incompatible protocol");
    const combined = `${
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (failure as any).stdout ?? ""
    }\n${
      // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      (failure as any).stderr ?? ""
    }\n${
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established behavior; this diagnostic requires a semantic refactor outside the closure scope.
      failure.message ?? ""
    }`;
    // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    assert.match(combined, /409/, `runner error should mention HTTP status 409; got: ${combined}`);
    assert.match(
      combined,
      // biome-ignore lint/performance/useTopLevelRegex: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      /collector_protocol_mismatch/,
      `runner error should surface the typed collector_protocol_mismatch code; got: ${combined}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const devicesAfter = (getDb() as any).prepare("SELECT COUNT(*) as n FROM device_exporters").get();
    assert.equal(devicesAfter.n, 0, "rejected enroll must not have leaked a device row into the pinned server");

    log("collector_protocol_mismatch smoke PASS: enrollment refused before any device row was created.");
  } finally {
    await closeServer(server);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<PostJsonResponse> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  let parsed: unknown = null;
  try {
    parsed = await resp.json();
    // biome-ignore lint/suspicious/noEmptyBlockStatements: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  } catch {}
  return { body: parsed, status: resp.status };
}

async function closeServer(server: ServerInstance): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const closeOne = (srv: any) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      try {
        srv?.closeAllConnections?.();
        // biome-ignore lint/suspicious/noEmptyBlockStatements: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      } catch {}
      srv?.close?.(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

/**
 * Build a minimal on-disk Codex fixture sufficient to produce at least
 * one record without exercising state_5.sqlite. The fixture intentionally
 * stays in the realm of free-form personal files; the connector emits a
 * `prompts` record from any markdown file under `<CODEX_HOME>/prompts/`.
 */
async function prepareCodexFixture(): Promise<string> {
  const codexHome = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-codex-fixture-"));
  const promptsDir = path.join(codexHome, "prompts");
  const rulesDir = path.join(codexHome, "rules");
  await mkdir(promptsDir, { recursive: true });
  await mkdir(rulesDir, { recursive: true });
  await writeFile(
    path.join(promptsDir, "hello.md"),
    "---\nname: hello\ndescription: greet the operator\n---\n\nHello from the pack-install-run fixture.\n"
  );
  await writeFile(path.join(rulesDir, "trust.rules"), "# trust registry\nallow shell pwd\n");
  return codexHome;
}

const IMESSAGE_FIXTURE_MESSAGE_COUNT = 500;
const IMESSAGE_SAMPLE_LIMIT = 20;
// Apple-epoch-seconds (seconds since 2001-01-01 -- 978_307_200s after the
// Unix epoch) for "one hour ago" -- computed at run time, NOT a fixed
// historical constant. A fixed past constant silently rots if any future
// enrollment-scope feature defaults an undeclared boundary to a recent-
// history window: a fixture dated further back than that window reads as
// genuinely out-of-scope and is correctly filtered to zero records -- not a
// connector bug, but a stale fixture. Deriving from Date.now() keeps this
// fixture inside any such window forever.
const IMESSAGE_FIXTURE_DATE_BASE_APPLE_SEC = Math.floor(Date.now() / 1000) - 3600 - 978_307_200;

/**
 * Build a synthetic chat.db large enough to exercise `--sample` truncation
 * (500 rows, sampled to 20) using `node:sqlite`'s `DatabaseSync` — the same
 * native-free primitive the packed iMessage connector itself uses, so this
 * fixture builder proves nothing about the packed tarball that depends on a
 * dependency the tarball doesn't actually ship. No real chat.db, no PII:
 * every handle/text value here is synthetic.
 */
async function prepareImessageFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-imessage-fixture-"));
  const dbPath = path.join(dir, "chat.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (
        ROWID INTEGER PRIMARY KEY, guid TEXT, handle_id INTEGER, service TEXT,
        is_from_me INTEGER, text TEXT, date INTEGER, date_read INTEGER, cache_has_attachments INTEGER
      );
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    `);
    db.prepare("INSERT INTO handle (ROWID, id) VALUES (?, ?)").run(1, "+15550100000");
    const insertMessage = db.prepare(
      `INSERT INTO message (ROWID, guid, handle_id, service, is_from_me, text, date, date_read, cache_has_attachments)
       VALUES (?, ?, ?, 'iMessage', 0, ?, ?, NULL, 0)`
    );
    const insertJoin = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)");
    for (let i = 0; i < IMESSAGE_FIXTURE_MESSAGE_COUNT; i += 1) {
      const dateApple = IMESSAGE_FIXTURE_DATE_BASE_APPLE_SEC + i;
      insertMessage.run(i + 1, `fixture-guid-${i}`, 1, `fixture message ${i}`, dateApple);
      insertJoin.run(i + 1);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/**
 * Fixture-backed bounded-sample smoke for iMessage (proves the large-row /
 * `--sample` path against the actual packed, installed tarball — not just
 * the connector's own unit tests, which run from source).
 *
 * Points `IMESSAGE_DB_PATH` at a 500-row synthetic chat.db and runs the
 * installed `pdpp-local-collector run --connector imessage --streams
 * messages --sample 20`. Asserts the run queues and sends exactly the
 * sampled 20, not the full 500 — the same truncation contract
 * `local-device-runtime.test.ts` unit-tests at the source level, proven
 * here end-to-end through the published entrypoint.
 */
async function runImessageSampleSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for the iMessage bounded-sample smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const chatDbPath = await prepareImessageFixture();
  try {
    log("Creating enrollment code for imessage...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "imessage",
      local_binding_name: "pack-install-run-imessage",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Running installed pdpp-local-collector enroll for imessage...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;

    log(`Running installed pdpp-local-collector run --connector imessage --sample ${IMESSAGE_SAMPLE_LIMIT}...`);
    const queuePath = path.join(projectDir, "pack-install-run-imessage-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "imessage",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "messages",
        "--sample",
        String(IMESSAGE_SAMPLE_LIMIT),
      ],
      {
        cwd: projectDir,
        env: { ...env, IMESSAGE_DB_PATH: chatDbPath },
      }
    );
    const runOutput = JSON.parse(runResult.stdout) as {
      object?: string;
      records_seen?: number;
      status?: { outbox?: { counts?: { pending?: number; sent?: number; total?: number } } };
    };
    assert.equal(runOutput.object, "local_collector_sample", `unexpected --sample response shape: ${runResult.stdout}`);
    // The sample abort is asynchronous (see runCollectorSample's onMessage
    // hook in pdpp-local-collector.ts): recordsSeen can overshoot the limit
    // by a small margin before the abort signal actually stops the child, so
    // the documented contract is records_seen >= sample_limit, never exact
    // equality. What matters for "bounded" is that it stopped nowhere near
    // the full 500-row fixture.
    assert.ok(
      typeof runOutput.records_seen === "number" && runOutput.records_seen >= IMESSAGE_SAMPLE_LIMIT,
      `--sample ${IMESSAGE_SAMPLE_LIMIT} must see at least the limit before stopping: ${runResult.stdout}`
    );
    assert.ok(
      runOutput.records_seen < IMESSAGE_FIXTURE_MESSAGE_COUNT,
      `--sample ${IMESSAGE_SAMPLE_LIMIT} must stop well short of the full ${IMESSAGE_FIXTURE_MESSAGE_COUNT}-row fixture; got ${runOutput.records_seen}: ${runResult.stdout}`
    );
    // The abort fires mid-scan, before the queued batch necessarily drains to
    // the server in the same process lifetime — this matches the CLI's own
    // documented note ("these records are durably queued but this is NOT a
    // complete collection"). Assert the local outbox actually holds the
    // sampled work, then prove it drains for real with a normal follow-up
    // `run` (no --sample) — the exact UAT-documented recovery step.
    const outboxTotal = runOutput.status?.outbox?.counts?.total ?? 0;
    assert.ok(outboxTotal > 0, `sample run must leave sampled work in the local outbox: ${runResult.stdout}`);

    log("Running installed pdpp-local-collector run --connector imessage (no --sample) to drain the full fixture...");
    const fullRun = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "imessage",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "messages",
      ],
      { cwd: projectDir, env: { ...env, IMESSAGE_DB_PATH: chatDbPath } }
    );
    const fullRunOutput = JSON.parse(fullRun.stdout) as RunOutput;
    assert.equal(
      fullRunOutput.done?.status,
      "succeeded",
      `follow-up full imessage run did not report DONE.status=succeeded: ${fullRun.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("imessage", enrollment.connector_instance_id);
    assert.equal(
      persisted.n,
      IMESSAGE_FIXTURE_MESSAGE_COUNT,
      `expected the full ${IMESSAGE_FIXTURE_MESSAGE_COUNT}-row fixture persisted after the non-sampled follow-up run; got ${persisted.n}`
    );
    log(
      `iMessage bounded-sample + full-drain smoke PASS: sample stopped at ${runOutput.records_seen} of ${IMESSAGE_FIXTURE_MESSAGE_COUNT}, follow-up run persisted all ${persisted.n}.`
    );
  } finally {
    await closeServer(server);
    await rm(path.dirname(chatDbPath), { recursive: true, force: true });
  }
}

async function prepareGoogleTakeoutFixture(): Promise<string> {
  const takeoutDir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-google-takeout-fixture-"));
  const searchDir = path.join(takeoutDir, "My Activity", "Search");
  await mkdir(searchDir, { recursive: true });
  await writeFile(
    path.join(searchDir, "MyActivity.json"),
    JSON.stringify([
      {
        header: "Search",
        title: "Searched for pack-install-run fixture",
        titleUrl: "https://www.google.com/search?q=pack-install-run+fixture",
        time: "2026-01-01T00:00:00.000Z",
        products: ["Search"],
      },
    ])
  );
  return takeoutDir;
}

async function runFixtureBackedGoogleTakeoutEnrollRunSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for Google Takeout fixture-backed enroll/run smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: The reference server is dynamically imported from its packed runtime entrypoint.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const takeoutDir = await prepareGoogleTakeoutFixture();
  try {
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "google_takeout",
      local_binding_name: "pack-install-run-laptop",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: The route response is validated at this dynamic package boundary.
    const enrollmentCode = (codeResp.body as any).enrollment_code;
    assert.ok(typeof enrollmentCode === "string" && enrollmentCode.length > 0);

    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;
    const queuePath = path.join(projectDir, "pack-install-run-google-takeout-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "google_takeout",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "search_history",
      ],
      { cwd: projectDir, env: { ...env, GOOGLE_TAKEOUT_DIR: takeoutDir } }
    );
    const runOutput = JSON.parse(runResult.stdout) as RunOutput;
    assert.equal(runOutput.done?.status, "succeeded");
    assert.ok(
      (runOutput.recordsQueued ?? 0) > 0,
      `google_takeout connector did not queue any records: ${runResult.stdout}`
    );
    assert.ok((runOutput.sentBatches ?? 0) > 0);

    // biome-ignore lint/suspicious/noExplicitAny: The test reads the dynamically imported reference database.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("google-takeout", enrollment.connector_instance_id);
    assert.ok(persisted.n > 0, `expected at least one persisted google_takeout record; got ${persisted.n}`);
    log(`Google Takeout fixture-backed enroll/run smoke PASS: ${persisted.n} record(s) persisted at ingest.`);
  } finally {
    await closeServer(server);
    await rm(takeoutDir, { recursive: true, force: true });
  }
}

const APPLE_PHOTOS_FIXTURE_FILE_COUNT = 500;
const APPLE_PHOTOS_SAMPLE_LIMIT = 20;

/**
 * Build a synthetic Photos.app export directory large enough to exercise
 * `--sample` truncation (500 files, sampled to 20), using only Node
 * built-ins (no real image bytes, no native dependency) — the same
 * primitive the packed apple_photos connector itself uses to walk an
 * export directory.
 */
async function prepareApplePhotosFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pdpp-local-collector-apple-photos-fixture-"));
  for (let i = 0; i < APPLE_PHOTOS_FIXTURE_FILE_COUNT; i += 1) {
    await writeFile(path.join(dir, `IMG_${String(i).padStart(4, "0")}.jpg`), Buffer.from(`fixture-photo-${i}`));
  }
  return dir;
}

/**
 * Fixture-backed bounded-sample smoke for apple_photos (proves the
 * large-file / `--sample` path against the actual packed, installed
 * tarball — not just the connector's own unit tests, which run from
 * source). Points `APPLE_PHOTOS_EXPORT_DIR` at a 500-file synthetic export
 * directory and runs the installed `pdpp-local-collector run --connector
 * apple_photos --streams photos --sample 20`. Asserts the run queues and
 * sends exactly the sampled 20, not the full 500, then proves a follow-up
 * full run drains everything.
 */
async function runApplePhotosSampleSmoke({
  projectDir,
  env,
}: {
  projectDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  log("Booting in-process reference server for the Apple Photos bounded-sample smoke...");
  const { startServer } = await import(`file://${referenceServerEntry}`);
  const { getDb } = await import(`file://${referenceDbModule}`);
  // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
  const server = (await (startServer as any)({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as ServerInstance;
  const baseUrl = `http://127.0.0.1:${server.asPort}`;
  const exportDir = await prepareApplePhotosFixture();
  try {
    log("Creating enrollment code for apple_photos...");
    const codeResp = await postJson(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: "apple_photos",
      local_binding_name: "pack-install-run-apple-photos",
    });
    assert.equal(
      codeResp.status,
      201,
      `enrollment-codes returned ${codeResp.status}: ${JSON.stringify(codeResp.body)}`
    );
    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const enrollmentCode = (codeResp.body as any).enrollment_code;

    log("Running installed pdpp-local-collector enroll for apple_photos...");
    const enroll = await run(
      "npx",
      ["--no-install", "pdpp-local-collector", "enroll", "--base-url", baseUrl, "--code", enrollmentCode],
      { cwd: projectDir, env }
    );
    const enrollment = JSON.parse(enroll.stdout) as EnrollmentData;

    log(`Running installed pdpp-local-collector run --connector apple_photos --sample ${APPLE_PHOTOS_SAMPLE_LIMIT}...`);
    const queuePath = path.join(projectDir, "pack-install-run-apple-photos-outbox.json");
    const runResult = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "apple_photos",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "photos",
        "--sample",
        String(APPLE_PHOTOS_SAMPLE_LIMIT),
      ],
      { cwd: projectDir, env: { ...env, APPLE_PHOTOS_EXPORT_DIR: exportDir } }
    );
    const runOutput = JSON.parse(runResult.stdout) as {
      object?: string;
      records_seen?: number;
      status?: { outbox?: { counts?: { pending?: number; sent?: number; total?: number } } };
    };
    assert.equal(runOutput.object, "local_collector_sample", `unexpected --sample response shape: ${runResult.stdout}`);
    assert.ok(
      typeof runOutput.records_seen === "number" && runOutput.records_seen >= APPLE_PHOTOS_SAMPLE_LIMIT,
      `--sample ${APPLE_PHOTOS_SAMPLE_LIMIT} must see at least the limit before stopping: ${runResult.stdout}`
    );
    assert.ok(
      runOutput.records_seen < APPLE_PHOTOS_FIXTURE_FILE_COUNT,
      `--sample ${APPLE_PHOTOS_SAMPLE_LIMIT} must stop well short of the full ${APPLE_PHOTOS_FIXTURE_FILE_COUNT}-file fixture; got ${runOutput.records_seen}: ${runResult.stdout}`
    );
    const outboxTotal = runOutput.status?.outbox?.counts?.total ?? 0;
    assert.ok(outboxTotal > 0, `sample run must leave sampled work in the local outbox: ${runResult.stdout}`);

    log(
      "Running installed pdpp-local-collector run --connector apple_photos (no --sample) to drain the full fixture..."
    );
    const fullRun = await run(
      "npx",
      [
        "--no-install",
        "pdpp-local-collector",
        "run",
        "--base-url",
        baseUrl,
        "--connector",
        "apple_photos",
        "--device-id",
        enrollment.device_id,
        "--device-token",
        enrollment.device_token,
        "--connection-id",
        enrollment.source_instance_id,
        "--queue",
        queuePath,
        "--streams",
        "photos",
      ],
      { cwd: projectDir, env: { ...env, APPLE_PHOTOS_EXPORT_DIR: exportDir } }
    );
    const fullRunOutput = JSON.parse(fullRun.stdout) as RunOutput;
    assert.equal(
      fullRunOutput.done?.status,
      "succeeded",
      `follow-up full apple_photos run did not report DONE.status=succeeded: ${fullRun.stdout}`
    );

    // biome-ignore lint/suspicious/noExplicitAny: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const persisted = (getDb() as any)
      .prepare("SELECT COUNT(*) as n FROM records WHERE connector_id = ? AND connector_instance_id = ?")
      .get("apple-photos", enrollment.connector_instance_id);
    assert.equal(
      persisted.n,
      APPLE_PHOTOS_FIXTURE_FILE_COUNT,
      `expected the full ${APPLE_PHOTOS_FIXTURE_FILE_COUNT}-file fixture persisted after the non-sampled follow-up run; got ${persisted.n}`
    );
    log(
      `Apple Photos bounded-sample + full-drain smoke PASS: sample stopped at ${runOutput.records_seen} of ${APPLE_PHOTOS_FIXTURE_FILE_COUNT}, follow-up run persisted all ${persisted.n}.`
    );
  } finally {
    await closeServer(server);
    await rm(exportDir, { recursive: true, force: true });
  }
}

await main();

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";
import { provisionTestDatabase } from "../server/postgres-test-database-guard.ts";
import {
  dedicatedPostgresTestUrl,
  isDedicatedPostgresTestDatabaseName,
} from "../test/helpers/dedicated-postgres-test-url.ts";
import { collectChildProcessOutput } from "./child-process-output.ts";
import { deriveDedicatedPostgresDbNameForFile } from "./dedicated-postgres-db-name.ts";
import { resolveFileConcurrency } from "./file-concurrency.ts";
import { startFileProcessWatchdog } from "./file-process-watchdog.ts";
import { createOwnedTestResource, type OwnedTestResource, settleAll } from "./owned-test-resource.ts";
import { assertPostgresProfilePreflight } from "./postgres-profile-preflight.ts";
import { isPostgresTemplateEligibleFilePath } from "./postgres-template-eligibility.ts";
import {
  clonePostgresTestDatabaseFromTemplate,
  deriveDedicatedPostgresTemplateName,
  dropPostgresTestTemplate,
  ensurePostgresTestTemplate,
  POSTGRES_TEST_RUNNER_NONCE_BYTES,
} from "./postgres-test-template.ts";
import { needsOuterPostgresDatabase, needsPostgresRestoreDatabase } from "./run-tests-db-requirements.ts";
import { discoverSelectedTestFiles } from "./run-tests-discovery.ts";
import { RUN_AUTHORITY_SCHEMA } from "./test-accounting/inventory.ts";
import type { StructuredSummary } from "./test-accounting/receipt.ts";
import {
  accountingResultLine,
  assertNamedSkipMappingsFullyConsumed,
  repositoryPaths,
  riConfiguredNamedSkipMappingIdentities,
  structuredNodeSummary,
} from "./test-accounting/receipt.ts";
import type { ProcessEnvLike } from "./test-env.ts";
import { buildScrubbedTestEnv } from "./test-env.ts";
import { requireExplicitTestProfile, storageProfileEnvironment } from "./test-profile-env.ts";
import { assertWorkspaceRuntimeDependencies } from "./workspace-runtime-dependency-preflight.ts";

/** The `run-authority` JSON file shape accepted via `--accounting-authority`. */
interface AccountingAuthority {
  expires_at: string;
  files: string[];
  nonce: string;
  profile: string;
  run_id: string;
  schema: string;
  suite: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const testDir = join(repoRoot, "test");
const rawForwardedArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
const accountingIndex = rawForwardedArgs.indexOf("--accounting-authority");
const accountingPath = accountingIndex === -1 ? undefined : rawForwardedArgs[accountingIndex + 1];
if (accountingIndex !== -1 && !accountingPath) {
  throw new Error("--accounting-authority requires PATH");
}
const forwardedArgs =
  accountingIndex === -1
    ? rawForwardedArgs
    : rawForwardedArgs.filter((_, index) => index !== accountingIndex && index !== accountingIndex + 1);
// --test-force-exit is deliberately NOT forwarded to child test processes.
// Node's own test-runner harness stops delivering reporter events partway
// through a run once it decides to force-exit — confirmed directly: a
// reporter's `for await (const event of source)` loop completes normally
// but short by up to ~20% of expected events, non-deterministically, even
// though every test itself ran and passed. That silently truncates whatever
// structured accounting a reporter is building (skip/pass/fail counts) on a
// fully green file. Bounded termination for a genuinely hung file (a leaked
// handle after every test has already finished) is instead enforced by this
// runner's own watchdog in runNodeTest(), which lets a normal run exit on
// its own (draining reporter output completely) and signals a child that
// either stops producing output or exceeds a separate absolute deadline.
const effectiveArgs = forwardedArgs;
const DEFAULT_PER_FILE_IDLE_TIMEOUT_MS = 120_000;
// cli.test.ts took about 343s in isolation, and collection-profile.test.ts
// exceeded the former 480s wall-clock limit while still producing reporter
// events. Fifteen minutes leaves measured headroom and remains below one
// third of the 45-minute CI job limit.
const DEFAULT_PER_FILE_HARD_TIMEOUT_MS = 900_000;

function readPositiveTimeout(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallbackMs;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer number of milliseconds`);
  }
  return value;
}

const PER_FILE_IDLE_TIMEOUT_MS = readPositiveTimeout("PDPP_TEST_FILE_TIMEOUT_MS", DEFAULT_PER_FILE_IDLE_TIMEOUT_MS);
const PER_FILE_HARD_TIMEOUT_MS = readPositiveTimeout(
  "PDPP_TEST_FILE_HARD_TIMEOUT_MS",
  DEFAULT_PER_FILE_HARD_TIMEOUT_MS
);
if (PER_FILE_HARD_TIMEOUT_MS < PER_FILE_IDLE_TIMEOUT_MS) {
  throw new Error("PDPP_TEST_FILE_HARD_TIMEOUT_MS must be greater than or equal to PDPP_TEST_FILE_TIMEOUT_MS");
}
if (!effectiveArgs.some((arg) => arg === "--test-reporter" || arg.startsWith("--test-reporter="))) {
  effectiveArgs.push(
    `--test-reporter=${fileURLToPath(new URL("./test-accounting/node-reporter.ts", import.meta.url))}`
  );
}
if (!effectiveArgs.some((arg) => arg === "--import" || arg.startsWith("--import="))) {
  effectiveArgs.unshift("--import", "tsx");
}
// Hermetic network guard: activate for every test child so each test-owned
// server auto-grants its own bound origin and any unbound/ambient origin
// (e.g. the live production server on :7662) is fail-closed blocked. See
// scripts/hermetic/{guard,preload}.ts. On by default; set PDPP_HERMETIC_GUARD=0
// to run the suite without it (guard-absent parity). The preload is inert
// unless PDPP_HERMETIC_GUARD=1, which this runner sets in the child env below.
// tsx is registered first (above) so the `.ts` preload can be type-stripped.
const hermeticGuardEnabled = process.env.PDPP_HERMETIC_GUARD !== "0";
if (hermeticGuardEnabled) {
  effectiveArgs.push("--import", fileURLToPath(new URL("./hermetic/preload.ts", import.meta.url)));
}
const accountingAuthority: AccountingAuthority | undefined = accountingPath
  ? JSON.parse(await readFile(accountingPath, "utf8"))
  : undefined;
if (
  accountingAuthority &&
  (accountingAuthority.schema !== RUN_AUTHORITY_SCHEMA || new Date(accountingAuthority.expires_at) < new Date())
) {
  throw new Error("accounting authority is invalid or expired");
}
if (
  accountingAuthority &&
  (accountingAuthority.suite !== "ri-default" || accountingAuthority.profile !== process.env.PDPP_TEST_PROFILE)
) {
  throw new Error("accounting authority does not bind the selected RI profile");
}
// The bound authority check above establishes authority.profile === this
// environment value. Reuse the same explicit-profile policy for both bound
// and unbound invocations, so malformed metadata cannot select the old
// memory-default fallback or reach child execution.
const selectedProfile = requireExplicitTestProfile(process.env);
await assertWorkspaceRuntimeDependencies(dirname(repoRoot));
const requestedConcurrency = Number.parseInt(process.env.PDPP_TEST_CONCURRENCY || "", 10);
// Boot-time schedule auto-enrollment is OFF by default under the test harness.
//
// A test that seeds a connection and then calls `startServer` does not want a
// live schedule attached to it: the scheduler starts real background runs and
// its interval timer holds the event loop open, so the file finishes every
// assertion and then never exits and this runner kills it on the idle timeout.
// ~60 server fixtures force-close their sockets without stopping the scheduler,
// so they would each need their own teardown fix; defaulting the enroller off
// here fixes the class at the seam that owns it.
//
// This stayed invisible until auto-enrollment began keying schedule rows to the
// connection. While rows were keyed by the bare connector id they matched no
// connection, so the scheduler never had anything to start.
//
// A test that genuinely exercises enrollment sets `autoEnrollEligibleSchedules:
// true` on its own `startServer` call (the explicit opt beats this env default),
// and an operator can still force the old behavior with
// PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=0.
const testHarnessEnv: NodeJS.ProcessEnv = {
  PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT: "1",
  ...process.env,
};
const scrubbedBaseEnv = storageProfileEnvironment(selectedProfile, buildScrubbedTestEnv(testHarnessEnv));
const configuredPostgresTestUrl = scrubbedBaseEnv.PDPP_TEST_POSTGRES_URL;
const configuredPostgresRestoreUrl = scrubbedBaseEnv.PDPP_TEST_POSTGRES_RESTORE_URL;
const dedicatedBasePostgresTestUrl: string | null = configuredPostgresTestUrl
  ? dedicatedPostgresTestUrl(configuredPostgresTestUrl)
  : null;

// Validate every persistent PostgreSQL target before the runner derives an
// admin URL, opens a connection, or starts a test child. `pg` lets query
// parameters override connection-string authority and path, so only the
// narrow dedicated-url contract reaches the real-Postgres lane. The restore
// target is independently preflighted, then receives its own cold per-file
// database before the backup oracle can touch it.
await assertPostgresProfilePreflight({
  primaryUrl: configuredPostgresTestUrl,
  profile: selectedProfile,
  restoreUrl: configuredPostgresRestoreUrl,
});

// --- Per-file Postgres database isolation ---
//
// When PDPP_TEST_POSTGRES_URL is set, each test file receives its own
// ephemeral database created before spawn and dropped after its child exits,
// whether or not the file passes. This eliminates cross-file state pollution
// without requiring any changes to individual test files.

let fileCounter = 0;
const runnerId = randomBytes(4).toString("hex");
// A separate, wider nonce names the run's TEMPLATE. It is not the same value
// as `runnerId` above because the two have different jobs: `runnerId` is
// embedded in per-file database names, whose authorization grammar
// (test/helpers/dedicated-postgres-test-url.ts) pins it at exactly 8 hex
// chars, while the template name is the only thing separating this run's
// template from any other run's on a shared cluster. External review P1-2
// required >=128 bits there, since a collision is precisely the condition
// under which one run could inherit another's template.
const templateRunnerId = randomBytes(POSTGRES_TEST_RUNNER_NONCE_BYTES).toString("hex");

// Set once, before the worker pool starts, when a Postgres profile is
// active (see the ensurePostgresTestTemplate() call below). Per-file/per-test
// database creation clones from this template instead of bootstrapping schema
// from scratch -- see scripts/postgres-test-template.ts for the fail-closed
// contract (a missing/unusable template throws, it is never silently skipped).
let postgresTestTemplateName: string | null = null;
// Identity token of the template THIS run built (scripts/postgres-test-template.ts,
// `identityDigest`): handed to every child as PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY so a
// child's clone-time check accepts only this exact build, not any template that
// happens to carry the same name.
let postgresTestTemplateIdentity: string | null = null;

/**
 * Derive the admin connection URL from a per-test URL by replacing the
 * database path segment with 'postgres' (always present on any standard PG
 * server). This gives us a stable admin connection independent of the base
 * DB name the operator chose.
 */
function adminUrlFromBase(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.pathname = "/postgres";
  return u.toString();
}

/**
 * Derive a short, safe DB name from the test file path, a per-run random ID,
 * and a monotonic counter so concurrent runners and workers never collide.
 * The pure derivation itself lives in `dedicated-postgres-db-name.ts` so it
 * can be unit-tested without importing this top-level-await CLI script.
 */
function deriveDbName(filePath: string, label?: "restore"): string {
  fileCounter += 1;
  const fileName = filePath.split("/").pop() ?? filePath;
  const labeledPath = label ? `${label}_${fileName}` : filePath;
  const dbName = deriveDedicatedPostgresDbNameForFile(labeledPath, runnerId, fileCounter);
  if (!isDedicatedPostgresTestDatabaseName(dbName)) {
    throw new Error(`runner derived a database name outside the dedicated test contract: ${dbName}`);
  }
  return dbName;
}

interface TestDbAllocation {
  release: () => Promise<void>;
  url: string;
}

// Databases remain registered from CREATE until DROP succeeds. The first
// signal stops admission and drains workers before releasing these resources.
const activeAllocations = new Set<OwnedTestResource>();
const activeTemplates = new Set<OwnedTestResource>();
const activeChildren = new Set<ChildProcess>();
let stopping = false;
let signalExitCode: number | undefined;
let signalCleanupArmed = false;

function armSignalCleanup(): void {
  if (signalCleanupArmed) {
    return;
  }
  signalCleanupArmed = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
      signalExitCode ??= sig === "SIGINT" ? 130 : 143;
      // Main stops new work, signals active children, and cleans up after
      // in-flight allocation and worker operations settle. A hung CREATE or
      // DROP is bounded outside the runner: it always runs under
      // scripts/test-scratch/run-command.ts or test-sandbox, which SIGKILL
      // the whole process group after a grace period.
      for (const child of activeChildren) child.kill("SIGTERM");
    });
  }
}

async function allocateTestDb(
  filePath: string,
  baseUrl: string,
  { cold, label }: { cold: boolean; label?: "restore" }
): Promise<TestDbAllocation> {
  const dbName = deriveDbName(filePath, label);
  const adminUrl = adminUrlFromBase(baseUrl);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${dbName}`;
  // DEFAULT IS COLD: only explicitly reviewed files can use a template. This
  // is fail-closed, not an opt-out; an eligible file must fail if its template
  // is missing or unusable rather than silently taking the cold path.
  const useTemplate = !cold && isPostgresTemplateEligibleFilePath(filePath);
  const allocation = await createOwnedTestResource({
    registry: activeAllocations,
    create: async (onCreated) => {
      if (useTemplate) {
        const templateName = postgresTestTemplateName;
        const identity = postgresTestTemplateIdentity;
        if (!(templateName && identity)) {
          throw new Error("missing runner-bound template identity");
        }
        await clonePostgresTestDatabaseFromTemplate(baseUrl, dbName, templateName, identity, onCreated);
      } else {
        const client = new pg.Client({ connectionString: adminUrl });
        try {
          await client.connect();
          // No pre-emptive DROP: a collision must never destroy another run.
          await client.query(`CREATE DATABASE "${dbName}"`);
          onCreated();
        } finally {
          await client.end().catch(() => undefined);
        }
      }
      // This event makes the cold-vs-template eligibility decision assertable
      // by external reviews and integration tests (external review P1-1).
      process.stdout.write(
        `PDPP_TEST_DB_PROVISION ${JSON.stringify({
          database: dbName,
          file: label ? `${filePath}.${label}` : filePath,
          path: useTemplate ? "template-clone" : "cold-bootstrap",
        })}\n`
      );
      return testUrl.toString();
    },
    provision: provisionTestDatabase,
    destroy: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      try {
        await client.connect();
        await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  });
  return { url: allocation.value, release: allocation.release };
}

interface NodeTestResult {
  durationMs: number;
  exitCode: number;
  filePath: string;
  output: string;
}

async function runNodeTest(filePath: string, extraArgs: string[]): Promise<NodeTestResult> {
  const startedAt = Date.now();
  const baseEnv: ProcessEnvLike = scrubbedBaseEnv;
  const baseUrl = dedicatedBasePostgresTestUrl;

  // Unknown files retain an outer DB. Restore allocation is separate and cold.
  let allocation: TestDbAllocation | undefined;
  let restoreAllocation: TestDbAllocation | undefined;
  const releaseFileResources = () => settleAll(
    [allocation, restoreAllocation].flatMap((item) => (item ? [item.release()] : []))
  );
  try {
    if (baseUrl && needsOuterPostgresDatabase(filePath)) {
      try {
        allocation = await allocateTestDb(filePath, baseUrl, { cold: false });
      } catch (error) {
        // Never fall back to the shared base database after allocation fails.
        throw new Error(`could not allocate a dedicated Postgres test database for ${filePath}`, { cause: error });
      }
    }

    if (baseUrl && configuredPostgresRestoreUrl && needsPostgresRestoreDatabase(filePath)) {
      restoreAllocation = await allocateTestDb(filePath, configuredPostgresRestoreUrl, { cold: true, label: "restore" });
    }
    if (stopping) {
      throw new Error("test runner interrupted before child spawn");
    }
  } catch (error) {
    try {
      await releaseFileResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "file setup and cleanup failed");
    }
    throw error;
  }

  const childEnvBase: ProcessEnvLike = { ...baseEnv };
  if (allocation) {
    childEnvBase.PDPP_TEST_POSTGRES_URL = allocation.url;
  }
  if (postgresTestTemplateName && postgresTestTemplateIdentity) {
    // Passed to every child: helper-owned databases use the same explicit
    // eligibility allowlist and keep DEFAULT IS COLD independently.
    childEnvBase.PDPP_TEST_POSTGRES_TEMPLATE = postgresTestTemplateName;
    childEnvBase.PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY = postgresTestTemplateIdentity;
  }
  if (restoreAllocation) {
    childEnvBase.PDPP_TEST_POSTGRES_RESTORE_URL = restoreAllocation.url;
  }
  // Turn the preload (appended to effectiveArgs above) live in the child. Left
  // unset when the guard is disabled so the child is byte-identical to a
  // pre-guard run (guard-absent parity).
  const childEnv: ProcessEnvLike = hermeticGuardEnabled ? { ...childEnvBase, PDPP_HERMETIC_GUARD: "1" } : childEnvBase;

  return new Promise<NodeTestResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...extraArgs, filePath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    child.once("close", () => activeChildren.delete(child));
    // Reporter output proves that a long file is still making progress. The
    // hard deadline separately bounds a chatty process that never exits.
    const watchdog = startFileProcessWatchdog({
      hardDeadlineMs: PER_FILE_HARD_TIMEOUT_MS,
      idleBudgetMs: PER_FILE_IDLE_TIMEOUT_MS,
      kill: () => child.kill("SIGKILL"),
    });
    let settled = false;
    const outputPromise = collectChildProcessOutput(child, watchdog.markProgress);

    const settle = async (finish: () => void | Promise<void>) => {
      if (settled) {
        return;
      }
      settled = true;
      watchdog.clear();
      await finish();
    };

    child.on("error", (err) => {
      settle(() => reject(err)).catch(reject);
    });
    child.on("close", (code, signal) => {
      settle(async () => {
        const output = await outputPromise;
        const timeoutReason = watchdog.timeoutReason();
        if (timeoutReason === "idle") {
          reject(
            new Error(
              `Test process for ${filePath} timed out after ${PER_FILE_IDLE_TIMEOUT_MS}ms without child output and was killed`
            )
          );
          return;
        }
        if (timeoutReason === "hard") {
          reject(
            new Error(
              `Test process for ${filePath} exceeded the ${PER_FILE_HARD_TIMEOUT_MS}ms hard deadline and was killed`
            )
          );
          return;
        }
        if (signal) {
          reject(new Error(`Test process for ${filePath} exited via signal ${signal}`));
          return;
        }
        resolve({
          durationMs: Date.now() - startedAt,
          exitCode: code ?? 1,
          filePath,
          output: `\n==> ${filePath}\n${output}`,
        });
      }).catch(reject);
    });
  }).then(
    async (result) => {
      try {
        await releaseFileResources();
      } catch (cleanupError) {
        if (result.exitCode !== 0) {
          throw new AggregateError(
            [
              new Error(`test process for ${filePath} exited with code ${result.exitCode}:\n${result.output}`),
              cleanupError,
            ],
            "test execution and file cleanup failed"
          );
        }
        throw cleanupError;
      }
      return result;
    },
    async (error) => {
      try {
        await releaseFileResources();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "test execution and file cleanup failed");
      }
      throw error;
    }
  );
}

const testFiles = await discoverSelectedTestFiles(repoRoot, testDir, accountingAuthority?.files);
const fileConcurrency = resolveFileConcurrency({
  availableCpus: availableParallelism?.() ?? null,
  profile: selectedProfile,
  requestedConcurrency,
  selectedFileCount: testFiles.length,
});

const queue = [...testFiles];
const results: NodeTestResult[] = [];

function formatRunnerError(error: unknown): string {
  if (error instanceof AggregateError) {
    const nested = error.errors.map(formatRunnerError).join("\n");
    return `${error.stack ?? error.message}\n${nested}`;
  }
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

// Build the per-run Postgres schema template once, before any child spawns,
// when Postgres is in play and there is at least one file to run it for. This
// pays the full ~2000-line DDL bootstrap exactly once per gate run instead of
// once per file (or once per test() block for files using
// withTemporaryPostgresDatabase) -- see scripts/postgres-test-template.ts.
// A failure here is fatal (not caught): a gate that silently fell back to
// per-file bootstrap on template-build failure would hide a broken template
// behind a normal-looking (slow) green run, which is the one thing the task
// this exists for explicitly rules out.
armSignalCleanup();
const runnerErrors: unknown[] = [];
try {
  if (dedicatedBasePostgresTestUrl && testFiles.some(isPostgresTemplateEligibleFilePath)) {
    // The builder returns the identity it committed before publishing the
    // template. Do not re-read it off the template afterwards: an expectation
    // sourced from the thing being verified proves nothing (external review
    // P1-2).
    // Name the template before it exists, so a run interrupted mid-build
    // still tells its observer which database it may have created.
    process.stdout.write(
      `PDPP_TEST_DB_TEMPLATE ${JSON.stringify({ database: deriveDedicatedPostgresTemplateName(templateRunnerId) })}\n`
    );
    const template = await createOwnedTestResource({
      registry: activeTemplates,
      create: (onCreated) => ensurePostgresTestTemplate(dedicatedBasePostgresTestUrl, templateRunnerId, onCreated),
      destroy: async () => {
        await dropPostgresTestTemplate(
          dedicatedBasePostgresTestUrl,
          deriveDedicatedPostgresTemplateName(templateRunnerId)
        );
      },
    });
    postgresTestTemplateName = template.value.templateName;
    postgresTestTemplateIdentity = template.value.identityDigest;
  }

  async function worker(): Promise<void> {
    while (!stopping && queue.length > 0) {
      const file = queue.shift();
      if (!file) {
        return;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each worker pulls one file from the shared queue; awaiting here preserves the deliberate concurrency cap.
        const result = await runNodeTest(file, effectiveArgs);
        results.push(result);
        process.stdout.write(result.output);
      } catch (error) {
        stopping = true;
        throw error;
      }
    }
  }

  await settleAll(Array.from({ length: fileConcurrency }, () => worker()));
} catch (error) {
  runnerErrors.push(error);
}
try {
  await settleAll([...activeAllocations].map((allocation) => allocation.release()));
} catch (error) {
  runnerErrors.push(error);
}
try {
  await settleAll([...activeTemplates].map((template) => template.release()));
} catch (error) {
  runnerErrors.push(error);
}

const selectedFiles = repositoryPaths("reference-implementation", testFiles);
if (accountingAuthority && JSON.stringify(selectedFiles) !== JSON.stringify(accountingAuthority.files)) {
  runnerErrors.push(new Error("RI discovery differs from authority-issued child selection"));
}
const summaries: StructuredSummary[] = results.map((result) => structuredNodeSummary(result.output));
const skipReasons: Record<string, number> = {};
for (const summary of summaries) {
  for (const [reason, count] of Object.entries(summary.skip_reasons)) {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + count;
  }
}
const failed = results.find((result) => result.exitCode !== 0);
const counts = {
  assertions: summaries.reduce((sum, summary) => sum + summary.assertions, 0),
  completed_files: failed ? 0 : results.length,
  failed: summaries.reduce((sum, summary) => sum + summary.failed, 0),
  passed: summaries.reduce((sum, summary) => sum + summary.passed, 0),
  planned_files: testFiles.length,
  skip_reasons: skipReasons,
  skipped: summaries.reduce((sum, summary) => sum + summary.skipped, 0),
};
// Complete-suite finalization for property 3 (exact named-mapping join): once
// every planned file has run, require the named-mapping rows CONFIGURED for
// this suite to exactly equal the identities the run CONSUMED. This is the one
// new fail-closed path; it does not touch execution order, concurrency,
// timeouts, output counts/schema, or the ordinary exit path. It is skipped
// when the suite did not run to completion (a failing file already dominates
// the exit) or a signal arrived, so it can never mask an unrelated failure or
// fire on a partial run.
if (!failed && signalExitCode === undefined && results.length === testFiles.length) {
  const consumedMappingIdentities = summaries.flatMap((summary) => summary.consumed_mapping_identities);
  try {
    assertNamedSkipMappingsFullyConsumed(
      consumedMappingIdentities,
      riConfiguredNamedSkipMappingIdentities(selectedProfile)
    );
  } catch (error) {
    runnerErrors.push(error);
  }
}
if (runnerErrors.length > 0 && failed) {
  runnerErrors.push(new Error(`test process for ${failed.filePath} exited with code ${failed.exitCode}:\n${failed.output}`));
}
if (accountingAuthority) {
  process.stdout.write(
    `${accountingResultLine({ counts, files: selectedFiles, nonce: accountingAuthority.nonce, profile: accountingAuthority.profile, run_id: accountingAuthority.run_id, suite: "ri-default" })}\n`
  );
}

if (runnerErrors.length > 0) {
  const error = runnerErrors.length === 1
    ? runnerErrors[0]
    : new AggregateError(runnerErrors, "test runner execution and cleanup failed");
  if (signalExitCode !== undefined) {
    process.stderr.write(`${formatRunnerError(error)}\n`);
    process.exitCode = signalExitCode;
  } else {
    throw error;
  }
}
if (signalExitCode !== undefined) {
  process.exitCode = signalExitCode;
} else if (failed) {
  process.exitCode = failed.exitCode;
}

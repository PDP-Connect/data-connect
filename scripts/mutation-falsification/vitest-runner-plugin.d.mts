// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Types for the stryker-js#6210 repair plugin.
//
// The plugin itself stays `.mjs`: Stryker loads it as a module path
// (`stryker.scripts.config.mjs`), so it has to remain runtime-loadable ESM with
// no build step in front of it. This file gives its importers -- only
// `test-identity.test.ts`, which `tsc -b` typechecks -- the real contract
// instead of an implicit `any`.
//
// The shapes here are written against the plugin's own behaviour, not widened
// to Stryker's union types. `dryRun` is declared returning the two results the
// wrapper actually constructs, because the tests assert on `result.tests` and
// on `result.errorMessage`; declaring the upstream `DryRunResult` union would
// hide those fields behind a narrowing the wrapper's own contract does not
// require.

import type { Logger } from "@stryker-mutator/api/logging"
import type { PluginDeclaration } from "@stryker-mutator/api/plugin"
import type {
  DryRunOptions,
  DryRunStatus,
  MutantCoverage,
  MutantRunOptions,
  MutantRunResult,
  TestResult,
  TestRunner,
  TestRunnerCapabilities,
} from "@stryker-mutator/api/test-runner"

/** The separator Vitest 5 builds `fullTestName` with. */
export declare const VITEST_FULL_NAME_SEPARATOR: " > "

/** The separator the stock runner joins a suite chain with. */
export declare const STOCK_RUNNER_SEPARATOR: " "

/** The name this wrapper registers under, named by the cohort configuration. */
export declare const WRAPPED_RUNNER_NAME: "vitest-6210"

/** The stock runner's factory, taken from its package's public export. */
export declare function stockVitestRunnerFactory(): (
  ...args: never[]
) => TestRunner

/** Splits `<file>#<name>` on the first `#` only. */
export declare function splitTestId(id: string): { file: string; name: string }

/** Rewrites a `" > "`-joined chain into the space-joined id the stock runner reports. */
export declare function toStockRunnerName(correctedName: string): string

/** One stock id that more than one corrected coverage key maps onto. */
export interface StockIdCollision {
  stockId: string
  correctedIds: string[]
}

/** Finds the stock ids that more than one corrected coverage key maps onto. */
export declare function findAmbiguousStockIds(
  correctedIds: readonly string[]
): StockIdCollision[]

/** The message `dryRun` fails with when identity cannot be reconciled. */
export declare function describeAmbiguousIdentity(
  collisions: readonly StockIdCollision[]
): string

/**
 * Behavioural check that the defect this wrapper repairs is still live.
 *
 * Reads only `name` off each reported test, so it is declared against that
 * field rather than the full `TestResult`: the tests call it with the minimal
 * shape it inspects, and widening the parameter would force them to build
 * results this function never looks at.
 */
export declare function describeUnexpectedAgreement(
  tests: readonly Pick<TestResult, "name">[],
  perTest: Record<string, unknown>
): string | undefined

/** The dry-run result the wrapper returns when it refuses an ambiguous run. */
export interface ReconciliationRefused {
  status: DryRunStatus.Error
  errorMessage: string
}

/** The dry-run result the wrapper returns when identities reconcile. */
export interface ReconciliationComplete {
  status: DryRunStatus
  tests: TestResult[]
  mutantCoverage?: MutantCoverage
  errorMessage?: undefined
}

/** Delegating `TestRunner` that rewrites dry-run identities. */
export declare class SeparatorReconcilingTestRunner implements TestRunner {
  constructor(inner: TestRunner, log: Logger)
  capabilities(): Promise<TestRunnerCapabilities> | TestRunnerCapabilities
  init(): Promise<void>
  dryRun(
    options: DryRunOptions
  ): Promise<ReconciliationRefused | ReconciliationComplete>
  mutantRun(options: MutantRunOptions): Promise<MutantRunResult>
  dispose(): Promise<void>
}

export declare const strykerPlugins: PluginDeclaration[]

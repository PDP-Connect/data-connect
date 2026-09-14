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
// `dryRun` is declared returning upstream's own `DryRunResult`, not a narrower
// union written here. The wrapper forwards the inner runner's result untouched
// on several paths, including a timeout -- which upstream's union models as a
// variant carrying no `tests` at all. A handwritten declaration that promises
// `tests` on every non-error branch asserts away a state the implementation
// really can forward. Callers narrow on `status`, which is what the
// discriminant is for.

import type { Logger } from "@stryker-mutator/api/logging"
import type { PluginDeclaration } from "@stryker-mutator/api/plugin"
import type {
  DryRunOptions,
  DryRunResult,
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

/** The prefix the setup file writes a refused identity under. */
export declare const UNMAPPABLE_KEY_PREFIX: " stryker-6210-unmappable:"

/** One stock id that more than one corrected coverage key maps onto. */
export interface StockIdCollision {
  stockId: string
  correctedIds: string[]
}

/** The validated map from stock id to corrected identity, or why there is none. */
export type IdentityMap =
  | { ok: true; correctedByStockId: Map<string, { id: string; name: string }> }
  | { ok: false; message: string }

/**
 * Builds the validated identity map from the covered keys and the full
 * reported inventory, or explains why the run cannot be reconciled.
 */
export declare function buildIdentityMap(
  correctedIds: readonly string[],
  reportedTests: readonly { id: string }[]
): IdentityMap

/**
 * Builds the stock-id to corrected-id lookup a mutant run rewrites killers
 * with, from the filter Stryker passes and from nothing else -- so every worker
 * computes the same map for the same mutant.
 */
export declare function correctedByStockIdFrom(
  testFilter: readonly string[] | undefined
): Map<string, string>

/** The message the run fails with when identity cannot be reconciled. */
export declare function describeIrreconcilableIdentity(findings: {
  unmappable: readonly string[]
  collisions: readonly StockIdCollision[]
  aliases: readonly string[]
  unmatched: readonly string[]
}): string

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

/** Delegating `TestRunner` that rewrites dry-run and killer identities. */
export declare class SeparatorReconcilingTestRunner implements TestRunner {
  constructor(inner: TestRunner, log: Logger)
  capabilities(): Promise<TestRunnerCapabilities> | TestRunnerCapabilities
  init(): Promise<void>
  dryRun(options: DryRunOptions): Promise<DryRunResult>
  mutantRun(options: MutantRunOptions): Promise<MutantRunResult>
  dispose(): Promise<void>
}

export declare const strykerPlugins: PluginDeclaration[]

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CollectorUsageError } from "./errors.ts";

export interface ResolvedLocalCollectorPackage {
  manifestPath: string;
  packageDir: string;
}

/**
 * Resolve the `@pdpp/local-collector` package with Node module resolution.
 *
 * @pdpp/cli does not depend on @pdpp/local-collector, so the runner stays on
 * its own release cadence; a missing package becomes an install hint, not an
 * import error. Two layouts resolve here: a global or project npm install
 * (`npm i -g @pdpp/cli @pdpp/local-collector`), and a repository checkout,
 * where the npm workspace links every package into the root node_modules.
 */
export function resolveLocalCollectorPackage(
  startDir: string = dirname(fileURLToPath(import.meta.url))
): ResolvedLocalCollectorPackage | null {
  try {
    const require = createRequire(join(startDir, "_"));
    const manifestPath = require.resolve("@pdpp/local-collector/package.json");
    return { manifestPath, packageDir: dirname(manifestPath) };
  } catch {
    return null;
  }
}

export function resolveTsxBinary(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let cursor = resolve(startDir);
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const candidate = join(cursor, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

const RUNNER_MISSING_MESSAGE =
  "pdpp collector requires @pdpp/local-collector. Install it with " +
  '"npm i -g @pdpp/local-collector", or run "npx -y @pdpp/local-collector <command>".';

const TSX_MISSING_MESSAGE =
  "@pdpp/local-collector is not built and tsx was not found to run it from source. " +
  'Run "npm install" at the repository root, or install the published package with ' +
  '"npm i -g @pdpp/local-collector".';

export type SpawnFn = (
  binary: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: StdioOptions }
) => ChildProcess;

export interface SpawnCollectorRunnerOpts {
  env?: NodeJS.ProcessEnv;
  localCollector?: ResolvedLocalCollectorPackage | null;
  spawnFn?: SpawnFn;
  stdio?: StdioOptions;
  tsxBinary?: string | null;
}

/**
 * Run `pdpp-local-collector <subcommand> ...argv` as a subprocess. Inherits
 * stdio so operators see device tokens, run results, and diagnostics
 * directly. Returns the exit code, never throws on non-zero exits.
 *
 * A published package runs its compiled bin with this Node. An unbuilt
 * checkout runs the TypeScript entrypoint through tsx.
 */
export async function spawnCollectorRunner(
  subcommand: string,
  argv: string[],
  {
    env = process.env,
    localCollector = resolveLocalCollectorPackage(),
    tsxBinary = resolveTsxBinary(),
    spawnFn = spawn,
    stdio = "inherit",
  }: SpawnCollectorRunnerOpts = {}
): Promise<number> {
  if (!localCollector) {
    throw new CollectorUsageError(RUNNER_MISSING_MESSAGE);
  }
  const binPath = resolveLocalCollectorBin(localCollector.packageDir);
  if (!binPath) {
    throw new CollectorUsageError(
      `@pdpp/local-collector is installed at ${localCollector.packageDir} but is missing its bin entrypoint. ` +
        "Reinstall the package or report this on https://github.com/PDP-Connect/data-connect/issues."
    );
  }
  if (binPath.endsWith(".ts")) {
    if (!tsxBinary) {
      throw new CollectorUsageError(TSX_MISSING_MESSAGE);
    }
    return await runSubprocess(spawnFn, tsxBinary, [binPath, subcommand, ...argv], { env, stdio });
  }
  return await runSubprocess(spawnFn, process.execPath, [binPath, subcommand, ...argv], { env, stdio });
}

/**
 * The manifest's `pdpp-local-collector` bin when it exists on disk, else the
 * TypeScript source entrypoint of an unbuilt checkout, else null.
 */
function resolveLocalCollectorBin(packageDir: string): string | null {
  let declared: unknown;
  try {
    declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))?.bin?.["pdpp-local-collector"];
  } catch {
    declared = undefined;
  }
  const candidates = [
    typeof declared === "string" && declared.trim() ? join(packageDir, declared) : null,
    join(packageDir, "bin", "pdpp-local-collector.ts"),
  ];
  return candidates.find((candidate): candidate is string => candidate !== null && existsSync(candidate)) ?? null;
}

function runSubprocess(
  spawnFn: SpawnFn,
  binary: string,
  args: string[],
  { env, stdio }: { env: NodeJS.ProcessEnv; stdio: StdioOptions }
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn(binary, args, { env, stdio });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`collector-runner terminated by signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

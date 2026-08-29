// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PackMetadataOptions {
  cwd: string;
  dryRun?: boolean;
  execute?: typeof execFileAsync;
}

interface PackMetadata {
  filename: string;
  files: Array<{ path: string }>;
  [key: string]: unknown;
}

/**
 * Get npm's candidate-package metadata without depending on `npm pack
 * --json`'s stdout at all.
 *
 * This used to parse `npm pack --json`'s stdout, working around npm 10's
 * `prepare`-during-pack lifecycle-output mixing by keeping scripts in the
 * background (`--foreground-scripts=false`). That workaround is not enough:
 * under installed npm 12.0.2, `npm pack --json --foreground-scripts=false`
 * can exit 0 with an EMPTY captured stdout, so `JSON.parse("")` throws
 * `Unexpected end of JSON input` — the same root cause already fixed in
 * `packages/connector-protocol/scripts/package-artifact.mjs`'s `packOnce()`.
 * That fix's approach: don't ask `npm pack` to also serialize metadata to
 * stdout; pack plainly (no `--json`) and derive everything needed from the
 * tarball's own bytes instead.
 *
 * Here: pack without `--json` (still with `--foreground-scripts=false` so
 * a `prepare`/`prepack` lifecycle script's own stdout never lands in the
 * command's captured output), let npm write the tarball into `cwd` as it
 * always has (no `--pack-destination` override — callers already expect
 * the `.tgz` to land in `cwd`, some of them cleaning it up there
 * afterward), then `filename` comes from `readdir`ing `cwd` for the single
 * newly-produced `.tgz`, and `files` comes from listing the tarball's own
 * contents via `tar -tzf` rather than trusting any npm-emitted JSON.
 */
export async function npmPackMetadata({
  cwd,
  dryRun = false,
  execute = execFileAsync,
}: PackMetadataOptions): Promise<PackMetadata> {
  const args = ["pack", "--foreground-scripts=false"];
  if (dryRun) {
    args.push("--dry-run");
  }

  // A leftover .tgz from a prior pack of the SAME package name/version would
  // otherwise be indistinguishable from the one this call is about to
  // produce (npm pack overwrites in place, so it never appears as "new" by
  // name). Clear any pre-existing .tgz in `cwd` first so the single .tgz
  // found afterward is unambiguously this call's own output.
  const preExisting = (await readdir(cwd)).filter((name) => name.endsWith(".tgz"));
  await Promise.all(preExisting.map((name) => rm(join(cwd, name), { force: true })));

  try {
    await execute("npm", args, { cwd, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw withCommandOutput(error, "npm", args);
  }

  if (dryRun) {
    // --dry-run never writes a tarball; there is nothing to derive `files`
    // from beyond what npm printed, which this function deliberately does
    // not parse. No caller passes dryRun today — keep the flag (matches
    // the prior behavior's surface) but only the non-dry-run path can
    // return a real filename/files pair.
    return { filename: "", files: [] };
  }

  const produced = (await readdir(cwd)).filter((name) => name.endsWith(".tgz"));
  assert.ok(
    produced.length === 1,
    `expected exactly one .tgz in ${cwd} after npm pack, found ${produced.length}: ${JSON.stringify(produced)}`
  );
  const filename = produced[0] as string;
  const tarballPath = join(cwd, filename);

  let tarListing: { stdout: string };
  try {
    tarListing = await execute("tar", ["-tzf", tarballPath], { cwd, maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw withCommandOutput(error, "tar", ["-tzf", tarballPath]);
  }
  // Real npm-packed tarballs always prefix every entry with `package/`;
  // strip it so `files[].path` is package-root-relative, matching the
  // shape callers (validate-package.ts) expect (e.g. `dist/index.js`, not
  // `package/dist/index.js`). Skip the bare `package/` directory entry
  // itself and any blank trailing line from the split.
  const files = tarListing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "package/")
    .map((line) => ({ path: line.replace(/^package\//, "") }));

  return { filename, files };
}

function withCommandOutput(error: unknown, command: string, args: string[]): Error {
  if (!(error instanceof Error)) {
    return error as Error;
  }
  const { stdout, stderr } = error as { stdout?: string; stderr?: string };
  const output = [
    ["stdout", stdout],
    ["stderr", stderr],
  ]
    .filter(([, value]) => value)
    .map(([stream, value]) => `\n${stream}:\n${value}`)
    .join("");
  error.message += `\nCommand failed: ${command} ${args.join(" ")}${output}`;
  return error;
}

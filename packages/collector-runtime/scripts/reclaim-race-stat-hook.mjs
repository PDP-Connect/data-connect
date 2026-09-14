// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Module-load hook that makes the spool reclaim race observable.
 *
 * `reclaimUnreferencedUnsafe` observes a body's metadata, `await`s, and then
 * unlinks that body's PATHNAME. A capture committing inside that await is what
 * turns the sweep into a deleter of live bytes. The window is real but short,
 * so a test that relies on the scheduler to land a capture inside it passes for
 * the wrong reason most runs.
 *
 * This hook wraps the `stat` the spool imports so a test can occupy that exact
 * await. It changes only WHEN the concurrent work runs — never what the sweep
 * does, what capture does, which reference snapshot is used, or what grace
 * period applies. With no `globalThis.__PDPP_RECLAIM_RACE_HOOK` installed it is
 * a pass-through.
 *
 * Used by `npm run test:reclaim-race`. Registered AFTER the TypeScript loader
 * (see `scripts/reclaim-race-register.mjs`) so it sees module source.
 */

const TARGET = "local-device-blob-spool.ts";

const IMPORT_LINE = 'import { readdir, stat } from "node:fs/promises";';

const REPLACEMENT = [
  'import { readdir, stat as __pdppRealStat } from "node:fs/promises";',
  "const stat = async (path) => {",
  "  const stats = await __pdppRealStat(path);",
  "  const hook = globalThis.__PDPP_RECLAIM_RACE_HOOK;",
  "  if (hook) {",
  "    await hook(path);",
  "  }",
  "  return stats;",
  "};",
].join("\n");

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith(TARGET) || result.source === undefined || result.source === null) {
    return result;
  }
  const source = result.source.toString();
  if (!source.includes(IMPORT_LINE)) {
    // The import this hook rewrites has moved. Fail loudly: silently returning
    // the original would leave the race tests unable to enter the window, and
    // they would report that as a skip rather than as a broken harness.
    throw new Error(
      `reclaim-race-stat-hook: expected ${TARGET} to import stat as \`${IMPORT_LINE}\`; update the hook to match`
    );
  }
  return { ...result, source: source.replace(IMPORT_LINE, REPLACEMENT) };
}

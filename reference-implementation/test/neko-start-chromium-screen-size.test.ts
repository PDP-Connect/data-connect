// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs docker/neko/start-chromium.sh with an inert launcher in place of
// Chromium and asserts the --window-size it passes for each
// NEKO_DESKTOP_SCREEN value.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const START_SCRIPT = fileURLToPath(new URL("../../docker/neko/start-chromium.sh", import.meta.url));
const DEFAULT_SIZE = "1440,900";

async function windowSizeFor(screen: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neko-start-chromium-"));
  try {
    const argvLog = join(dir, "argv.log");
    const launcher = join(dir, "launcher");
    await writeFile(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\n`);
    await chmod(launcher, 0o755);
    // The script polls with `sleep 1` while the launcher is alive; stub it out.
    await writeFile(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "sleep"), 0o755);

    const result = spawnSync("/bin/sh", [START_SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DISPLAY: ":99",
        NEKO_DESKTOP_SCREEN: screen,
        PDPP_PATCHRIGHT_CHROMIUM_BIN: launcher,
      },
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const argv = (await readFile(argvLog, "utf8")).split("\n");
    const sizeArg = argv.find((arg) => arg.startsWith("--window-size="));
    assert.ok(sizeArg, `no --window-size in argv for ${JSON.stringify(screen)}`);
    return sizeArg.slice("--window-size=".length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("start-chromium.sh sizes the window from a well-formed screen value", async () => {
  assert.equal(await windowSizeFor("1280x720@60"), "1280,720");
  assert.equal(await windowSizeFor("1920x1080"), "1920,1080");
  assert.equal(await windowSizeFor("800x600@"), "800,600");
});

test("start-chromium.sh falls back to the default size for an unusable screen value", async () => {
  for (const screen of [
    "1280", // no separator
    "1280x", // empty height
    "x720", // empty width
    "0x720", // zero width
    "1280x0", // zero height
    "00x00", // zeros with padding
    "12a0x720", // non-numeric width
    "1280x7.5@30", // non-numeric height
    "1x2x3", // extra separator
    "",
  ]) {
    assert.equal(await windowSizeFor(screen), DEFAULT_SIZE, JSON.stringify(screen));
  }
});

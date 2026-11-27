// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APPS_PAGE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const HOME_OVERVIEW = fileURLToPath(new URL("../components/views/standing-overview.tsx", import.meta.url));

// Round 7 (F48): the button keeps one place, the header, in every state.
test("Apps shows one Connect an app button, always in the header", async () => {
  const src = await readFile(APPS_PAGE, "utf8");
  assert.doesNotMatch(src, /actions=\{empty \? undefined/);
  assert.equal(src.match(/Connect an app/g)?.length, 1, "only the header draws the button");
});

test("the empty section says 'now' when an app was removed, 'yet' when none was ever connected", async () => {
  const groups = await readFile(fileURLToPath(new URL("./apps-groups.tsx", import.meta.url)), "utf8");
  assert.match(groups, /No app can read your data \$\{stopped\.length \? "now" : "yet"\}\./);
});

test("the Connect an app button looks the same on Home and on Apps", async () => {
  const home = await readFile(HOME_OVERVIEW, "utf8");
  const apps = await readFile(APPS_PAGE, "utf8");
  assert.match(apps, /import \{ buttonVariants \} from "@pdpp\/brand-react"/);
  // Same primary button maker on both pages, so the same action has the same colour.
  assert.match(home, /import \{ buttonVariants as primaryButtonVariants \} from "@pdpp\/brand-react"/);
  assert.match(home, /const FILLED_BUTTON = primaryButtonVariants\(/);
});

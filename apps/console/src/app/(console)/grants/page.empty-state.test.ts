// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APPS_PAGE = fileURLToPath(new URL("./page.tsx", import.meta.url));
const HOME_OVERVIEW = fileURLToPath(new URL("../components/views/standing-overview.tsx", import.meta.url));

test("Apps with no apps shows one Connect an app button, in the empty state", async () => {
  const src = await readFile(APPS_PAGE, "utf8");
  // The header action is only drawn when there is something else on the page.
  assert.match(src, /actions=\{empty \? undefined : /);
  assert.equal(src.match(/Connect an app/g)?.length, 2, "one in the header (when not empty), one in the empty state");
});

test("the Connect an app button looks the same on Home and on Apps", async () => {
  const home = await readFile(HOME_OVERVIEW, "utf8");
  const apps = await readFile(APPS_PAGE, "utf8");
  assert.match(apps, /import \{ buttonVariants \} from "@pdpp\/brand-react"/);
  // Same primary button maker on both pages, so the same action has the same colour.
  assert.match(home, /import \{ buttonVariants as primaryButtonVariants \} from "@pdpp\/brand-react"/);
  assert.match(home, /const FILLED_BUTTON = primaryButtonVariants\(/);
});

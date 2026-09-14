// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registers `reclaim-race-stat-hook.mjs` AFTER the TypeScript loader, so the
 * hook sees module source rather than being bypassed by it, and marks the hook
 * as installed so the race tests know they can discriminate rather than skip.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./reclaim-race-stat-hook.mjs", pathToFileURL(import.meta.filename));
globalThis.__PDPP_RECLAIM_RACE_HOOK_INSTALLED = true;

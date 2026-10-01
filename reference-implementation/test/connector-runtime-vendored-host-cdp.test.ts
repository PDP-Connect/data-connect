// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserLaunchSource } from "@pdpp/polyfill-connectors/connector-runtime";

test("vendored connector runtime attaches to the desktop host browser surface", () => {
  assert.deepEqual(
    resolveBrowserLaunchSource(
      { profileName: "reddit" },
      {
        PDPP_BROWSER_SURFACE_REQUIRED: "host",
        PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://127.0.0.1:9222",
      } as NodeJS.ProcessEnv,
    ),
    {
      kind: "managed_host_cdp",
      remoteCdpUrl: "http://127.0.0.1:9222",
    },
  );
});

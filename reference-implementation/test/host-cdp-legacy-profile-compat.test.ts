import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserSurfaceLaunchEnv } from "../runtime/index.ts";

test("host CDP launch env keeps compatibility with installed legacy connector profiles", () => {
  const env = buildBrowserSurfaceLaunchEnv({
    connectorId: "reddit",
    connectorInstanceId: "cin_test",
    browserSurfaceEnv: {
      PDPP_BROWSER_SURFACE_REQUIRED: "host",
      PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://127.0.0.1:9222",
    },
  });

  assert.equal(env.PDPP_BROWSER_SURFACE_REQUIRED, "host");
  assert.equal(env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, "http://127.0.0.1:9222");
  assert.equal(env.PDPP_REDDIT__CIN_TEST_REMOTE_CDP_URL, "http://127.0.0.1:9222");
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End to end: the features the runtime advertises are features a connector can
 * use (Collection Profile section 3.3.8).
 *
 * The runtime spawns a fixture connector whose manifest requires every
 * advertised feature. The runtime hands the connector a browser surface (a CDP
 * endpoint, as a managed surface does), and the connector attaches to it and
 * exercises each feature against a local test page. This needs Chromium: Patchright's
 * pinned revision, installed by CI (`patchright install chromium`). The test
 * fails, and does not skip, when it is missing.
 *
 * Each feature is proven by something only that feature can do:
 *  - page_navigation: the page URL changes to the test page.
 *  - page_script_evaluation: a script reads a global the page's own script set,
 *    which only the page's main world can see.
 *  - page_condition_wait: the wait stays pending while the server withholds the
 *    page, and resolves only after the server releases it.
 *  - page_content_read: the content holds text that script wrote after load.
 *  - same_origin_page_fetch: the server sees a same-origin fetch that carries
 *    the page's own cookie.
 *  - host_http_request: the server sees a request with no page context and no
 *    page cookie.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

import { RUNTIME_BINDING_SUPPORT } from "../runtime/binding-declarations.ts";
import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { fakeAdmitRunConnection } from "./helpers/fake-admit-run-connection.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("patchright") as typeof import("patchright");
const PATCHRIGHT_ENTRY = pathToFileURL(require.resolve("patchright")).href;

interface SeenRequest {
  readonly cookie: string | null;
  readonly path: string;
  readonly secFetchSite: string | null;
}

/** What the connector observed, written to a capture file the test reads back. */
interface Observations {
  readonly bindings: string[];
  readonly content: string;
  readonly hostCookie: string | null;
  readonly hostRequestOk: boolean;
  readonly mainWorldGlobal: string | null;
  readonly pageFetch: { cookie: string | null; secFetchSite: string | null };
  readonly readyBeforeWait: boolean;
  readonly readyAfterWait: boolean;
  readonly settledBeforeRelease: boolean;
  readonly title: string;
  readonly url: string;
}

const PAGE_HTML = `<!doctype html>
<html><head><title>feature page</title></head>
<body>
<p id="static">static text</p>
<script>
  window.__pageGlobal = "set by the page's own script";
  window.__ready = false;
  document.cookie = "sid=page-cookie; path=/";
  // The page becomes ready only once the server releases it, so the test, not a timer, decides when.
  const poll = setInterval(async () => {
    const { released } = await (await fetch("/api/released")).json();
    if (!released) return;
    clearInterval(poll);
    window.__ready = true;
    const late = document.createElement("p");
    late.id = "late";
    late.textContent = "written by script after load";
    document.body.appendChild(late);
  }, 50);
</script>
</body></html>`;

let server: Server;
let origin: string;
let cdpUrl: string;
let closeBrowser: () => Promise<void>;
let profileDir: string;
const seen: SeenRequest[] = [];
let released = false;

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

/** Chromium picks its own debugging port and records it in the profile directory. */
async function readDevtoolsPort(profileDir: string): Promise<number> {
  const file = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const port = Number.parseInt(readFileSync(file, "utf8").split("\n")[0] ?? "", 10);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chromium wrote no DevToolsActivePort in ${profileDir}`);
}

before(async () => {
  initDb(":memory:");
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/page") {
      response.setHeader("content-type", "text/html");
      response.end(PAGE_HTML);
      return;
    }
    if (path === "/api/release") {
      released = true;
    }
    seen.push({ cookie: header(request, "cookie"), path, secFetchSite: header(request, "sec-fetch-site") });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        cookie: header(request, "cookie"),
        released,
        secFetchSite: header(request, "sec-fetch-site"),
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

  // Stands in for a managed browser surface: a Chromium with a CDP endpoint.
  profileDir = mkdtempSync(join(tmpdir(), "pdpp-binding-features-profile-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    args: ["--remote-debugging-port=0"],
    headless: true,
  });
  closeBrowser = () => context.close();
  cdpUrl = `http://127.0.0.1:${await readDevtoolsPort(profileDir)}`;
});

after(async () => {
  await closeBrowser?.();
  if (profileDir) {
    rmSync(profileDir, { force: true, recursive: true });
  }
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeDb();
});

const FEATURE_MANIFEST = {
  connector_id: "binding-features-fixture",
  display_name: "Binding features fixture",
  protocol_version: "0.1.0",
  runtime_requirements: {
    bindings: {
      browser: {
        features: ["page_navigation", "page_script_evaluation", "page_condition_wait", "page_content_read"],
        required: true,
      },
      network: { features: ["same_origin_page_fetch", "host_http_request"], required: true },
    },
  },
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

/**
 * The fixture connector. It does what a browser connector does with the handle
 * the runtime provides: attach to the surface in `PDPP_BROWSER_SURFACE_REMOTE_CDP_URL`,
 * drive the page, and make one request from the host side.
 */
function connectorSource(capturePath: string): string {
  return `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(${JSON.stringify(PATCHRIGHT_ENTRY)})("patchright");
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  const done = (status, extra = {}) =>
    process.stdout.write(JSON.stringify({ type: "DONE", status, records_emitted: 0, ...extra }) + "\\n");
  let browser;
  try {
    const cdp = process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    if (!cdp) throw new Error("the runtime passed no browser surface");
    browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();

    await page.goto(${JSON.stringify(`${origin}/page`)}, { waitUntil: "domcontentloaded" });
    const url = page.url();
    const title = await page.title();

    // evaluate(script, arg, options, isolatedContext): the last argument false runs in the page's main world.
    const inMainWorld = (script) => page.evaluate(script, undefined, undefined, false);
    const mainWorldGlobal = await inMainWorld("window.__pageGlobal ?? null");
    // Start the wait while the server still withholds the page. A wait that did not
    // wait would settle at once, so it must still be pending after a pause.
    const waiting = page.waitForFunction("window.__ready === true", undefined, { timeout: 10000 });
    const settledBeforeRelease = await Promise.race([
      waiting.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    const readyBeforeWait = await inMainWorld("window.__ready === true");
    await fetch(${JSON.stringify(`${origin}/api/release`)});
    await waiting;
    const readyAfterWait = await inMainWorld("window.__ready === true");
    const content = await page.content();

    const pageFetch = await page.evaluate(async () => (await fetch("/api/page-fetch")).json());
    const hostResponse = await fetch(${JSON.stringify(`${origin}/api/host-request`)});
    const hostBody = await hostResponse.json();

    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      bindings: Object.keys(msg.bindings ?? {}).sort(),
      content,
      hostCookie: hostBody.cookie,
      hostRequestOk: hostResponse.ok,
      mainWorldGlobal,
      pageFetch,
      readyAfterWait,
      readyBeforeWait,
      settledBeforeRelease,
      title,
      url,
    }));
    done("succeeded");
  } catch (error) {
    writeFileSync(${JSON.stringify(`${capturePath}.error`)}, String(error?.stack ?? error));
    done("failed");
  } finally {
    await browser?.close().catch(() => {});
    rl.close();
    process.exit(0);
  }
});
`;
}

test("a connector requiring every advertised feature spawns and uses each one against a real browser", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-binding-features-browser-"));
  try {
    const capturePath = join(tmpDir, "observations.json");
    const connectorPath = join(tmpDir, "connector.mjs");
    writeFileSync(connectorPath, connectorSource(capturePath), "utf-8");

    // The manifest asks for exactly what the runtime advertises, so this test
    // fails if either list gains a name the other lacks.
    const declared = new Set(
      Object.values(FEATURE_MANIFEST.runtime_requirements.bindings).flatMap((binding) => binding.features)
    );
    assert.deepEqual([...declared].sort(), [...RUNTIME_BINDING_SUPPORT.features].sort());

    seen.length = 0;
    released = false;
    try {
      await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        browserSurfaceEnv: { PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: cdpUrl, PDPP_BROWSER_SURFACE_REQUIRED: "host" },
        collectionMode: "full_refresh",
        connectorId: "binding-features-fixture",
        connectorPath,
        manifest: FEATURE_MANIFEST,
        onInteraction: async () => ({
          data: {},
          request_id: "unused",
          status: "success",
          type: "INTERACTION_RESPONSE",
        }),
        ownerToken: "test",
        persistState: true,
        rsUrl: "http://localhost:9999",
        state: null,
      } as unknown as RuntimeRunConnectorOptions);
    } catch (error) {
      // The connector's own failure is the useful message, not the runtime's wrapper.
      const detail = existsSync(`${capturePath}.error`) ? readFileSync(`${capturePath}.error`, "utf8") : String(error);
      assert.fail(`the fixture connector did not finish: ${detail}`);
    }

    const observed = JSON.parse(readFileSync(capturePath, "utf8")) as Observations;

    assert.deepEqual(observed.bindings, ["browser", "filesystem", "network"], "START advertises the placed kinds");
    // page_navigation
    assert.equal(observed.url, `${origin}/page`);
    assert.equal(observed.title, "feature page");
    // page_script_evaluation
    assert.equal(observed.mainWorldGlobal, "set by the page's own script");
    // page_condition_wait
    assert.equal(observed.settledBeforeRelease, false, "the wait stayed pending while the condition was false");
    assert.equal(observed.readyBeforeWait, false, "the condition was not yet true when the wait began");
    assert.equal(observed.readyAfterWait, true);
    // page_content_read
    assert.match(observed.content, /written by script after load/);
    // same_origin_page_fetch
    assert.equal(observed.pageFetch.secFetchSite, "same-origin");
    assert.equal(observed.pageFetch.cookie, "sid=page-cookie");
    // host_http_request
    assert.equal(observed.hostRequestOk, true);
    assert.equal(observed.hostCookie, null);
    const hostRequest = seen.find((request) => request.path === "/api/host-request");
    assert.ok(hostRequest, "the server received the host-side request");
    assert.equal(hostRequest.secFetchSite, null, "a host-side request has no page context");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

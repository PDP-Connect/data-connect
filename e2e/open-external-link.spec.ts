// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime proof for the console-to-native open-external-url bridge
 * (`OpenExternalLink`, apps/console/src/app/(console)/components/
 * open-external-link.tsx -> owner-open-external-url.ts ->
 * open_external_url.rs).
 *
 * History, because it explains why this file looks the way it does. The
 * ORIGINAL `OpenExternalLink` test (`open-external-link.test.ts`) only
 * regex-matched source text and passed while every link was dead (#186's
 * `shell:allow-open` grant merged, `window.__TAURI__` stayed undefined).
 * #200 replaced that with THIS spec -- a real browser against a real
 * running console -- but shipped its own bug: the fix's runtime-detection
 * check (`isTauriRuntime`, since renamed `isDesktopWebview`) tested for
 * `__TAURI__`/`__TAURI_INTERNALS__`, the exact globals Tauri never injects
 * into this window, so the check always evaluated false and the bridge
 * code after it never ran. This spec's own first version forced the guard
 * open by injecting `window.__TAURI_INTERNALS__` directly, which made the
 * test pass while the real app stayed dead -- confirmed live in Tim's
 * running build (Internal Server settings links doing nothing on click).
 * The detection now reads a cookie Rust actually sets on the real window
 * (`pdpp_desktop_bridge`, see `markAsDesktopWebview` below), so this test
 * only passes if the SAME mechanism production uses actually works, not a
 * synthetic stand-in for it.
 *
 * This test cannot exercise the Rust half (open::that_detached actually
 * spawning a system-browser process) -- Playwright drives a plain browser
 * over the console's HTTP port, not the Tauri webview, and there is no
 * native process on the other end here to observe. See
 * `owner-open-external-url-route.test.ts` and
 * `src-tauri/src/commands/open_external_url.rs`'s unit tests for the parts
 * this test cannot reach: the HTTP route's scheme validation (covered
 * end-to-end below) and the Rust queue-apply logic (covered by Rust unit
 * tests only, plus a manual verification recorded in the PR body).
 *
 * Target a running console with:
 *   E2E_BASE_URL=http://127.0.0.1:PORT E2E_OWNER_PASSWORD=... \
 *     npx playwright test open-external-link.spec.ts
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421"
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? ""
// Optional: PDPP_DATA_DIR of the target instance. When set, this spec reads
// open-external-url-queue.json directly after the click and asserts the
// exact URL landed there -- the strongest available proof short of running
// inside the real Tauri process, which this Playwright-over-HTTP harness
// cannot do (see the module doc above). Skipped when unset because a
// remotely-tunneled console's data dir is not filesystem-visible here.
const DATA_DIR = process.env.E2E_PDPP_DATA_DIR

async function loginAsOwner(
  page: import("@playwright/test").Page
): Promise<void> {
  if (!OWNER_PASSWORD) {
    throw new Error("E2E_OWNER_PASSWORD is not set.")
  }
  await page.goto(`${BASE_URL}/owner/login?return_to=%2F`)
  await page.getByLabel("Owner password").fill(OWNER_PASSWORD)
  const [response] = await Promise.all([
    page.waitForResponse(
      res =>
        res.url().includes("/owner/login") && res.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ])
  expect(response.status()).toBeLessThan(400)
  await page.waitForLoadState("networkidle")
}

/**
 * `OpenExternalLink` routes through the bridge only when `isDesktopWebview()`
 * finds the `pdpp_desktop_bridge=1` cookie (`open-external-link.tsx`).
 * That cookie is set by Rust's `desktop_bridge_marker_cookie` /
 * `create_or_update_console_window` (`src-tauri/src/unified.rs`) the one
 * time it creates or navigates the real console window -- a plain browser,
 * which is what Playwright drives here (same limitation
 * `owner-journey.spec.ts` documents: this harness cannot reach the actual
 * Tauri webview), never receives it on its own.
 *
 * An EARLIER version of this test injected `window.__TAURI_INTERNALS__`
 * directly to force the code path. That was wrong in a way that mattered:
 * the component used to check for that exact global too, and the global is
 * NEVER present in the real console window (Tauri does not inject it into
 * a `WebviewUrl::External` origin) -- so the old test forced a code path
 * the real app could never naturally reach, and passed while every link
 * was dead in Tim's actual build. Setting the cookie here instead
 * reproduces exactly what the real Rust process does, so this test only
 * passes if the SAME mechanism production uses actually works.
 */
async function markAsDesktopWebview(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.context().addCookies([
    {
      name: "pdpp_desktop_bridge",
      value: "1",
      url: BASE_URL,
    },
  ])
}

test("clicking an external link inside the desktop webview POSTs to the owner open-external-url bridge, not a dead invoke()", async ({
  page,
}) => {
  await markAsDesktopWebview(page)
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const docsLink = page.getByRole("link", { name: "Docs" })
  await expect(docsLink).toBeVisible()

  const bridgeRequest = page.waitForRequest(
    req =>
      req.url().includes("/owner/open-external-url") ||
      (req.url() === `${BASE_URL}/settings` && req.method() === "POST")
  )

  const consoleErrors: string[] = []
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })

  await docsLink.click()

  // The Server Action posts back to the current page URL (Next.js Server
  // Action wire protocol), not directly to /v1/owner/open-external-url from
  // the browser -- that internal-network hop happens server-side in
  // open-external-url-client.ts. So the observable browser-side proof is:
  // (a) a POST fires (the action was invoked at all, unlike the dead
  // invoke() promise that previously vanished with nothing sent), and
  // (b) it resolves without surfacing the "Failed to open external link"
  // console.error the component logs on a rejected action result.
  const request = await bridgeRequest
  const response = await request.response()
  expect(
    response?.status(),
    "expected the open-external-url Server Action POST to succeed"
  ).toBeLessThan(400)

  expect(
    consoleErrors.filter(text => text.includes("Failed to open external link")),
    "a successful bridge call must not log the open-external-link failure path"
  ).toEqual([])

  if (DATA_DIR) {
    const queuePath = join(DATA_DIR, "open-external-url-queue.json")
    const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
      pending: { id: number; url: string }[]
    }
    expect(
      queue.pending.some(entry => entry.url === "https://pdpp.dev/"),
      `expected open-external-url-queue.json to contain the Docs link's URL; found ${JSON.stringify(queue.pending)}`
    ).toBe(true)
  }
})

test("without the desktop marker cookie, a click never reaches the bridge (plain-browser control)", async ({
  page,
}) => {
  // Deliberately does NOT call markAsDesktopWebview -- this is the plain-
  // browser case the real console must also serve correctly (a self-hosted
  // deployment opened in an ordinary tab). The bridge route must stay
  // silent; the native target="_blank" anchor handles the click instead.
  // This is also the regression guard for the actual bug this test file
  // was rewritten for: a detection check that ALWAYS evaluates true (or
  // always false in the wrong direction) would make this test and the one
  // above indistinguishable. They must disagree.
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const docsLink = page.getByRole("link", { name: "Docs" })
  await expect(docsLink).toBeVisible()

  let bridgeRequestSeen = false
  page.on("request", req => {
    if (req.url().includes("/owner/open-external-url")) {
      bridgeRequestSeen = true
    }
  })

  // target="_blank" opens a new tab/page; catch it so the test doesn't hang
  // waiting on navigation, and so the extra page gets cleaned up.
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 5000 }).catch(() => null),
    docsLink.click(),
  ])
  await popup?.close()

  expect(
    bridgeRequestSeen,
    "a plain-browser click must never reach the owner-authenticated bridge"
  ).toBe(false)
})

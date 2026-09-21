// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime proof for the console-to-native open-external-url bridge
 * (`OpenExternalLink`, apps/console/src/app/(console)/components/
 * open-external-link.tsx -> owner-open-external-url.ts ->
 * open_external_url.rs).
 *
 * The prior `OpenExternalLink` test (open-external-link.test.ts) only
 * regex-matched the component's source text and passed while every one of
 * the 35 call sites was dead in the shipped app -- PR #186's
 * `shell:allow-open` capability grant merged, and `window.__TAURI__` was
 * still undefined in the real console window. This spec instead drives a
 * REAL browser against a REAL running console + reference server and
 * asserts on the network request the click actually produces, not on
 * source text.
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
 * `OpenExternalLink` only routes through the bridge when
 * `isTauriRuntime()` is true (`"__TAURI__" in window ||
 * "__TAURI_INTERNALS__" in window`). A plain browser -- which is what
 * Playwright drives here, same limitation `owner-journey.spec.ts`
 * documents -- is not the Tauri webview, so this injects the same runtime
 * marker the real console window carries, forcing the click through the
 * exact code path the packaged app uses instead of the plain-browser
 * target="_blank" fallback.
 */
async function markAsTauriRuntime(
  page: import("@playwright/test").Page
): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
}

test("clicking an external link inside the Tauri runtime POSTs to the owner open-external-url bridge, not a dead invoke()", async ({
  page,
}) => {
  await markAsTauriRuntime(page)
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

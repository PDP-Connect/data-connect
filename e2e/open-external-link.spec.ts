// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime proof for `OpenExternalLink` (apps/console/src/app/(console)/
 * components/open-external-link.tsx) in the ONE environment this harness can
 * actually drive: a plain browser tab pointed at the running console, not
 * the real Tauri webview.
 *
 * History, four attempts over, because this spec's own earlier versions
 * passed while the feature was dead in the real desktop app every time:
 * #200's version injected `window.__TAURI_INTERNALS__` to force a
 * detection check open; #209's version set a `pdpp_desktop_bridge` cookie
 * via `page.context().addCookies()` to simulate the marker Rust was
 * supposed to set on the real window. Both proved a MECHANISM
 * (`isDesktopWebview()` reading a signal), never the actual trigger
 * production needed -- and in #209's case, the synthetic cookie setup
 * itself turned out to reproduce something the real webview's
 * `window.set_cookie()` call could not reliably deliver.
 *
 * The fix that actually works removes the mechanism this spec used to
 * test: link-opening now lives entirely in Rust
 * (`decide_console_navigation`, `src-tauri/src/unified.rs`, wired via
 * `on_navigation` on the console's `WebviewWindowBuilder`), intercepting
 * navigation at the webview level before the page's own JS ever runs.
 * Playwright drives a plain browser over the console's HTTP port, not the
 * Tauri webview -- there is no `on_navigation` handler to observe here at
 * all, by construction, the same way there is no server endpoint left to
 * watch a network request hit. See `src-tauri/src/unified.rs`'s
 * `decide_console_navigation_allows_the_consoles_own_origin` and
 * `decide_console_navigation_denies_non_https_external_urls` unit tests,
 * and `src-tauri/src/bin/new_window_repro.rs` (a standalone repro driven by
 * both a scripted click and, for the two mechanisms that require a trusted
 * user gesture, a real one) for the parts only Rust or a real click can
 * prove.
 *
 * What THIS spec can still prove, and does: `OpenExternalLink` is now a
 * plain anchor with no `onClick`, no client-side branching, and no
 * `target="_blank"` forced -- so in an ordinary browser tab (the
 * self-hoster case), clicking it must behave exactly like clicking any
 * other link: the tab navigates to the href, nothing else happens, no
 * request to any bridge endpoint occurs (there is no such endpoint left to
 * call).
 *
 * Target a running console with:
 *   E2E_BASE_URL=http://127.0.0.1:PORT E2E_OWNER_PASSWORD=... \
 *     npx playwright test open-external-link.spec.ts
 */
import { expect, test } from "@playwright/test"

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:1421"
const OWNER_PASSWORD = process.env.E2E_OWNER_PASSWORD ?? ""

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

test("in a plain browser, clicking an OpenExternalLink navigates to its href with no bridge request", async ({
  page,
}) => {
  await loginAsOwner(page)
  await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" })

  const docsLink = page.getByRole("link", { name: "Docs" })
  await expect(docsLink).toBeVisible()
  await expect(docsLink).toHaveAttribute("href", "https://pdpp.dev")

  let bridgeRequestSeen = false
  page.on("request", req => {
    if (req.url().includes("/owner/open-external-url")) {
      bridgeRequestSeen = true
    }
  })

  // No target="_blank" anymore -- a plain click navigates the current tab,
  // so the assertion is on navigation, not a popup. Catch the (expected)
  // cross-origin navigation failure from Playwright's own network
  // interception rather than letting it hang.
  await docsLink.click({ noWaitAfter: true }).catch(() => {})
  await page.waitForURL(url => url.href.startsWith("https://pdpp.dev"), {
    timeout: 5000,
  })

  expect(
    bridgeRequestSeen,
    "a plain anchor click must never reach an owner-authenticated bridge endpoint -- " +
      "there is no such endpoint left to reach"
  ).toBe(false)
})

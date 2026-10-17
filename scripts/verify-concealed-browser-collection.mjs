#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves that a concealed browser still collects: animation frames run and
// Playwright can navigate, click and fill, also in a second page and in a
// popup the page opens, which are new windows the backend must conceal too.
// It does not check screencast frames; `verify-private-display-cdp.mjs`
// does.
// Used by the ignored Rust test `real_chrome_hidden_native_stays_concealed`.
//
// Usage: node scripts/verify-concealed-browser-collection.mjs <cdp-http-url>

import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const cdpUrl = process.argv[2];
if (!cdpUrl) {
  console.error("usage: verify-concealed-browser-collection.mjs <cdp-http-url>");
  process.exit(2);
}

// Lets an outside observer attribute what it sees to each step.
// Best effort: on Windows the observer may hold the file for a moment.
const phase = (name) => {
  if (process.env.DATACONNECT_OBSERVE_PHASE_FILE) {
    try {
      writeFileSync(process.env.DATACONNECT_OBSERVE_PHASE_FILE, `collect-${name}`);
    } catch {}
  }
};

const within = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

const browser = await chromium.connectOverCDP(cdpUrl);
const result = {};
try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(
    "data:text/html,<input id=otp><button id=go onclick=document.body.dataset.clicked=1>Go</button>" +
      // Chrome blocks top-level data: URLs in new windows, so the popup
      // opens blank and its opener writes the content.
      "<button id=open onclick=\"window.open('about:blank','_blank','popup').document.write('<p id=popup>popup</p>')\">Open</button>",
  );
  result.animationFrame = await within(
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true)))),
    3000,
  ).catch(() => false);
  await page.locator("#otp").fill("424242", { timeout: 5000 });
  await page.locator("#go").click({ timeout: 5000 });
  result.value = await page.locator("#otp").inputValue();
  result.clicked = await page.evaluate(() => document.body.dataset.clicked === "1");
  result.visibilityState = await page.evaluate(() => document.visibilityState);
  phase("new-page");
  const second = await context.newPage();
  await second.goto("data:text/html,<p id=second>second</p>");
  result.secondPage = await second.locator("#second").textContent({ timeout: 5000 });
  phase("popup");
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 5000 }),
    // A click, as a connector's would be: popups need a user gesture.
    page.locator("#open").click({ timeout: 5000 }),
  ]);
  result.popup = await popup.locator("#popup").textContent({ timeout: 5000 });
  await popup.close();
  await second.close();
  phase("closed");
} catch (error) {
  result.error = String(error).split("\n")[0];
} finally {
  console.log(JSON.stringify(result));
  // Disconnects; the host owns the browser.
  await browser.close();
}
if (
  !(
    result.animationFrame &&
    result.value === "424242" &&
    result.clicked &&
    result.secondPage === "second" &&
    result.popup === "popup"
  )
) {
  process.exit(1);
}

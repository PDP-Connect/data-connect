#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves that a browser on a private display still serves the companion:
// CDP screencast frames arrive and change, and keyboard and mouse input
// reach the page. Used by the ignored Rust test
// `real_chrome_on_private_xvfb_stays_off_the_owner_display`.
//
// Usage: node scripts/verify-private-display-cdp.mjs <cdp-http-url>

import { chromium } from "playwright-core";

const cdpUrl = process.argv[2];
if (!cdpUrl) {
  console.error("usage: verify-private-display-cdp.mjs <cdp-http-url>");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  await page.setContent(
    '<input id="otp" autofocus style="font-size:48px"><button id="go" onclick="document.body.dataset.clicked=1">Go</button>'
  );
  const session = await context.newCDPSession(page);
  const frames = [];
  session.on("Page.screencastFrame", async (frame) => {
    frames.push(frame.data.length);
    await session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
  await page.waitForTimeout(500);
  const framesBeforeInput = frames.length;
  const box = await page.locator("#otp").boundingBox();
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x + 5, y: box.y + 5, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + 5, y: box.y + 5, button: "left", clickCount: 1 });
  for (const key of "424242") {
    await session.send("Input.dispatchKeyEvent", { type: "keyDown", text: key, key });
    await session.send("Input.dispatchKeyEvent", { type: "keyUp", key });
  }
  const button = await page.locator("#go").boundingBox();
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: button.x + 5, y: button.y + 5, button: "left", clickCount: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x + 5, y: button.y + 5, button: "left", clickCount: 1 });
  await page.waitForTimeout(800);
  await session.send("Page.stopScreencast");
  const value = await page.locator("#otp").inputValue();
  const clicked = await page.evaluate(() => document.body.dataset.clicked === "1");
  const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  const result = {
    clicked,
    frames: frames.length,
    framesAfterInput: frames.length - framesBeforeInput,
    value,
    viewport,
  };
  console.log(JSON.stringify(result));
  if (frames.length === 0 || result.framesAfterInput === 0 || value !== "424242" || !clicked) {
    process.exit(1);
  }
} finally {
  await browser.close();
}

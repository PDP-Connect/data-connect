#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proves that a browser on a private display still serves the companion:
// CDP screencast frames show what the page paints, and keyboard and mouse
// input reach the page. Input flips a large colour block from red to blue;
// the check decodes lossless PNG frames and compares the block's pixels, so
// black or frozen frames fail even when the DOM assertions pass. A control
// comparison of a frame with itself must report no change, which fails a
// comparator that always says "changed". Used by the ignored Rust test
// `real_chrome_on_private_xvfb_stays_off_the_owner_display`.
//
// Usage: node scripts/verify-private-display-cdp.mjs <cdp-http-url>

import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

export const RED = [255, 0, 0];
export const BLUE = [0, 0, 255];
// Fractions of the frame covered by the colour block, away from its edges.
export const BLOCK_REGION = { x0: 0.1, x1: 0.9, y0: 0.05, y1: 0.3 };
const COLOR_TOLERANCE = 24;
const CHANGED_PIXEL_FRACTION = 0.9;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG to { width, height, rgba }. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let header;
  const idat = [];
  for (let offset = 8; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || channels === 0 || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error("PNG data length does not match its header");
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[y * stride + i - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else throw new Error(`unknown PNG filter ${filter}`);
      pixels[y * stride + i] = (line[i] + predictor) & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < channels; c++) rgba[p * 4 + c] = pixels[p * channels + c];
  }
  return { width, height, rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function* regionPixels(image, region) {
  const x0 = Math.floor(image.width * region.x0);
  const x1 = Math.ceil(image.width * region.x1);
  const y0 = Math.floor(image.height * region.y0);
  const y1 = Math.ceil(image.height * region.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) yield (y * image.width + x) * 4;
  }
}

/** Mean RGB of a region, given as fractions of the frame. */
export function regionColor(image, region = BLOCK_REGION) {
  const sum = [0, 0, 0];
  let count = 0;
  for (const at of regionPixels(image, region)) {
    for (let c = 0; c < 3; c++) sum[c] += image.rgba[at + c];
    count++;
  }
  return sum.map((total) => total / count);
}

export function colorNear(color, expected, tolerance = COLOR_TOLERANCE) {
  return color.every((value, c) => Math.abs(value - expected[c]) <= tolerance);
}

/**
 * True when most pixels in the region differ between two frames of the same
 * size. A lossless frame of a static page differs in no pixel.
 */
export function regionChanged(before, after, region = BLOCK_REGION, tolerance = COLOR_TOLERANCE) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error("frames differ in size, so their pixels cannot be compared");
  }
  let changed = 0;
  let count = 0;
  for (const at of regionPixels(before, region)) {
    count++;
    for (let c = 0; c < 3; c++) {
      if (Math.abs(before.rgba[at + c] - after.rgba[at + c]) > tolerance) {
        changed++;
        break;
      }
    }
  }
  return count > 0 && changed / count >= CHANGED_PIXEL_FRACTION;
}

const PAGE = `
<body style="margin:0">
<div id="block" style="height:40vh;background:rgb(255,0,0)"></div>
<input id="otp" autofocus style="font-size:48px">
<button id="go" onclick="document.body.dataset.clicked = 1;
  if (document.getElementById('otp').value === '424242') document.getElementById('block').style.background = 'rgb(0,0,255)'">Go</button>
</body>`;

async function main() {
  const cdpUrl = process.argv[2];
  if (!cdpUrl) {
    console.error("usage: verify-private-display-cdp.mjs <cdp-http-url>");
    process.exit(2);
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setContent(PAGE);
    const session = await context.newCDPSession(page);
    const frames = [];
    session.on("Page.screencastFrame", async (frame) => {
      try {
        frames.push(decodePng(Buffer.from(frame.data, "base64")));
      } catch (error) {
        frames.push({ error: String(error) });
      }
      await session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    });
    // PNG keeps frames lossless, so unchanged pixels compare as equal.
    await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    const waitForFrame = async (accept, fromIndex) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        for (let i = frames.length - 1; i >= fromIndex; i--) {
          if (frames[i].rgba && accept(frames[i])) return frames[i];
        }
        await page.waitForTimeout(50);
      }
      return null;
    };
    const before = await waitForFrame((frame) => colorNear(regionColor(frame), RED), 0);
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
    const after = await waitForFrame((frame) => colorNear(regionColor(frame), BLUE), framesBeforeInput);
    await session.send("Page.stopScreencast");
    const value = await page.locator("#otp").inputValue();
    const clicked = await page.evaluate(() => document.body.dataset.clicked === "1");
    const viewport = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    const decodeErrors = frames.filter((frame) => frame.error).map((frame) => frame.error);
    const result = {
      beforeColor: before ? regionColor(before).map(Math.round) : null,
      afterColor: after ? regionColor(after).map(Math.round) : null,
      // The changed-pixel comparison between the frame before and after input.
      blockChanged: before && after ? regionChanged(before, after) : false,
      // Negative control: a frame compared with itself must show no change.
      controlChanged: before ? regionChanged(before, before) : null,
      clicked,
      decodeErrors,
      frames: frames.length,
      framesAfterInput: frames.length - framesBeforeInput,
      value,
      viewport,
    };
    console.log(JSON.stringify(result));
    const ok =
      before &&
      after &&
      result.blockChanged &&
      result.controlChanged === false &&
      decodeErrors.length === 0 &&
      value === "424242" &&
      clicked;
    if (!ok) process.exit(1);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

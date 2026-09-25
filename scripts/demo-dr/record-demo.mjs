// DR demo: narration-paced screen recording of the live portal flow, the
// fallback for when the venue network fails. Same flow and selectors as
// proactivos-e2e.mjs, slowed down so a presenter can talk over it.
//
//   offer ─yes─▶ Cuenta Única sign-in ─▶ consent (scroll, Allow) ─▶ /listo
//     ─▶ Mis autorizaciones (same tab): what was read, Revoke
//     ─▶ back to /listo: re-read refused, Revocada
//
// Usage:
//   PORTAL_URL=https://proactivos-demo-rd.fly.dev OWNER_PASSWORD=... LANG=es \
//   VIDEO_DIR=./tmp/video [CHROMIUM_PATH=...] node scripts/demo-dr/record-demo.mjs
//
// Writes <VIDEO_DIR>/demo-<lang>.webm.

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:8866").replace(/\/$/, "");
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
const VIDEO_DIR = process.env.VIDEO_DIR ?? "tmp/demo-video";
const LANG = process.env.LANG === "en" ? "en" : "es";
const NAV_TIMEOUT_MS = 30_000;
const SIZE = { height: 800, width: 1280 };

// Pacing (ms): how long each screen stays still, and how slowly pages scroll.
const PAUSE_SHORT = 1_500;
const PAUSE = 3_500;
const PAUSE_LONG = 5_000;
const KEY_DELAY = 120;
const SCROLL_STEP_PX = 6;
const SCROLL_TICK_MS = 16;

// Stable selectors (data attributes and form actions, not text).
const SEL = {
  yes: "form[action='/decir-si'] button[type=submit]",
  reRead: "form[data-action='re-read'] button[type=submit]",
  grant: "[data-grant-id]",
  misAut: "a[data-mis-autorizaciones]",
  revokeForms: "form[action*='/owner/autorizaciones/'][action$='/revocar']",
};

if (!OWNER_PASSWORD) {
  throw new Error("OWNER_PASSWORD is required");
}
mkdirSync(VIDEO_DIR, { recursive: true });

const onPortal = (u) => u.toString().startsWith(PORTAL_URL);
const pause = (page, ms = PAUSE) => page.waitForTimeout(ms);

function step(message) {
  console.log(`- ${message}`);
}

// Scroll smoothly by `px` pixels (negative scrolls up), a few px per frame.
async function glide(page, px) {
  await page.evaluate(
    async ({ px, stepPx, tickMs }) => {
      const dir = Math.sign(px);
      let left = Math.abs(px);
      while (left > 0) {
        const n = Math.min(stepPx, left);
        window.scrollBy(0, dir * n);
        left -= n;
        await new Promise((r) => setTimeout(r, tickMs));
      }
    },
    { px, stepPx: SCROLL_STEP_PX, tickMs: SCROLL_TICK_MS },
  );
}

// Read the whole page top to bottom, a screen at a time with a pause per screen.
async function readPage(page, pauseMs = PAUSE) {
  const { total, view } = await page.evaluate(() => ({
    total: document.documentElement.scrollHeight,
    view: window.innerHeight,
  }));
  const screen = Math.round(view * 0.6);
  let y = await page.evaluate(() => window.scrollY);
  while (y + view < total) {
    const px = Math.min(screen, total - view - y);
    await glide(page, px);
    y += px;
    await pause(page, pauseMs);
  }
}

// Bring an element into the middle of the view, gliding from where we are.
async function glideTo(locator) {
  const page = locator.page();
  const box = await locator.boundingBox();
  if (!box) {
    return;
  }
  const view = await page.evaluate(() => window.innerHeight);
  await glide(page, Math.round(box.y - view / 3));
}

async function toTop(page) {
  const y = await page.evaluate(() => window.scrollY);
  await glide(page, -y);
}

// Click and wait for the page to navigate to a URL matching `until`.
async function clickTo(page, locator, until) {
  await locator.scrollIntoViewIfNeeded();
  await locator.hover();
  await pause(page, PAUSE_SHORT);
  await Promise.all([page.waitForURL(until, { timeout: NAV_TIMEOUT_MS }), locator.click()]);
  await page.waitForLoadState("load");
}

// Sign-in page: type the password visibly, then submit.
async function signIn(page) {
  const password = page.locator("input[type=password]").first();
  if ((await page.locator("input[type=password]").count()) === 0) {
    return;
  }
  await pause(page);
  await password.click();
  await password.pressSequentially(OWNER_PASSWORD, { delay: KEY_DELAY });
  await pause(page, PAUSE_SHORT);

  const button = page.locator("form[action='/owner/login'] button[type=submit]");
  const submit = (await button.count()) > 0 ? button.first() : password.locator("xpath=ancestor::form[1]").locator("button[type=submit]").first();
  await submit.hover();
  await Promise.all([page.waitForLoadState("load"), submit.click()]);
  await page.waitForLoadState("load");
}

// Consent: a review step if present, then read the whole screen and Allow.
async function consent(page) {
  const review = page.locator("form[action$='/consent/review'] button[type=submit]:not([formaction])");
  if ((await review.count()) > 0) {
    await pause(page);
    await readPage(page);
    await Promise.all([page.waitForLoadState("load"), review.first().click()]);
    await page.waitForLoadState("load");
  }

  await pause(page, PAUSE_LONG);
  await readPage(page);

  const approveForm = page.locator("form[action$='/consent/approve']").first();
  const required = approveForm.locator("input[type=checkbox][required]");
  for (let i = 0; i < (await required.count()); i++) {
    await required.nth(i).scrollIntoViewIfNeeded();
    await required.nth(i).check();
    await pause(page, PAUSE_SHORT);
  }
  const approve = approveForm.locator("button[type=submit]:not([formaction])").first();
  await clickTo(page, approve, (u) => onPortal(u));
}

// Revoke the grant: its own form if the page names it, else the first one.
async function revoke(page, grantId) {
  await page.locator(SEL.revokeForms).first().waitFor({ timeout: NAV_TIMEOUT_MS });
  const candidates = [
    page.locator(`${SEL.revokeForms}[action*='/${grantId}/']`),
    page.locator(`[data-grant-id="${grantId}"] ${SEL.revokeForms}, [data-package-id="${grantId}"] ${SEL.revokeForms}`),
    page.locator(SEL.revokeForms),
  ];
  let form = candidates[2].first();
  for (const c of candidates) {
    if ((await c.count()) > 0) {
      form = c.first();
      break;
    }
  }

  // The card holding this form: show it, and open its "what was read" details.
  const card = form.locator("xpath=ancestor::*[self::article or self::section or self::li or @data-grant-id or @data-package-id][1]");
  const target = (await card.count()) > 0 ? card.first() : form;
  await glideTo(target);
  await pause(page);
  const details = target.locator("details:not([open]) > summary");
  for (let i = 0; i < (await details.count()); i++) {
    await details.nth(i).click();
    await pause(page, PAUSE);
  }

  // Down to the revoke button, past "what was read".
  await glideTo(form);
  await pause(page, PAUSE_LONG);

  const boxes = form.locator("input[type=checkbox]");
  for (let i = 0; i < (await boxes.count()); i++) {
    await boxes.nth(i).check();
  }
  const button = form.locator("button[type=submit]").first();
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await pause(page, PAUSE_SHORT);
  await Promise.all([page.waitForLoadState("load"), button.click()]);
  await page.waitForURL(/\/owner\/autorizaciones/, { timeout: NAV_TIMEOUT_MS });
  await page.waitForLoadState("load");
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({
  locale: LANG === "en" ? "en-GB" : "es-DO",
  recordVideo: { dir: VIDEO_DIR, size: SIZE },
  viewport: SIZE,
});
const page = await context.newPage();
const video = page.video();

try {
  step("1. Servicios Proactivos offer");
  await page.goto(`${PORTAL_URL}/?lang=${LANG}`);
  await pause(page, PAUSE_LONG);
  await readPage(page);
  await toTop(page);
  await pause(page, PAUSE_SHORT);

  step("2. Say yes");
  await clickTo(page, page.locator(SEL.yes).first(), (u) => !onPortal(u));

  step("3. Cuenta Única sign-in");
  await signIn(page);
  await page.waitForURL(/\/consent/, { timeout: NAV_TIMEOUT_MS });

  step("4. Consent: read, Allow");
  await consent(page);

  step("5. /listo: data received");
  await page.waitForURL(`${PORTAL_URL}/listo`, { timeout: NAV_TIMEOUT_MS });
  await pause(page, PAUSE_LONG);
  await readPage(page);
  const grantId = await page.locator(SEL.grant).getAttribute("data-grant-id");
  const misAut = page.locator(SEL.misAut);
  const misAutHref = await misAut.getAttribute("href");
  await glideTo(misAut);
  await misAut.hover();
  await pause(page);

  step(`6. Mis autorizaciones (same tab): show ${grantId}, revoke`);
  await page.goto(misAutHref);
  await signIn(page);
  if (!/\/owner\/autorizaciones/.test(page.url())) {
    await page.goto(misAutHref);
  }
  await pause(page, PAUSE_LONG);
  await revoke(page, grantId);

  // Confirmation: this grant's card, now revoked. Older demo grants are skipped.
  const revoked = page.locator(`[data-package-id="${grantId}"], [data-grant-id="${grantId}"]`);
  if ((await revoked.count()) > 0) {
    await glideTo(revoked.first());
  }
  await pause(page, PAUSE_LONG);

  step("7. Back to /listo: re-read refused");
  await page.goto(`${PORTAL_URL}/listo`);
  await pause(page);
  await clickTo(page, page.locator(SEL.reRead).first(), `${PORTAL_URL}/listo`);
  await pause(page, PAUSE_LONG);
  await readPage(page);
  await toTop(page);
  await pause(page, PAUSE_LONG);
  const status = await page.locator(SEL.grant).getAttribute("data-grant-status");
  const refused = await page.locator("[data-notice='revoked']").count();
  console.log(`  grant status: ${status}; revoked notice: ${refused}`);
} finally {
  await context.close();
  await browser.close();
}

// Playwright names the file by a random id; give it a stable one.
const out = join(VIDEO_DIR, `demo-${LANG}.webm`);
renameSync(await video.path(), out);
console.log(`video: ${out}`);

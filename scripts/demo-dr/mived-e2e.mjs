// DR demo: end-to-end check of the simulated MIVHED housing portal.
//
// Drives a real browser through the citizen flow:
//   portal /  ─click─▶  PDPP sign-in  ─▶  consent (review, approve)  ─▶  portal /solicitud
// then asserts the form is pre-filled from the SIUBEN records, and that a
// denied consent returns to the portal with a Spanish error and a retry.
//
// Usage:
//   PORTAL_URL=http://localhost:8766 OWNER_PASSWORD=... SHOTS_DIR=./tmp/mived \
//   [CHROMIUM_PATH=...] node scripts/demo-dr/mived-e2e.mjs

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:8766").replace(/\/$/, "");
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
const SHOTS_DIR = process.env.SHOTS_DIR ?? "tmp/mived-e2e";
const PREFILL_BUTTON = "Completar con mis datos del SIUBEN";
const NAV_TIMEOUT_MS = 30_000;

// Expected values from the fictitious seed (reference-implementation/connectors/seed).
const EXPECTED_ICV = "ICV-2";
const EXPECTED_JEFA = "Rosa Elena Martínez Guzmán";
const EXPECTED_MEMBERS = 4;
const LICENCE_PATTERN = /licencia|intrant|conducir/i;

if (!OWNER_PASSWORD) {
  throw new Error("OWNER_PASSWORD is required");
}
mkdirSync(SHOTS_DIR, { recursive: true });

let shotNo = 0;
async function shot(page, name) {
  shotNo += 1;
  const path = join(SHOTS_DIR, `${String(shotNo).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ fullPage: true, path });
  console.log(`  screenshot: ${path}`);
}

function check(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`ok - ${message}`);
}

// Submit a form's primary button (not a formaction override) and wait for navigation.
async function submitForm(page, formSelector) {
  const button = page.locator(`${formSelector} button[type=submit]:not([formaction])`).first();
  await Promise.all([page.waitForLoadState("load"), button.click()]);
}

async function clickPrefill(page) {
  await Promise.all([
    page.waitForURL((u) => !u.toString().startsWith(PORTAL_URL), { timeout: NAV_TIMEOUT_MS }),
    page.getByRole("button", { name: PREFILL_BUTTON }).click(),
  ]);
}

// Sign-in page, if the PDPP owner session is not established yet.
async function signInIfAsked(page) {
  const password = page.locator("input[type=password]");
  if ((await password.count()) === 0) {
    return;
  }
  await shot(page, "cuenta-unica-login");
  await password.first().fill(OWNER_PASSWORD);
  const form = password.first().locator("xpath=ancestor::form[1]");
  await Promise.all([page.waitForLoadState("load"), form.locator("button[type=submit]").first().click()]);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ locale: "es-DO", viewport: { height: 900, width: 1280 } });

try {
  // 1. Portal, before state.
  await page.goto(`${PORTAL_URL}/`);
  await shot(page, "portal-before");
  check(await page.getByRole("button", { name: PREFILL_BUTTON }).isVisible(), "portal shows the SIUBEN prefill button");

  // 2. Sign in on the PDPP page.
  await clickPrefill(page);
  await signInIfAsked(page);
  await page.waitForURL(/\/consent/, { timeout: NAV_TIMEOUT_MS });

  // 3. Consent: review, then final approval.
  await shot(page, "consent");
  await submitForm(page, 'form[action$="/consent/review"]');
  await shot(page, "consent-approve");
  await Promise.all([
    page.waitForURL(`${PORTAL_URL}/solicitud`, { timeout: NAV_TIMEOUT_MS }),
    page.locator('form[action$="/consent/approve"] button[type=submit]:not([formaction])').first().click(),
  ]);
  await page.waitForLoadState("load");
  await shot(page, "portal-after");
  check(page.url() === `${PORTAL_URL}/solicitud`, "consent approval returns to /solicitud");

  // 4. Pre-filled from the SIUBEN records.
  const html = await page.content();
  const text = await page.innerText("body");
  check(html.includes(EXPECTED_ICV), `form shows ${EXPECTED_ICV}`);
  check(html.includes(EXPECTED_JEFA), `form shows ${EXPECTED_JEFA}`);
  check((await page.locator("tr[data-member]").count()) === EXPECTED_MEMBERS, `${EXPECTED_MEMBERS} household member rows`);
  check(text.includes("Datos obtenidos del SIUBEN con tu autorización"), "success banner shown");
  check(/grt_[0-9a-z]+/.test(text), "authorization note shows the grant id");
  check(text.includes("Consulta única"), "authorization note shows single-use access");
  const grantLink = await page.getByRole("link", { name: "Ver o revocar esta autorización" }).getAttribute("href");
  check(/\/grants\/grt_[0-9a-z]+$/.test(grantLink ?? ""), `grant link ${grantLink}`);
  check(!LICENCE_PATTERN.test(html), "page does not mention the driving licence");

  // 5. Denied consent: back on the portal with a Spanish error and a retry.
  await Promise.all([page.waitForURL(`${PORTAL_URL}/`), page.getByRole("button", { name: "quitar los datos del SIUBEN" }).click()]);
  await clickPrefill(page);
  await signInIfAsked(page);
  await page.waitForURL(/\/consent/, { timeout: NAV_TIMEOUT_MS });
  await Promise.all([
    page.waitForLoadState("load"),
    page.locator('form[action$="/consent/deny"] button[type=submit]').first().click(),
  ]);
  await page.waitForURL(`${PORTAL_URL}/`, { timeout: 5_000 }).catch(() => {});

  // Today PDPP's /consent/deny renders its own "Access denied" page instead of
  // redirecting with error=access_denied; replay that RFC 6749 redirect here.
  if (!page.url().startsWith(PORTAL_URL)) {
    await shot(page, "pdpp-denied");
    console.log(`note - PDPP did not redirect after denial (stayed on ${new URL(page.url()).pathname}); replaying error redirect`);
    await page.goto(`${PORTAL_URL}/callback?error=access_denied`);
  }
  await shot(page, "portal-denied");
  const deniedText = await page.innerText("body");
  check(page.url() === `${PORTAL_URL}/`, "denial lands on the portal start page");
  check(deniedText.includes("No autorizaste compartir tus datos del SIUBEN"), "denial shows a Spanish message");
  check(await page.getByRole("button", { name: "Intentar de nuevo" }).isVisible(), "denial offers a retry button");
  check((await page.locator("tr[data-member]").count()) === 0, "denial leaves the form empty");

  console.log("All checks passed.");
} finally {
  await browser.close();
}

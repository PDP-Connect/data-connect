// DR demo: end-to-end check of the simulated Servicios Proactivos portal.
//
//   portal / (offer) ─yes─▶ PDPP sign-in ─▶ one consent (approve) ─▶ portal /listo
// then: re-read OK, revoke in Mis autorizaciones, re-read refused (copy kept,
// Revocada), denial on a fresh session returns to / with a message, and the
// ES|EN toggle switches the offer text. Selectors on PDPP pages use form
// actions, not text, so copy changes there do not break the check.
//
// Usage:
//   PORTAL_URL=http://localhost:8866 OWNER_PASSWORD=... SHOTS_DIR=./tmp/proactivos \
//   [CHROMIUM_PATH=...] [LANG=en] [DENY_REPLAY=1] node scripts/demo-dr/proactivos-e2e.mjs
//
// DENY_REPLAY=1 tolerates a PDPP /consent/deny that does not redirect back
// (replays error=access_denied); by default that is a failure.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:8866").replace(/\/$/, "");
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
const SHOTS_DIR = process.env.SHOTS_DIR ?? "tmp/proactivos-e2e";
const LANG = process.env.LANG === "en" ? "en" : "es";
const DENY_REPLAY = process.env.DENY_REPLAY === "1";
const NAV_TIMEOUT_MS = 30_000;

// Expected values from the fictitious seed (contract: María + Luis household).
const EXPECTED_DUE_DATE = "2026-11-20";
const EXPECTED_ICV = "ICV-2";
const EXPECTED_MEMBERS = 2;
const EXPECTED_CENTRE = "Hospital Materno Infantil (demo)";
const LICENCE_PATTERN = /licencia|intrant|conducir/i;

// Visible copy the check asserts, per language.
const COPY = {
  en: { yes: "Say yes with Cuenta Única", due: "20 November 2026", revoked: "Revoked", active: "Active" },
  es: { yes: "Decir sí con Cuenta Única", due: "20 de noviembre de 2026", revoked: "Revocada", active: "Vigente" },
};
const C = COPY[LANG];

// Stable portal selectors (data attributes, not text).
const SEL = {
  yes: "form[action='/decir-si'] button[type=submit]",
  reRead: "form[data-action='re-read'] button[type=submit]",
  grant: "[data-grant-id]",
  misAut: "a[data-mis-autorizaciones]",
  member: "tr[data-member]",
};

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

const onPortal = (u) => u.toString().startsWith(PORTAL_URL);

// Click "Decir sí" and wait until the browser leaves the portal.
async function clickYes(page) {
  await Promise.all([
    page.waitForURL((u) => !onPortal(u), { timeout: NAV_TIMEOUT_MS }),
    page.locator(SEL.yes).first().click(),
  ]);
  await page.waitForLoadState("load");
}

// Sign-in page, if the PDPP owner session is not established yet.
async function signInIfAsked(page) {
  const password = page.locator("input[type=password]");
  if ((await password.count()) === 0) {
    return;
  }
  await shot(page, "cuenta-unica-login");
  await password.first().fill(OWNER_PASSWORD);
  const button = page.locator("form[action='/owner/login'] button[type=submit]");
  const submit = (await button.count()) > 0 ? button.first() : password.first().locator("xpath=ancestor::form[1]").locator("button[type=submit]").first();
  await Promise.all([page.waitForLoadState("load"), submit.click()]);
  await page.waitForLoadState("load");
}

// Consent: a review step if it still exists, then approve; ends on the portal.
async function approveConsent(page) {
  const review = page.locator("form[action$='/consent/review'] button[type=submit]:not([formaction])");
  if ((await review.count()) > 0) {
    await shot(page, "consent-review");
    await Promise.all([page.waitForLoadState("load"), review.first().click()]);
    await page.waitForLoadState("load");
  }
  await shot(page, "consent");
  const approveForm = page.locator("form[action$='/consent/approve']").first();
  const approve = approveForm.locator("button[type=submit]:not([formaction])");
  check((await approve.count()) > 0, "consent page has an approve form");

  // Required confirmation checkboxes, if the page still has them.
  const required = approveForm.locator("input[type=checkbox][required]");
  for (let i = 0; i < (await required.count()); i++) {
    await required.nth(i).check();
  }
  await Promise.all([page.waitForURL((u) => onPortal(u), { timeout: NAV_TIMEOUT_MS }), approve.first().click()]);
  await page.waitForLoadState("load");
}

async function clickReRead(page) {
  await Promise.all([
    page.waitForURL(`${PORTAL_URL}/listo`, { timeout: NAV_TIMEOUT_MS }),
    page.locator(SEL.reRead).first().click(),
  ]);
  await page.waitForLoadState("load");
}

// Revoke the grant on Mis autorizaciones: form whose action names the grant,
// else one under [data-grant-id=<id>], else the first revoke form.
async function revokeGrant(tab, grantId) {
  const revokeForms = "form[action*='/owner/autorizaciones/'][action$='/revocar']";
  await tab.locator(revokeForms).first().waitFor({ timeout: NAV_TIMEOUT_MS });
  const candidates = [
    tab.locator(`${revokeForms}[action*='/${grantId}/']`),
    tab.locator(`[data-grant-id="${grantId}"] ${revokeForms}, [data-package-id="${grantId}"] ${revokeForms}, ${revokeForms}[data-grant-id="${grantId}"]`),
    tab.locator(revokeForms),
  ];
  let form = candidates[2].first();
  for (const c of candidates) {
    if ((await c.count()) > 0) {
      form = c.first();
      break;
    }
  }
  console.log(`  revoke form: ${await form.getAttribute("action")}`);

  // A confirmation checkbox, if the page has one.
  const boxes = form.locator("input[type=checkbox]");
  for (let i = 0; i < (await boxes.count()); i++) {
    await boxes.nth(i).check();
  }
  await Promise.all([tab.waitForLoadState("load"), form.locator("button[type=submit]").first().click()]);
  await tab.waitForURL(/\/owner\/autorizaciones/, { timeout: NAV_TIMEOUT_MS });
  await tab.waitForLoadState("load");
}

const CONTEXT_OPTIONS = { locale: LANG === "en" ? "en-GB" : "es-DO", viewport: { height: 900, width: 1280 } };
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let context = await browser.newContext(CONTEXT_OPTIONS);
let page = await context.newPage();

try {
  // 0. Language toggle on the offer page.
  await page.goto(`${PORTAL_URL}/?lang=en`);
  await shot(page, "offer-en");
  check((await page.locator(SEL.yes).innerText()).includes(COPY.en.yes), "EN toggle shows the English offer");
  check((await page.locator("html").getAttribute("lang")) === "en", "html lang=en");
  await page.locator("a[data-lang-toggle='es']").click();
  await page.waitForLoadState("load");
  await shot(page, "offer-es");
  check((await page.locator(SEL.yes).innerText()).includes(COPY.es.yes), "ES toggle shows the Spanish offer");
  check((await page.locator("a[data-lang-toggle='es']").getAttribute("aria-current")) === "true", "ES marked active");

  // 1. The offer, in the run language.
  await page.goto(`${PORTAL_URL}/?lang=${LANG}`);
  await shot(page, "offer");
  check(await page.locator(SEL.yes).isVisible(), "offer shows the yes button");
  check((await page.locator("[data-source]").count()) === 2, "offer explains both sources");

  // 2. Yes -> sign in -> one consent -> approve.
  await clickYes(page);
  const authorize = new URL(page.url());
  if (authorize.pathname.endsWith("/oauth/authorize")) {
    check(authorize.searchParams.get("ui_locales") === LANG, `authorize carries ui_locales=${LANG}`);
  }
  await signInIfAsked(page);
  await page.waitForURL(/\/consent/, { timeout: NAV_TIMEOUT_MS });
  await approveConsent(page);
  await shot(page, "listo");
  check(page.url() === `${PORTAL_URL}/listo`, "approval returns to /listo");

  // 3. What was received.
  const html = await page.content();
  const text = await page.innerText("body");
  check((await page.locator(`[data-due-date="${EXPECTED_DUE_DATE}"]`).count()) === 1, `due date ${EXPECTED_DUE_DATE} received from SNS`);
  check(text.includes(C.due), `lead shows "${C.due}"`);
  check(text.includes(EXPECTED_CENTRE), "health centre shown");
  check((await page.locator(`[data-icv="${EXPECTED_ICV}"]`).count()) === 1, `household ${EXPECTED_ICV} received from SIUBEN`);
  check((await page.locator(SEL.member).count()) === EXPECTED_MEMBERS, `${EXPECTED_MEMBERS} household member rows`);
  const grantId = await page.locator(SEL.grant).getAttribute("data-grant-id");
  check(/^(grt|gpkg)_[0-9a-z]+$/.test(grantId ?? ""), `authorization card shows grant ${grantId}`);
  check((await page.locator(SEL.grant).getAttribute("data-grant-status")) === "active", `authorization ${C.active}`);
  check(!LICENCE_PATTERN.test(html), "page does not mention the driving licence");
  const misAut = page.locator(SEL.misAut);
  const misAutHref = await misAut.getAttribute("href");
  check(/\/owner\/autorizaciones(\?|$)/.test(misAutHref ?? ""), `Mis autorizaciones link ${misAutHref}`);
  check((await misAut.getAttribute("target")) === "_blank", "Mis autorizaciones opens in a new tab");

  // 4. Re-read while active.
  await clickReRead(page);
  await shot(page, "listo-reread");
  check((await page.locator("[data-notice='verified']").count()) === 1, "re-read OK banner shown");
  check((await page.locator(SEL.member).count()) === EXPECTED_MEMBERS, "re-read member rows");

  // 5. Revoke in Mis autorizaciones (same browser, so the owner session carries over).
  const tab = await context.newPage();
  await tab.goto(misAutHref);
  await signInIfAsked(tab);
  if (!/\/owner\/autorizaciones/.test(tab.url())) {
    await tab.goto(misAutHref);
  }
  await shot(tab, "mis-autorizaciones");
  await revokeGrant(tab, grantId);
  await shot(tab, "mis-autorizaciones-revoked");
  check(/\/owner\/autorizaciones/.test(tab.url()), "revoke returns to Mis autorizaciones");
  await tab.close();

  // 6. Back on the portal: re-read refused, copy kept, Revocada.
  await page.bringToFront();
  await clickReRead(page);
  await shot(page, "listo-revoked");
  const revokedText = await page.innerText("body");
  check((await page.locator("[data-notice='revoked']").count()) === 1, "re-read refused: revoked alert shown");
  check((await page.locator(SEL.grant).getAttribute("data-grant-status")) === "revoked", "authorization marked revoked");
  check(revokedText.includes(C.revoked), `shows "${C.revoked}"`);
  check((await page.locator(SEL.reRead).count()) === 0, "re-read button removed");
  check(await page.locator(SEL.yes).first().isVisible(), "offers to ask again");
  check((await page.locator(`[data-due-date="${EXPECTED_DUE_DATE}"]`).count()) === 1, "received copy kept");

  // 7. Denial on a fresh portal session.
  await context.close();
  context = await browser.newContext(CONTEXT_OPTIONS);
  page = await context.newPage();
  await page.goto(`${PORTAL_URL}/?lang=${LANG}`);
  await clickYes(page);
  await signInIfAsked(page);
  await page.waitForURL(/\/consent/, { timeout: NAV_TIMEOUT_MS });
  await shot(page, "consent-before-deny");
  const deny = page.locator("form[action$='/consent/deny'] button[type=submit]");
  check((await deny.count()) > 0, "consent page has a deny form");
  await Promise.all([page.waitForLoadState("load"), deny.first().click()]);
  await page.waitForURL((u) => onPortal(u), { timeout: 5_000 }).catch(() => {});
  if (!onPortal(page.url())) {
    await shot(page, "pdpp-denied");
    check(DENY_REPLAY, `PDPP redirects back after denial (stayed on ${new URL(page.url()).pathname})`);
    console.log("note - DENY_REPLAY: replaying error=access_denied");
    await page.goto(`${PORTAL_URL}/callback?error=access_denied`);
  }
  await shot(page, "offer-denied");
  check(page.url() === `${PORTAL_URL}/`, "denial lands on the offer");
  check((await page.locator("[data-notice='denied']").count()) === 1, "denial message shown");
  check((await page.locator(SEL.member).count()) === 0, "no data shown after denial");

  console.log("All checks passed.");
} catch (err) {
  // Keep evidence of where the flow stopped.
  await shot(page, "failure").catch(() => {});
  console.log(`  stopped at: ${page.url()}`);
  throw err;
} finally {
  await browser.close();
}

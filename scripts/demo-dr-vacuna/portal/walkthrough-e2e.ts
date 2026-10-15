// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Browser walkthrough of the deployed (or local) demo, with screenshots.
// Runs the TEST-CREDENTIALS.md story end to end in one language and viewport:
//
//   1 María (one child): start → Conectar → Cuenta Única → child → review → approve
//     → reminder app shows the next dose from a real read
//   2 Carmen (two children): picks Ana (overdue dose)
//   3 Juan approves Diego; Rosa (other parent) sees it in Mis autorizaciones and
//     withdraws it with "delete"; the service dashboard shows the data deleted
//   4 Pedro asks for Camila's record by number: the civil registry refuses
//   5 Altagracia: Miguel (17) → expiry is his 18th birthday
//   6 María withdraws with "keep"; dashboard shows the data kept
//
//   BASE_URL=http://localhost:8080 DEMO_LANG=es VIEWPORT=desktop|phone \
//   SHOTS=scripts/demo-dr-vacuna/portal/screenshots node walkthrough-e2e.ts
//
// Each run adds grants: reset the demo between runs (../deploy/DEPLOY.md).

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { WALKTHROUGH_PASSWORD } from "./walkthrough-data.ts";

const BASE_URL = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const LANG = process.env.DEMO_LANG === "en" ? "en" : "es";
const VIEWPORT = process.env.VIEWPORT === "phone" ? "phone" : "desktop";
const SHOTS = process.env.SHOTS || "";
const PASSWORD = process.env.DEMO_PASSWORD || WALKTHROUGH_PASSWORD;

const size = VIEWPORT === "phone" ? { height: 844, width: 390 } : { height: 900, width: 1280 };

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) {
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ fullPage: true, path: join(SHOTS, `${LANG}-${VIEWPORT}-${name}.png`), scale: "css" });
}

async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ deviceScaleFactor: 1, locale: LANG === "en" ? "en-US" : "es-DO", viewport: size });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // The language cookie is set by the first page that carries ?lang=.
  await page.goto(`${BASE_URL}/pilot/vacuna?lang=${LANG}`);
  return page;
}

async function signIn(page: Page, cedula: string): Promise<void> {
  await page.waitForURL(/\/pilot\/cuenta-unica\/login/);
  await page.fill("#cu-cedula", cedula);
  await page.fill("#cu-password", PASSWORD);
  await page.click("button[type=submit]");
}

async function connect(page: Page, opts: { recordNumber?: string }): Promise<void> {
  await page.goto(`${BASE_URL}/recordatorio`);
  if (opts.recordNumber) {
    await page.click("details.vd-more summary");
    await page.fill("#vd-child", opts.recordNumber);
  }
  await page.click("[data-connect]");
}

async function pickAndApprove(page: Page, childId: string, shotPick?: string, shotReview?: string): Promise<void> {
  await page.waitForURL(/\/pilot\/vacuna\/consent\?/);
  await page.check(`[data-child-id="${childId}"] input`);
  if (shotPick) {
    await shot(page, shotPick);
  }
  await page.click("button[form=cu-select]");
  await page.waitForURL(/\/pilot\/vacuna\/consent\/review/);
  await page.waitForSelector("[data-acting-as]");
  if (shotReview) {
    await shot(page, shotReview);
  }
  await page.click(`form[action$="/approve"] button`);
  await page.waitForURL(/\/recordatorio\?hijo=/);
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // 1 — María, one child.
  const maria = await newPerson(browser);
  await shot(maria, "01-landing");
  await maria.click("[data-start]");
  await maria.waitForURL(/\/recordatorio$/);
  await shot(maria, "02-reminder-landing");
  await maria.click("[data-connect]");
  await maria.waitForURL(/\/pilot\/cuenta-unica\/login/);
  await shot(maria, "03-cuenta-unica-login");
  await signIn(maria, "001-0000001-1");
  await pickAndApprove(maria, "DR-9100001", "04-pick-one-child", "05-review");
  await maria.waitForSelector("[data-connected-child=DR-9100001] [data-next-dose]");
  assert.match(await maria.textContent("[data-next-dose]") ?? "", /Pentavalente|Pentavalent/);
  await shot(maria, "06-reminder-connected");

  // 2 — Carmen, two children: picks Ana (overdue).
  const carmen = await newPerson(browser);
  await connect(carmen, {});
  await signIn(carmen, "001-0000002-2");
  await pickAndApprove(carmen, "DR-9100003", "07-pick-two-children");
  assert.equal(await carmen.getAttribute("[data-connected-child] .vd-dose", "data-status"), "overdue");
  await shot(carmen, "08-reminder-overdue");

  // 3 — Juan approves Diego; Rosa withdraws it with "delete".
  const juan = await newPerson(browser);
  await connect(juan, {});
  await signIn(juan, "001-0000003-3");
  await pickAndApprove(juan, "DR-9100004");
  const rosa = await newPerson(browser);
  await rosa.goto(`${BASE_URL}/pilot/vacuna/autorizaciones`);
  await signIn(rosa, "001-0000004-4");
  await rosa.waitForURL(/\/pilot\/vacuna\/autorizaciones/);
  const diego = rosa.locator('article[data-child-id="DR-9100004"][data-grant-status="active"]').first();
  assert.equal(await diego.locator("[data-approved-by]").getAttribute("data-approved-by"), "other");
  await shot(rosa, "09-mis-autorizaciones-other-parent");
  await diego.locator('input[value="delete"]').check();
  await diego.locator("button[type=submit]").click();
  await rosa.waitForSelector('[data-revoke-banner="delete"]');
  await shot(rosa, "10-revoked-delete");

  // 4 — Pedro: the registry refuses (authority suspended).
  const pedro = await newPerson(browser);
  await connect(pedro, { recordNumber: "DR-9100007" });
  await signIn(pedro, "001-0000006-6");
  await pedro.waitForSelector("[data-named-record]");
  await shot(pedro, "11-named-record");
  await pedro.click("button[form=cu-select]");
  await pedro.waitForSelector('[data-result="refused"]');
  await shot(pedro, "12-registry-refusal");
  await pedro.click("[data-return-to-app]");
  await pedro.waitForSelector("[data-connect-denied]");
  await shot(pedro, "13-reminder-denied");

  // 5 — Altagracia: Miguel turns 18 on 20 Nov 2026.
  const alta = await newPerson(browser);
  await connect(alta, {});
  await signIn(alta, "001-0000007-7");
  await alta.waitForURL(/\/pilot\/vacuna\/consent\?/);
  await alta.check('[data-child-id="DR-9100008"] input');
  await alta.click("button[form=cu-select]");
  await alta.waitForSelector("[data-expires-at]");
  assert.match((await alta.getAttribute("[data-expires-at]", "data-expires-at")) ?? "", /^2026-11-20/);
  await shot(alta, "14-review-near-18");
  await alta.click(`form[action$="/approve"] button`);
  await alta.waitForURL(/\/recordatorio\?hijo=DR-9100008/);

  // 6 — María withdraws Sofía's with "keep".
  await maria.goto(`${BASE_URL}/pilot/vacuna/autorizaciones`);
  const sofia = maria.locator('article[data-child-id="DR-9100001"][data-grant-status="active"]').first();
  await sofia.locator('input[value="keep"]').check();
  await sofia.locator("button[type=submit]").click();
  await maria.waitForSelector('[data-revoke-banner="keep"]');

  // The service's view: Diego deleted, Sofía kept, others active.
  const service = await newPerson(browser);
  await service.goto(`${BASE_URL}/recordatorio/panel`);
  await service.waitForSelector('[data-child-row="DR-9100004"][data-status="deleted"]');
  await service.waitForSelector('[data-child-row="DR-9100001"][data-status="ended_keep"]');
  await service.waitForSelector('[data-child-row="DR-9100003"][data-status="active"]');
  await shot(service, "15-service-dashboard");
  console.log(`walkthrough ok (${LANG}, ${VIEWPORT})`);
} finally {
  await browser.close();
}

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
//   VIDEO_DIR=./tmp/video [CHROMIUM_PATH=...] [DESELECT=1] [CAPTIONS=0] node scripts/demo-dr/record-demo.mjs
//
// DESELECT=1: on consent, visibly untick the household-members stream and the
// health-centre field; /listo then pauses on the "not shared" lines.
// CAPTIONS=0: no on-screen captions or highlight rings (on by default).
//
// Writes <VIDEO_DIR>/demo-<lang>[-deselect].webm.

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:8866").replace(/\/$/, "");
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
const VIDEO_DIR = process.env.VIDEO_DIR ?? "tmp/demo-video";
const LANG = process.env.LANG === "en" ? "en" : "es";
const DESELECT = process.env.DESELECT === "1";
const CAPTIONS = process.env.CAPTIONS !== "0";
const NAV_TIMEOUT_MS = 30_000;
const SIZE = { height: 800, width: 1280 };

// Pacing (ms): how long each screen stays still, and how slowly pages scroll.
const PAUSE_SHORT = 1_500;
const PAUSE = 3_500;
const PAUSE_LONG = 5_000;
const KEY_DELAY = 120;
const SCROLL_STEP_PX = 6;
const SCROLL_TICK_MS = 16;
const CAPTION_MS = 4_000;
const RING_PAD_PX = 6;

// Stable selectors (data attributes and form actions, not text).
const SEL = {
  yes: "form[action='/decir-si'] button[type=submit]",
  reRead: "form[data-action='re-read'] button[type=submit]",
  grant: "[data-grant-id]",
  misAut: "a[data-mis-autorizaciones]",
  revokeForms: "form[action*='/owner/autorizaciones/'][action$='/revocar']",
  offer: "[data-offer]",
  needs: "ul.needs",
  until: "[data-until]",
  signInCard: ".cu-card",
  consentRow: ".cu-summary > div",
  approve: "form[action$='/consent/approve'] button[type=submit]",
  dropStream: "label.cu-pick:has(input[data-consent-stream='miembros_hogar'])",
  dropField: "li[data-consent-stream-row='control_prenatal'] label:has(input[data-consent-field='centro_salud'])",
  received: ".data-cards",
  notShared: "[data-not-shared]",
  reads: "ol.cu-reads, .cu-reads-empty",
  revokedNotice: "[data-notice='revoked']",
};

// Consent summary rows, in page order (as-consent-ui-helpers renderDeclaredConsentHtml).
const ROW = { WHO: 0, PURPOSE: 1, INSTITUTIONS: 2, DATA: 3, UNTIL: 5 };

// On-screen captions, one per beat, in the video's language.
const BEATS = {
  offer: {
    en: "Servicios Proactivos offers to arrange the baby's vaccinations and child benefit — no application needed.",
    es: "Servicios Proactivos ofrece organizar las vacunas y el bono por hijo, sin que María lo solicite.",
  },
  needs: { en: "It says exactly what it needs, and why.", es: "Dice exactamente qué necesita y para qué." },
  until: { en: "…and until when.", es: "…y hasta cuándo." },
  signIn: {
    en: "The same Cuenta Única sign-in as any government service.",
    es: "El mismo inicio de sesión de Cuenta Única que cualquier servicio del Estado.",
  },
  who: { en: "One screen: who is asking…", es: "Una sola pantalla: quién solicita…" },
  purpose: { en: "…for what purpose…", es: "…para qué…" },
  data: { en: "…from which institutions, and which fields.", es: "…de qué instituciones y qué datos." },
  dropStream: {
    en: "María chooses what to share: she unticks her household members…",
    es: "María decide qué compartir: desmarca los miembros del hogar…",
  },
  dropField: { en: "…and her health centre.", es: "…y su centro de salud." },
  ends: { en: "Access ends on 31 January 2027.", es: "El acceso termina el 31 de enero de 2027." },
  approve: { en: "She approves.", es: "María autoriza." },
  received: {
    en: "The service received only what she allowed: the due date from SNS, the household classification from SIUBEN.",
    es: "El servicio recibió solo lo que ella autorizó: la fecha probable de parto (SNS) y la clasificación del hogar (SIUBEN).",
  },
  notShared: {
    en: "What she unticked never left the institutions.",
    es: "Lo que desmarcó nunca salió de las instituciones.",
  },
  reads: {
    en: "She can see every permission, and what was read and when.",
    es: "Ve cada autorización, y qué se leyó y cuándo.",
  },
  revoke: { en: "…and cancel it at any time.", es: "…y puede cancelarla en cualquier momento." },
  revoked: {
    en: "Once revoked, the service can no longer read her records.",
    es: "Una vez revocada, el servicio ya no puede leer sus datos.",
  },
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

// ── Captions + highlight ring (recording overlay only; the apps are untouched) ──
//
//   ┌──────────── page ────────────┐
//   │   ╔═ amber ring ═╗           │  absolutely positioned over the target's box
//   │   ║   target     ║           │  (document coordinates, pointer-events: none)
//   │   ╚══════════════╝           │
//   │ ▓▓ caption bar (fixed) ▓▓▓▓▓ │  dark, white 24px, max 2 lines
//   └──────────────────────────────┘
// Injected on demand, so every newly loaded page gets it again.
async function ensureOverlay(page) {
  await page.evaluate(() => {
    if (document.getElementById("rec-caption")) {
      return;
    }
    const style = document.createElement("style");
    style.textContent = `
#rec-caption { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647;
  max-width: min(1200px, 94vw); padding: 12px 24px; border-radius: 12px; background: rgba(10, 14, 22, .86);
  color: #fff; font: 500 22px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .35); pointer-events: none; opacity: 0; transition: opacity .35s; }
#rec-caption.on { opacity: 1; }
#rec-ring { position: absolute; z-index: 2147483646; pointer-events: none; border: 3px solid #FFB300; border-radius: 10px;
  box-shadow: 0 0 0 4px rgba(255, 179, 0, .25), 0 0 22px 6px rgba(255, 179, 0, .45);
  opacity: 0; transition: opacity .3s; animation: rec-pulse 1.4s ease-in-out infinite; }
#rec-ring.on { opacity: 1; }
@keyframes rec-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.015); } }`;
    const caption = Object.assign(document.createElement("div"), { id: "rec-caption" });
    const ring = Object.assign(document.createElement("div"), { id: "rec-ring" });
    document.head.append(style);
    document.body.append(ring, caption);
  });
}

// Ring around the union of every element the locators match.
async function showRing(page, locators) {
  const boxes = [];
  for (const locator of locators) {
    for (const el of await locator.all()) {
      const box = await el.boundingBox();
      if (box) {
        boxes.push(box);
      }
    }
  }
  if (boxes.length === 0) {
    return;
  }
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  await page.evaluate(
    ({ left, top, right, bottom, pad }) => {
      const ring = document.getElementById("rec-ring");
      Object.assign(ring.style, {
        height: `${bottom - top + 2 * pad}px`,
        left: `${left + window.scrollX - pad}px`,
        top: `${top + window.scrollY - pad}px`,
        width: `${right - left + 2 * pad}px`,
      });
      ring.classList.add("on");
    },
    { bottom, left, pad: RING_PAD_PX, right, top },
  );
}

async function hideOverlay(page) {
  await page.evaluate(() => {
    document.getElementById("rec-caption")?.classList.remove("on");
    document.getElementById("rec-ring")?.classList.remove("on");
  });
}

// One beat: bring the target into view, caption + ring, hold, then clear.
// `hold` runs while both are shown (e.g. an untick); without captions only the pacing remains.
async function beat(page, key, targets, { hold = null, ms = CAPTION_MS } = {}) {
  const list = Array.isArray(targets) ? targets : [targets];
  const first = list[0]?.first();
  if (first && (await first.count()) > 0) {
    await glideTo(first);
  }
  if (!CAPTIONS) {
    await pause(page, ms);
    await hold?.();
    return;
  }
  await ensureOverlay(page);
  await page.evaluate((text) => {
    const caption = document.getElementById("rec-caption");
    caption.textContent = text;
    caption.classList.add("on");
  }, BEATS[key][LANG]);
  await showRing(page, list);
  await pause(page, ms);
  await hold?.();
  await hideOverlay(page);
  await pause(page, 400);
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
  await beat(page, "signIn", page.locator(SEL.signInCard));
  await password.click();
  await password.pressSequentially(OWNER_PASSWORD, { delay: KEY_DELAY });
  await pause(page, PAUSE_SHORT);

  const button = page.locator("form[action='/owner/login'] button[type=submit]");
  const submit = (await button.count()) > 0 ? button.first() : password.locator("xpath=ancestor::form[1]").locator("button[type=submit]").first();
  await submit.hover();
  await Promise.all([page.waitForLoadState("load"), submit.click()]);
  await page.waitForLoadState("load");
}

// Untick one consent box where the viewer can see it: caption, hover, pause, click.
async function untick(page, key, selector) {
  const label = page.locator(selector).first();
  await beat(page, key, label, {
    hold: async () => {
      await label.hover();
      await pause(page, PAUSE_SHORT);
      await label.locator("input[type=checkbox]").click();
      await pause(page, PAUSE_SHORT);
    },
  });
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

  await pause(page, PAUSE_SHORT);
  const rows = page.locator(SEL.consentRow);
  if (CAPTIONS) {
    await beat(page, "who", rows.nth(ROW.WHO));
    await beat(page, "purpose", rows.nth(ROW.PURPOSE));
    await beat(page, "data", [rows.nth(ROW.INSTITUTIONS), rows.nth(ROW.DATA)], { ms: PAUSE_LONG });
  } else {
    await readPage(page);
  }
  if (DESELECT) {
    await untick(page, "dropStream", SEL.dropStream);
    await untick(page, "dropField", SEL.dropField);
  }
  if (CAPTIONS) {
    await beat(page, "ends", rows.nth(ROW.UNTIL));
    await beat(page, "approve", page.locator(SEL.approve).first(), { ms: PAUSE_SHORT * 2 });
  }

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

  // "What was read", then down to the revoke button.
  await beat(page, "reads", target.locator(SEL.reads).first(), { ms: PAUSE_LONG });
  await glideTo(form);
  await pause(page, PAUSE_SHORT);

  const boxes = form.locator("input[type=checkbox]");
  for (let i = 0; i < (await boxes.count()); i++) {
    await boxes.nth(i).check();
  }
  const button = form.locator("button[type=submit]").first();
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await beat(page, "revoke", button);
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
  await pause(page, PAUSE_SHORT);
  if (CAPTIONS) {
    await beat(page, "offer", page.locator(SEL.offer), { ms: PAUSE_LONG });
    await beat(page, "needs", page.locator(SEL.needs));
    await beat(page, "until", page.locator(SEL.until));
  } else {
    await pause(page, PAUSE);
    await readPage(page);
  }
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
  await pause(page, PAUSE);
  await beat(page, "received", page.locator(SEL.received), { ms: PAUSE_LONG });
  if (DESELECT) {
    await beat(page, "notShared", page.locator(SEL.notShared), { ms: PAUSE_LONG });
  }
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
  await pause(page, PAUSE_SHORT);
  await beat(page, "revoked", page.locator(SEL.revokedNotice), { ms: PAUSE_LONG });
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
const out = join(VIDEO_DIR, `demo-${LANG}${DESELECT ? "-deselect" : ""}.webm`);
renameSync(await video.path(), out);
console.log(`video: ${out}`);

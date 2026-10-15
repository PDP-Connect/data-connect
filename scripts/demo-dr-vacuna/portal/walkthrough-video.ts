// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Captioned screen recording of the walkthrough (the walkthrough-e2e.ts story),
// with a caption bar, a pointer that moves to each click, and outlines around
// the parts of the page a scene is about. Each scene is its own browser
// context and video segment; the segments are joined into one MP4, so waiting
// for on-chain settlement between the last two scenes is not recorded.
//
//   BASE_URL=https://vacuna-al-dia-demo.fly.dev DEMO_LANG=en|es \
//   OUT=/path/walkthrough-en.mp4 node walkthrough-video.ts
//
// Needs ffmpeg on PATH. Adds grants and paid reads like walkthrough-e2e.ts:
// start from a reset demo and reset again afterwards (../deploy/DEPLOY.md).
// SETTLE_WAIT_S (default 420) bounds the wait for the relayer; 0 skips the
// settlement scene.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { WALKTHROUGH_PASSWORD } from "./walkthrough-data.ts";

const BASE_URL = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const LANG = process.env.DEMO_LANG === "es" ? "es" : "en";
const OUT = resolve(process.env.OUT || `walkthrough-${LANG}.mp4`);
const PASSWORD = process.env.DEMO_PASSWORD || WALKTHROUGH_PASSWORD;
const SETTLE_WAIT_S = Number(process.env.SETTLE_WAIT_S ?? 420);
const SIZE = { height: 800, width: 1280 };
const t = (es: string, en: string) => (LANG === "es" ? es : en);
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- overlay (runs in the page) -------------------------------------------

interface OverlayState {
  caption: string;
  scene: string;
}

const OVERLAY_CSS = `
#demo-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:1040px;width:calc(100% - 120px);
  background:rgba(17,24,39,.92);color:#fff;font:500 22px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;
  padding:14px 22px;border-radius:12px;z-index:2147483646;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none}
#demo-cap:empty{display:none}
#demo-scene{position:fixed;left:16px;top:16px;background:#FDE047;color:#111;font:700 14px/1 system-ui,sans-serif;
  padding:8px 12px;border-radius:999px;z-index:2147483646;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.2)}
#demo-scene:empty{display:none}
#demo-ptr{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:rgba(239,68,68,.35);
  border:3px solid #EF4444;z-index:2147483647;pointer-events:none;opacity:0;transition:left .7s ease,top .7s ease,opacity .3s}
.demo-ring{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:4px solid #EF4444;
  z-index:2147483647;pointer-events:none;animation:demo-ring .7s ease-out forwards}
@keyframes demo-ring{to{transform:scale(3.4);opacity:0}}
.demo-spot{position:fixed;border:4px solid #FACC15;border-radius:10px;z-index:2147483645;pointer-events:none;
  box-shadow:0 0 0 9999px rgba(0,0,0,.28);animation:demo-in .3s ease-out}
.demo-spot b{position:absolute;left:-4px;bottom:100%;margin-bottom:8px;background:#FACC15;color:#111;
  font:700 16px/1.3 system-ui,sans-serif;padding:6px 10px;border-radius:8px;white-space:nowrap}
.demo-spot.below b{bottom:auto;top:100%;margin:8px 0 0}
@keyframes demo-in{from{opacity:0}to{opacity:1}}
#demo-card{position:fixed;inset:0;background:#0F3D2E;color:#fff;z-index:2147483647;display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;font-family:system-ui,sans-serif;padding:60px}
#demo-card h1{font-size:46px;margin:0 0 18px} #demo-card p{font-size:24px;max-width:900px;line-height:1.45;opacity:.9;margin:6px 0}`;

function installOverlay(state: OverlayState & { css: string; ptr: { x: number; y: number } | null }): void {
  const doc = document;
  if (!doc.getElementById("demo-css")) {
    const style = doc.createElement("style");
    style.id = "demo-css";
    style.textContent = state.css;
    doc.head.appendChild(style);
  }
  for (const id of ["demo-cap", "demo-scene"]) {
    if (!doc.getElementById(id)) {
      const el = doc.createElement("div");
      el.id = id;
      doc.body.appendChild(el);
    }
  }
  doc.getElementById("demo-cap")!.textContent = state.caption;
  doc.getElementById("demo-scene")!.textContent = state.scene;
  if (state.ptr && !doc.getElementById("demo-ptr")) {
    const p = doc.createElement("div");
    p.id = "demo-ptr";
    p.style.left = `${state.ptr.x}px`;
    p.style.top = `${state.ptr.y}px`;
    doc.body.appendChild(p);
  }
}

// ---- director --------------------------------------------------------------

/** Scrolls an element to the middle of the viewport, above the caption bar. */
async function centre(loc: ReturnType<Page["locator"]>): Promise<void> {
  await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await pause(450);
}

class Scene {
  readonly page: Page;
  private state: OverlayState;
  private ptr: { x: number; y: number } | null = null;

  constructor(page: Page, scene: string) {
    this.page = page;
    this.state = { caption: "", scene };
    page.on("load", () => void this.sync());
  }

  private async sync(): Promise<void> {
    await this.page
      .evaluate(installOverlay, { ...this.state, css: OVERLAY_CSS, ptr: this.ptr })
      .catch(() => undefined);
  }

  /** Shows a caption and holds it long enough to read. */
  async say(caption: string, holdMs = 2600): Promise<void> {
    this.state.caption = caption;
    await this.sync();
    await pause(holdMs);
  }

  async goto(path: string): Promise<void> {
    await this.page.goto(`${BASE_URL}${path}`);
    await this.sync();
  }

  private async pointAt(selector: string): Promise<{ x: number; y: number }> {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: "visible" });
    await centre(loc);
    await pause(250);
    const box = (await loc.boundingBox())!;
    const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    this.ptr ??= { x: SIZE.width / 2, y: SIZE.height / 2 };
    await this.sync();
    await this.page.evaluate((p) => {
      const el = document.getElementById("demo-ptr")!;
      el.style.opacity = "1";
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
    }, at);
    await pause(800);
    this.ptr = at;
    return at;
  }

  /** Moves the pointer to the element, pulses a ring, then clicks it. */
  async click(selector: string, opts: { check?: boolean } = {}): Promise<void> {
    const at = await this.pointAt(selector);
    await this.page.evaluate((p) => {
      const r = document.createElement("div");
      r.className = "demo-ring";
      r.style.left = `${p.x}px`;
      r.style.top = `${p.y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 800);
    }, at);
    await pause(450);
    const loc = this.page.locator(selector).first();
    await (opts.check ? loc.check() : loc.click());
    await pause(500);
    // Fade the pointer so it does not sit on top of what comes next.
    await this.page
      .evaluate(() => {
        const el = document.getElementById("demo-ptr");
        if (el) el.style.opacity = "0";
      })
      .catch(() => undefined);
  }

  /** Types visibly into a field. */
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.page.locator(selector).first().pressSequentially(text, { delay: 70 });
    await pause(300);
  }

  /** Outlines an element (dimming the rest) with an optional label, then removes it. */
  async spot(selector: string, label = "", holdMs = 3000): Promise<void> {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: "visible" });
    await centre(loc);
    await pause(400);
    const box = (await loc.boundingBox())!;
    await this.page.evaluate(
      ({ b, label }) => {
        const s = document.createElement("div");
        s.className = `demo-spot${b.y < 70 ? " below" : ""}`;
        Object.assign(s.style, { height: `${b.height + 16}px`, left: `${b.x - 8}px`, top: `${b.y - 8}px`, width: `${b.width + 16}px` });
        if (label) {
          const l = document.createElement("b");
          l.textContent = label;
          s.appendChild(l);
        }
        document.body.appendChild(s);
      },
      { b: box, label }
    );
    await pause(holdMs);
    await this.page.evaluate(() => document.querySelectorAll(".demo-spot").forEach((s) => s.remove()));
  }

  /** Full-screen title card. */
  async card(title: string, lines: string[], holdMs = 4500): Promise<void> {
    await this.page.evaluate(
      ({ css, title, lines }) => {
        if (!document.getElementById("demo-css")) {
          const style = document.createElement("style");
          style.id = "demo-css";
          style.textContent = css;
          document.head.appendChild(style);
        }
        const c = document.createElement("div");
        c.id = "demo-card";
        const h = document.createElement("h1");
        h.textContent = title;
        c.appendChild(h);
        for (const line of lines) {
          const p = document.createElement("p");
          p.textContent = line;
          c.appendChild(p);
        }
        document.body.appendChild(c);
      },
      { css: OVERLAY_CSS, lines, title }
    );
    await pause(holdMs);
    await this.page.evaluate(() => document.getElementById("demo-card")?.remove());
  }

  async signIn(cedula: string): Promise<void> {
    await this.page.waitForURL(/\/pilot\/cuenta-unica\/login/);
    await this.say(t("Inicia sesión con Cuenta Única, la identidad digital del Estado.", "They sign in with Cuenta Única, the government's digital identity."), 2200);
    await this.type("#cu-cedula", cedula);
    await this.type("#cu-password", PASSWORD);
    this.state.caption = "";
    await this.click("button[type=submit]");
  }
}

const segments: string[] = [];
const workDir = mkdtempSync(join(tmpdir(), "vacuna-video-"));

async function scene(browser: Browser, label: string, run: (s: Scene) => Promise<void>): Promise<void> {
  const context: BrowserContext = await browser.newContext({
    deviceScaleFactor: 1,
    locale: LANG === "en" ? "en-US" : "es-DO",
    recordVideo: { dir: workDir, size: SIZE },
    viewport: SIZE,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const s = new Scene(page, label);
  try {
    // The language cookie is set by the first page that carries ?lang=.
    await page.goto(`${BASE_URL}/pilot/vacuna?lang=${LANG}`);
    await run(s);
    await pause(800);
  } finally {
    const video = page.video();
    await context.close();
    if (video) {
      segments.push(await video.path());
    }
  }
  console.log(`recorded: ${label}`);
}

async function connectFromApp(s: Scene, recordNumber?: string): Promise<void> {
  await s.goto("/recordatorio");
  if (recordNumber) {
    await s.click("details.vd-more summary");
    await s.type("#vd-child", recordNumber);
  }
  await s.click("[data-connect]");
}

async function pick(s: Scene, childId: string): Promise<void> {
  await s.page.waitForURL(/\/pilot\/vacuna\/consent\?/);
  await s.click(`[data-child-id="${childId}"] input`, { check: true });
  await s.click("button[form=cu-select]");
  await s.page.waitForURL(/\/pilot\/vacuna\/consent\/review/);
}

async function approve(s: Scene, childId: string): Promise<void> {
  await s.click(`form[action$="/approve"] button`);
  await s.page.waitForURL(new RegExp(`/recordatorio\\?hijo=${childId}`));
}

async function dashboardHtml(): Promise<string> {
  const res = await fetch(`${BASE_URL}/recordatorio/panel?lang=${LANG}`);
  return res.text();
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await scene(browser, t("1 · María, un hijo", "1 · María, one child"), async (s) => {
    await s.card("Vacuna al día", [
      t("Recordatorios de vacunas con el permiso de madres y padres.", "Vaccine reminders, with the parent's permission."),
      t("Demostración del piloto PDPP: Cuenta Única, Registro Civil y el registro nacional de vacunación.", "PDPP pilot walkthrough: Cuenta Única, the civil registry and the national vaccination register."),
      t("Pagos por lectura liquidados en la red de prueba Moksha de Vana.", "Per-read payments settled on Vana's Moksha testnet."),
    ]);
    await s.say(t("María tiene una hija, Sofía. Quiere que le recuerden sus vacunas.", "María has one daughter, Sofía. She wants reminders for Sofía's vaccines."), 3200);
    await s.click("[data-start]");
    await s.page.waitForURL(/\/recordatorio$/);
    await s.say(t("«Vacuna al día» es un servicio externo. Todavía no tiene ningún dato de Sofía.", "“Vacuna al día” is a third-party service. It has no data about Sofía yet."), 3200);
    await s.spot("[data-connect]", t("Pide permiso, no datos", "It asks for permission, not data"), 2400);
    await s.click("[data-connect]");
    await s.signIn("001-0000001-1");
    await s.page.waitForURL(/\/pilot\/vacuna\/consent\?/);
    await s.say(t("El Registro Civil indica de qué niños María es madre. Ella elige a Sofía.", "The civil registry says which children María is the parent of. She picks Sofía."), 3000);
    await pick(s, "DR-9100001");
    await s.say(t("Antes de autorizar, María ve exactamente qué se comparte.", "Before authorizing, María sees exactly what is shared."), 2200);
    await s.spot("[data-acting-as]", t("Parentesco confirmado por el Registro Civil", "Parenthood confirmed by the civil registry"), 3200);
    await s.spot(".cu-summary > div:nth-child(3)", t("Solo el registro de vacunación: sin nombre ni cédula", "Only the vaccination record: no name, no cédula"), 3600);
    await s.spot("[data-expires-at]", t("Vence sola a los 18 años", "Expires on its own at 18"), 3000);
    await s.say(t("María autoriza.", "María authorizes."), 1400);
    await approve(s, "DR-9100001");
    await s.page.waitForSelector("[data-connected-child=DR-9100001] [data-next-dose]");
    await s.say(t("El servicio leyó el registro de Sofía y ya sabe su próxima dosis. Esa lectura se pagó en Moksha.", "The service read Sofía's record and knows her next dose. That read was paid on Moksha."), 1500);
    await s.spot("[data-connected-child=DR-9100001]", t("Leído del registro nacional", "Read from the national register"), 3800);
  });

  await scene(browser, t("2 · Carmen, dos hijos", "2 · Carmen, two children"), async (s) => {
    await s.say(t("Carmen tiene dos hijos. Autoriza solo a Ana, que tiene una dosis atrasada.", "Carmen has two children. She authorizes only Ana, who is behind on a dose."), 3000);
    await connectFromApp(s);
    await s.signIn("001-0000002-2");
    await s.page.waitForURL(/\/pilot\/vacuna\/consent\?/);
    await s.spot("fieldset.cu-choices", t("Cada hijo se autoriza por separado", "Each child is authorized separately"), 3000);
    await pick(s, "DR-9100003");
    await approve(s, "DR-9100003");
    await s.spot("[data-connected-child] .vd-dose", t("Dosis atrasada detectada", "Overdue dose flagged"), 3600);
  });

  await scene(browser, t("3 · Juan autoriza a Diego", "3 · Juan authorizes Diego"), async (s) => {
    await s.say(t("Juan, padre de Diego, autoriza los recordatorios.", "Juan, Diego's father, authorizes reminders."), 2400);
    await connectFromApp(s);
    await s.signIn("001-0000003-3");
    await pick(s, "DR-9100004");
    await s.say(t("Juan revisa lo que se comparte y autoriza.", "Juan reviews what is shared and authorizes."), 2600);
    await approve(s, "DR-9100004");
    await s.say(t("Diego queda conectado.", "Diego is connected."), 2200);
  });

  await scene(browser, t("3 · Rosa, la otra madre/padre", "3 · Rosa, the other parent"), async (s) => {
    await s.say(t("Rosa, la madre de Diego, entra a «Mis autorizaciones».", "Rosa, Diego's mother, opens “My authorizations”."), 2600);
    await s.goto("/pilot/vacuna/autorizaciones");
    await s.signIn("001-0000004-4");
    await s.page.waitForURL(/\/pilot\/vacuna\/autorizaciones/);
    const diego = 'article[data-child-id="DR-9100004"][data-grant-status="active"]';
    await s.say(t("Rosa ve la autorización de Diego, aunque la dio Juan.", "Rosa sees Diego's authorization, even though Juan gave it."), 1200);
    await s.spot(`${diego} [data-approved-by]`, t("Autorizada por el otro padre", "Approved by the other parent"), 3400);
    await s.say(t("Cualquiera de los dos puede retirarla. Rosa la retira y pide borrar los datos.", "Either parent can withdraw it. Rosa withdraws it and asks for the data to be deleted."), 2400);
    await s.click(`${diego} input[value="delete"]`, { check: true });
    await s.click(`${diego} button[type=submit]`);
    await s.page.waitForSelector('[data-revoke-banner="delete"]');
    await s.spot('[data-revoke-banner="delete"]', t("Retirada: el servicio debe borrar", "Withdrawn: the service must delete"), 3400);
  });

  await scene(browser, t("4 · Pedro, sin autoridad", "4 · Pedro, no authority"), async (s) => {
    await s.say(t("Pedro pide el registro de Camila por número. Su autoridad está suspendida.", "Pedro asks for Camila's record by number. His parental authority is suspended."), 3000);
    await connectFromApp(s, "DR-9100007");
    await s.signIn("001-0000006-6");
    await s.page.waitForSelector("[data-named-record]");
    await s.say(t("La solicitud es solo para ese registro. Pedro continúa.", "The request is for that one record. Pedro continues."), 2400);
    await s.click("button[form=cu-select]");
    await s.page.waitForSelector('[data-result="refused"]');
    await s.spot('[data-result="refused"]', t("El Registro Civil lo rechaza", "The civil registry refuses"), 3600);
    await s.click("[data-return-to-app]");
    await s.page.waitForSelector("[data-connect-denied]");
    await s.spot("[data-connect-denied]", t("El servicio no recibe nada", "The service receives nothing"), 3200);
  });

  await scene(browser, t("5 · Altagracia, hijo de 17 años", "5 · Altagracia, a 17-year-old"), async (s) => {
    await s.say(t("Miguel, hijo de Altagracia, cumple 18 el 20 de noviembre de 2026.", "Altagracia's son Miguel turns 18 on 20 November 2026."), 2800);
    await connectFromApp(s);
    await s.signIn("001-0000007-7");
    await s.page.waitForURL(/\/pilot\/vacuna\/consent\?/);
    await s.say(t("Altagracia elige a Miguel.", "Altagracia picks Miguel."), 1600);
    await pick(s, "DR-9100008");
    await s.spot("[data-expires-at]", t("La autorización termina el día que cumple 18", "The authorization ends on his 18th birthday"), 3800);
    await approve(s, "DR-9100008");
    await s.say(t("A partir de esa fecha, el servicio ya no puede leer su registro.", "From that date, the service can no longer read his record."), 2800);
  });

  await scene(browser, t("6 · María retira y conserva", "6 · María withdraws, keeps data"), async (s) => {
    await s.say(t("María retira su autorización, pero deja que el servicio conserve lo ya recibido.", "María withdraws her authorization, but lets the service keep what it already received."), 2800);
    await s.goto("/pilot/vacuna/autorizaciones");
    await s.signIn("001-0000001-1");
    await s.page.waitForURL(/\/pilot\/vacuna\/autorizaciones/);
    const sofia = 'article[data-child-id="DR-9100001"][data-grant-status="active"]';
    await s.say(t("María elige «Conservarlos» y retira la autorización.", "María chooses “Keep them” and withdraws."), 1600);
    await s.click(`${sofia} input[value="keep"]`, { check: true });
    await s.click(`${sofia} button[type=submit]`);
    await s.page.waitForSelector('[data-revoke-banner="keep"]');
    await s.spot('[data-revoke-banner="keep"]', t("Retirada: sin más lecturas", "Withdrawn: no more reads"), 3200);
  });

  await scene(browser, t("7 · Lo que ve el servicio", "7 · What the service sees"), async (s) => {
    await s.goto("/recordatorio/panel");
    await s.say(t("El panel de «Vacuna al día»: números de registro, sin nombres.", "The “Vacuna al día” dashboard: record numbers, no names."), 3000);
    await s.spot('[data-child-row="DR-9100004"]', t("Diego: datos borrados", "Diego: data deleted"), 3000);
    await s.spot('[data-child-row="DR-9100001"]', t("Sofía: retirada, datos conservados", "Sofía: withdrawn, data kept"), 3000);
    await s.spot('[data-child-row="DR-9100003"]', t("Ana: activa", "Ana: active"), 2600);
    await s.say(t("Cada semana el servicio vuelve a leer los registros activos. Aquí lo forzamos.", "Every week the service reads active records again. Here we trigger it now."), 2600);
    await s.click("[data-read-now]");
    await s.page.waitForURL(/leido=1/);
    await s.spot('[data-stat="payments"]', t("Cada lectura se paga", "Every read is paid for"), 3000);
    await s.spot("tr[data-payment]", t("Aceptado por el gateway de Vana", "Accepted by the Vana gateway"), 3400);
    await s.say(t("El relayer del gateway liquida cada pago en la cadena en unos minutos.", "The gateway's relayer settles each payment on chain within minutes."), 3000);
  });

  if (SETTLE_WAIT_S > 0) {
    // Not recorded: wait for every payment row to show as settled.
    const deadline = Date.now() + SETTLE_WAIT_S * 1000;
    for (;;) {
      const html = await dashboardHtml();
      const rows = html.match(/<tr data-payment=[^>]*>/g) ?? [];
      const settled = rows.filter((r) => r.includes('data-settlement="settled"')).length;
      console.log(`settlement: ${settled}/${rows.length}`);
      if ((rows.length > 0 && settled === rows.length) || Date.now() > deadline) {
        break;
      }
      await pause(20_000);
    }
    await scene(browser, t("8 · Liquidado en Moksha", "8 · Settled on Moksha"), async (s) => {
      await s.goto("/recordatorio/panel");
      await s.say(t("Unos minutos después: los pagos aparecen liquidados en la cadena.", "A few minutes later: the payments show as settled on chain."), 2600);
      await s.spot('tr[data-settlement="settled"]', t("Liquidado, con su transacción", "Settled, with its transaction"), 3400);
      const link = 'tr[data-settlement="settled"] a[data-tx]';
      if (await s.page.locator(link).count()) {
        const href = await s.page.locator(link).first().getAttribute("href");
        await s.click(link).catch(() => undefined);
        // The link opens a new tab in a real browser; follow it in this page.
        if (href && !s.page.url().startsWith(href)) {
          await s.page.goto(href);
        }
        await s.page.waitForLoadState("load").catch(() => undefined);
        await s.say(t("La transacción en el explorador de Moksha.", "The transaction on the Moksha explorer."), 1500);
        await s
          .spot("text=recordAccessAndSettle", t("Liquidado por el relayer del gateway", "Settled by the gateway relayer"), 4000)
          .catch(() => undefined);
      }
    });
  }
} finally {
  await browser.close();
}

// Join the segments into one H.264 MP4.
mkdirSync(join(OUT, ".."), { recursive: true });
const list = join(workDir, "segments.txt");
writeFileSync(list, segments.map((p) => `file '${p}'`).join("\n"));
execFileSync(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-movflags", "+faststart", OUT],
  { stdio: "inherit" }
);
console.log(`video: ${OUT}`);

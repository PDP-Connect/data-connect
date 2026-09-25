// DR citizen-assistant demo: headless end-to-end check.
//
// Plays an MCP client (like Claude or ChatGPT) against a running reference
// server: registers via DCR, opens the authorize URL in Chromium, signs in on
// the simulated Cuenta Única page, approves only the SIUBEN streams on the
// Spanish consent screen, exchanges the code, then calls the hosted MCP tools.
// Screenshots land in SHOTS_DIR.
//
// Usage:
//   AS_URL=http://localhost:7662 RS_URL=http://localhost:7663 \
//   OWNER_PASSWORD=... SHOTS_DIR=./tmp/demo-dr node scripts/demo-dr/e2e-check.mjs

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright";

const AS_URL = process.env.AS_URL ?? "http://localhost:7662";
const RS_URL = process.env.RS_URL ?? "http://localhost:7663";
const MCP_URL = process.env.MCP_URL ?? `${RS_URL}/mcp`;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;
const SHOTS_DIR = process.env.SHOTS_DIR ?? "tmp/demo-dr";
const REDIRECT_URI = "http://127.0.0.1:8765/callback";

if (!OWNER_PASSWORD) {
  throw new Error("OWNER_PASSWORD is required");
}
mkdirSync(SHOTS_DIR, { recursive: true });

const b64url = (buf) => buf.toString("base64url");

async function registerClient() {
  const res = await fetch(`${AS_URL}/oauth/register`, {
    body: JSON.stringify({
      client_name: "Asistente de prueba (MCP)",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`DCR failed ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.client_id;
}

async function authorizeInBrowser(clientId, challenge, state) {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage({ locale: "es-DO", viewport: { height: 900, width: 1100 } });
  // A real listener: Playwright routes do not see server-issued redirects.
  let callbackUrl = null;
  const callbackServer = createServer((req, res) => {
    if (req.url?.startsWith("/callback")) {
      callbackUrl = `http://127.0.0.1:8765${req.url}`;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Autorización recibida.");
  });
  await new Promise((resolve) => callbackServer.listen(8765, "127.0.0.1", resolve));

  const authorize = new URL(`${AS_URL}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: MCP_URL,
    response_type: "code",
    state,
  }).toString();

  await page.goto(authorize.toString());
  await page.screenshot({ fullPage: true, path: join(SHOTS_DIR, "1-login.png") });
  await page.fill("#hosted-ui-password", OWNER_PASSWORD);
  await Promise.all([page.waitForLoadState("load"), page.click("button[type=submit]")]);

  await page.waitForSelector("[data-hosted-mcp-picker-form]");
  await page.screenshot({ fullPage: true, path: join(SHOTS_DIR, "2-consent.png") });

  const siuben = page.locator('[data-hosted-mcp-source][data-source-key*="siuben"]');
  await siuben.locator("summary").click();
  for (const box of await siuben.locator("[data-hosted-mcp-stream-checkbox]").all()) {
    await box.check();
  }
  await page.screenshot({ fullPage: true, path: join(SHOTS_DIR, "3-consent-siuben-selected.png") });
  await Promise.all([
    page.waitForURL((url) => url.toString().startsWith(REDIRECT_URI) || callbackUrl !== null, { timeout: 15_000 }).catch(() => {}),
    page.click('[data-hosted-mcp-picker-form] button[type=submit][data-variant="primary"]'),
  ]);
  await page.waitForTimeout(500);
  if (!callbackUrl) {
    await page.screenshot({ fullPage: true, path: join(SHOTS_DIR, "x-after-submit.png") });
    throw new Error(`No callback; landed on ${page.url()}`);
  }
  callbackServer.close();
  return { browser, callback: new URL(callbackUrl), page };
}

async function exchangeCode(clientId, code, verifier) {
  const res = await fetch(`${AS_URL}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: MCP_URL,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`token failed ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

function parseMcpResponse(text) {
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines.at(-1) : text);
}

async function mcp(token, sessionId, id, method, params) {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const res = await fetch(MCP_URL, {
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    headers,
    method: "POST",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MCP ${method} ${res.status}: ${text}`);
  }
  return { body: parseMcpResponse(text), sessionId: res.headers.get("mcp-session-id") ?? sessionId };
}

const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(8));

const clientId = await registerClient();
console.log("registered client:", clientId);
const { browser, callback, page } = await authorizeInBrowser(clientId, challenge, state);
if (callback.searchParams.get("state") !== state) {
  throw new Error(`state mismatch: ${callback}`);
}
const code = callback.searchParams.get("code");
if (!code) {
  throw new Error(`no code in callback: ${callback}`);
}
const token = await exchangeCode(clientId, code, verifier);
console.log("token issued");

let session = null;
const init = await mcp(token, session, 1, "initialize", {
  capabilities: {},
  clientInfo: { name: "demo-dr-e2e", version: "0.0.0" },
  protocolVersion: "2025-06-18",
});
session = init.sessionId;
const tools = await mcp(token, session, 2, "tools/list", {});

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`ok - ${message}`);
}
const textOf = (response) => JSON.stringify(response.body);

const toolNames = tools.body.result.tools.map((tool) => tool.name);
assert(toolNames.includes("query_records"), `MCP exposes query_records (${toolNames.join(", ")})`);

const schema = await mcp(token, session, 3, "tools/call", { arguments: {}, name: "schema" });
assert(textOf(schema).includes("clasificacion_hogar"), "schema lists the granted SIUBEN stream");
assert(!textOf(schema).includes("licencias_conducir"), "schema hides the ungranted INTRANT stream");

const readHogar = (id) =>
  mcp(token, session, id, "tools/call", { arguments: { stream: "clasificacion_hogar" }, name: "query_records" });
const hogar = await readHogar(4);
assert(textOf(hogar).includes("ICV-2"), "granted SIUBEN household record is readable");

const licencia = await mcp(token, session, 5, "tools/call", {
  arguments: { stream: "licencias_conducir" },
  name: "query_records",
});
assert(textOf(licencia).includes("stream_not_allowed"), "ungranted INTRANT licence read is refused");

const hogarAgain = await readHogar(6);
assert(textOf(hogarAgain).includes("ICV-2"), "grant still works after a refused read");
// Optional (composed mode only): revoke in the console, as the presenter would.
if (process.env.REVOKE === "1") {
  await page.goto(`${AS_URL}/grants`);
  await page.locator('a[href*="/grants/packages/gpkg_"]').first().click();
  await page.waitForSelector('input[name="confirm_revoke"]');
  await page.screenshot({ fullPage: true, path: join(SHOTS_DIR, "4-package-before-revoke.png") });
  await page.check('input[name="confirm_revoke"]');
  await page.getByRole("button", { name: "Revoke package" }).click();
  await page.getByText("Package revoked.").waitFor({ timeout: 20_000 });
  await page.screenshot({ fullPage: true, path: join(SHOTS_DIR, "5-package-revoked.png") });
  const afterRevoke = await mcp(token, session, 7, "tools/call", {
    arguments: { stream: "clasificacion_hogar" },
    name: "query_records",
  }).then(
    (response) => textOf(response),
    (error) => String(error)
  );
  assert(!afterRevoke.includes("ICV-2"), "after revoking in the console, the assistant can no longer read");
}
await browser.close();
console.log("\nAll checks passed. Grant timeline: <origin>/grants in the console.");

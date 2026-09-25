// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "patchright";
import { createConnectorInstallStore, inspectActiveConnector } from "../reference-implementation/server/connector-install/index.ts";
import { initDb } from "../reference-implementation/server/db.ts";
import { createSqliteConnectorInstanceStore } from "../reference-implementation/server/stores/connector-instance-store.ts";

const origin = requiredEnv("PDPP_CORE_SMOKE_ORIGIN");
const setupToken = requiredEnv("PDPP_CORE_SMOKE_SETUP_TOKEN");
const ownerPassword = requiredEnv("PDPP_CORE_SMOKE_OWNER_PASSWORD");
const fixtureRef = "waspflow/deployrestore-0923";
const clientId = `https://raw.githubusercontent.com/PDP-Connect/data-connect/${fixtureRef}/scripts/fixtures/docker-core-smoke-cimd.json`;
const privateKeyPath = "/app/scripts/fixtures/docker-core-smoke-private-key.pem";

function requiredEnv(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set`);
  return value;
}

async function waitForResponse(page, urlPath, method, action) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === urlPath && candidate.request().method() === method
    ),
    action(),
  ]);
  return response;
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function signClientAssertion({ audience, clientId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "docker-core-smoke-key", typ: "JWT" })).toString(
    "base64url"
  );
  const claims = Buffer.from(
    JSON.stringify({ aud: audience, exp: now + 60, iat: now, iss: clientId, sub: clientId })
  ).toString("base64url");
  const signingInput = `${header}.${claims}`;
  return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);

  const setup = await page.goto(`${origin}/setup`, { waitUntil: "domcontentloaded" });
  assert.equal(setup?.status(), 200, "first boot must show the owner setup form");
  await page.getByLabel("Setup token").fill(setupToken);
  await page.getByLabel(/New password/).fill(ownerPassword);
  const claim = await waitForResponse(page, "/setup", "POST", () =>
    page.getByRole("button", { name: "Claim this install" }).click()
  );
  assert.equal(claim.status(), 201, "setup token must claim first sign-in");

  await page.goto(`${origin}/owner/login?return_to=%2F`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Owner password").fill(ownerPassword);
  const login = await waitForResponse(page, "/owner/login", "POST", () =>
    page.getByRole("button", { name: "Sign in" }).click()
  );
  assert.ok(login.status() < 400, `owner sign-in returned ${login.status()}`);
  await page.waitForURL(`${origin}/`, { timeout: 45_000 });

  await page.getByRole("link", { name: "Sources", exact: true }).click();
  await page.waitForURL("**/sources");
  await page.getByRole("link", { name: /Add a source/ }).click();
  await page.waitForURL("**/sources/add");
  await page.getByTestId("source-setup-list").first().waitFor({ state: "visible" });
  const documentId = await page.evaluate(() => {
    window.__coreSmokeDocumentId = crypto.randomUUID();
    return window.__coreSmokeDocumentId;
  });

  const sourceRowIds = await page
    .locator('[data-testid^="source-setup-"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));
  for (const connector of ["claude-code", "codex"]) {
    const sourceRow = page.getByTestId(`source-setup-${connector}`);
    assert.equal(
      await sourceRow.count(),
      1,
      `runtime source catalog is missing ${connector}; rows=${JSON.stringify(sourceRowIds)}; page=${(await page.locator("main").innerText()).slice(0, 900)}`
    );
    await sourceRow.waitFor({ state: "visible" });
    const installRow = sourceRow.getByTestId("connector-install-row");
    const install = installRow.getByRole("button", { name: "Install", exact: true });
    await install.waitFor({ state: "visible" });
    await install.click();
    await installRow.locator('[role="status"], [role="alert"]').first().waitFor({ state: "visible", timeout: 60_000 });
    const installResultText = (await installRow.innerText()).replace(/\s+/gu, " ");
    assert.match(installResultText, /Install complete/, `${connector} install failed: ${installResultText}`);
    await installRow.getByTestId("connector-package-status").filter({ hasText: /Installed|Active/i }).waitFor({ state: "visible" });
  }

  // Installing a connector package does not create an owner connection. Seed
  // the same disposable active-instance fixture used by hosted-mcp-oauth.test
  // so the real consent flow has a source with eligible streams to authorize.
  initDb(process.env.PDPP_DB_PATH || "/var/lib/pdpp/pdpp.sqlite");
  const connectorId = "claude-code";
  const installed = await inspectActiveConnector(createConnectorInstallStore(), connectorId);
  assert.equal(
    installed.status,
    "active",
    `${connectorId} must have a verified active install before OAuth; status=${installed.status}; reason=${"reason" in installed ? installed.reason : "none"}`
  );
  const connectorInstanceId = `cin_hosted_${connectorId}`;
  const now = new Date().toISOString();
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName: `${connectorId} Docker smoke fixture`,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });

  const documentIdAfterInstalls = await page.evaluate(() => window.__coreSmokeDocumentId);
  assert.equal(documentIdAfterInstalls, documentId, "/sources/add must remain on the loaded app document after installs");

  const whatsapp = await page.goto(`${origin}/connect/manual-upload/whatsapp`, { waitUntil: "domcontentloaded" });
  assert.equal(whatsapp?.status(), 200, "WhatsApp manual-upload route must render");
  await page.getByLabel("Export files").waitFor({ state: "visible" });
  assert.ok(
    (await page.locator("main").innerText()).match(/WhatsApp|export/i),
    "manual-upload route must render WhatsApp export instructions"
  );

  // The CIMD document is an external, public test fixture on this branch. This
  // preserves Core's real URL fetch and SSRF checks while the private key stays
  // a committed, non-production test vector.
  const verifier = randomBytes(32).toString("base64url");
  const redirectUri = "http://localhost:42173/callback";
  const state = `core-smoke-${Date.now()}`;
  const authorize = new URL(`${origin}/oauth/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");

  await page.route(`${redirectUri}**`, async (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "OAuth callback captured" })
  );
  const authorized = await page.goto(authorize.toString(), { waitUntil: "domcontentloaded" });
  assert.equal(
    authorized?.status(),
    200,
    `OAuth request must reach owner consent; body=${(await page.locator("body").innerText()).slice(0, 500)}`
  );
  await page.getByRole("heading", { name: /wants to read your data/ }).waitFor({ state: "visible" });
  await page.getByLabel("Share data from Claude Code").check();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await page.waitForURL(`${redirectUri}**`, { timeout: 45_000 });
  const callback = new URL(page.url());
  assert.equal(callback.searchParams.get("state"), state, "consent callback must preserve state");
  const code = callback.searchParams.get("code");
  assert.ok(code, "consent callback must carry an authorization code");

  const tokenEndpoint = `${origin}/oauth/token`;
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  const tokenResponse = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_assertion: signClientAssertion({ audience: tokenEndpoint, clientId, privateKey }),
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const tokenBody = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200, `private_key_jwt token exchange failed: ${JSON.stringify(tokenBody)}`);
  assert.equal(tokenBody.token_type, "Bearer");
  assert.equal(typeof tokenBody.access_token, "string", "OAuth must issue an access token");
  console.log(
    "docker-core-demo-smoke: setup, two installs, runtime source catalog, WhatsApp route, and CIMD private_key_jwt OAuth passed"
  );
} finally {
  await browser.close();
}

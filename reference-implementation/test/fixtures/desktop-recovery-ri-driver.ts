// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-RI driver for the desktop recovery test in src-tauri/src/unified.rs
 * (`a_desktop_recovery_start_revokes_owner_sessions_and_bearers_in_the_real_ri`).
 *
 * The Rust test runs this file twice on one encrypted database:
 *   - `seed`: signs in, mints an owner bearer through the device flow, checks
 *     both work, writes them to argv[3], and exits.
 *   - `recover`: runs under the RI environment the desktop builds for a
 *     recovery start (started by the desktop's process supervisor). It checks
 *     the session and bearer from the seed file (argv[4]), writes the result
 *     to argv[3], and prints
 *     READY, which is the supervisor's readiness marker.
 *
 * All startup inputs come from the environment and PDPP_DATA_DIR, as they do
 * for the staged RI. This file makes no recovery inputs of its own.
 *
 * The owner-password tests in src-tauri/src/unified.rs use two more modes:
 *   - `request-password-window`: writes the console's owner-password window
 *     request (purpose argv[4], re-auth grant id argv[5] for a change) with
 *     the RI's own writer, writes `{ requestId }` to argv[3], and exits
 *     without starting a server.
 *   - `turn-on-remote-access`: signs in, mints an owner bearer, asks to turn
 *     remote access on from off, writes `{ status, code }` to argv[3], and
 *     exits.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../server/index.ts";
import { requestOwnerPasswordWindow } from "../../server/owner-password-owner-set.ts";

const [mode, outputPath, seedPath] = process.argv.slice(2);
const password = process.env.PDPP_OWNER_PASSWORD ?? "";
const dataDir = process.env.PDPP_DATA_DIR ?? "";
if (!(mode && outputPath && password && dataDir && process.env.PDPP_DATABASE_ENCRYPTION_KEY)) {
  throw new Error("driver needs mode, output path, PDPP_OWNER_PASSWORD, PDPP_DATA_DIR and PDPP_DATABASE_ENCRYPTION_KEY");
}

function cookiePair(resp: Response, name: string): string | null {
  for (const header of resp.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

async function csrfFrom(url: string, cookie?: string): Promise<{ cookie: string; field: string }> {
  const page = await fetch(url, {
    headers: { Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) },
    redirect: "manual",
  });
  const csrfCookie = cookiePair(page, "pdpp_owner_csrf");
  const field = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!(csrfCookie && field)) throw new Error(`no CSRF token at ${url} (status ${page.status})`);
  return { cookie: csrfCookie, field };
}

async function login(asUrl: string): Promise<string> {
  const csrf = await csrfFrom(`${asUrl}/owner/login`);
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrf.field, password, return_to: "/" }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Cookie: csrf.cookie },
    method: "POST",
    redirect: "manual",
  });
  const session = cookiePair(resp, "pdpp_owner_session");
  if (!session) throw new Error(`login set no owner session (status ${resp.status})`);
  return session;
}

async function mintOwnerBearer(asUrl: string, session: string): Promise<string> {
  // The published CLI's client, which a desktop server registers; it leaves
  // the demo clients out.
  const clientId = "pdpp_cli";
  const device = (await (
    await fetch(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).json()) as { device_code: string; user_code: string };
  const csrf = await csrfFrom(`${asUrl}/device?user_code=${encodeURIComponent(device.user_code)}`, session);
  const approve = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ _csrf: csrf.field, user_code: device.user_code }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `${session}; ${csrf.cookie}`,
    },
    method: "POST",
    redirect: "manual",
  });
  if (approve.status >= 400) throw new Error(`device approval failed (status ${approve.status})`);
  const token = (await (
    await fetch(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).json()) as { access_token?: string };
  if (!token.access_token) throw new Error("device exchange issued no owner bearer");
  return token.access_token;
}

async function sessionStatus(asUrl: string, session: string): Promise<number> {
  return (await fetch(`${asUrl}/owner/session`, { headers: { Cookie: session }, redirect: "manual" })).status;
}

async function bearerStatus(rsUrl: string, bearer: string): Promise<number> {
  return (await fetch(`${rsUrl}/v1/owner/control`, { headers: { Authorization: `Bearer ${bearer}` } })).status;
}

if (mode === "request-password-window") {
  const [purposeArg, grantId] = process.argv.slice(4);
  const purpose = purposeArg === "change" ? "change" : "initial_setup";
  writeFileSync(
    outputPath,
    JSON.stringify(await requestOwnerPasswordWindow(dataDir, grantId ? { grantId, purpose } : { purpose }))
  );
  process.exit(0);
}

const server = await startServer({
  asPort: Number(process.env.AS_PORT ?? 0),
  dbPath: join(dataDir, "pdpp.sqlite"),
  ownerAuthPassword: password,
  quiet: true,
  rsPort: Number(process.env.RS_PORT ?? 0),
});
const asUrl = `http://127.0.0.1:${server.asPort}`;
const rsUrl = `http://127.0.0.1:${server.rsPort}`;

if (mode === "seed") {
  const session = await login(asUrl);
  const bearer = await mintOwnerBearer(asUrl, session);
  writeFileSync(
    outputPath,
    JSON.stringify({
      bearer,
      bearerStatus: await bearerStatus(rsUrl, bearer),
      session,
      sessionStatus: await sessionStatus(asUrl, session),
    })
  );
  process.exit(0);
}

if (mode === "turn-on-remote-access") {
  const bearer = await mintOwnerBearer(asUrl, await login(asUrl));
  const resp = await fetch(`${rsUrl}/v1/owner/remote-access/config`, {
    body: JSON.stringify({
      fields: {
        PDPP_BIND_HOST: "127.0.0.1",
        PDPP_REFERENCE_ORIGIN: "https://vault.example.com",
        PDPP_TRUSTED_HOSTS: "vault.example.com",
        PDPP_TRUSTED_PROXIES: "",
      },
      posture: "public_url",
      provider: "user_supplied_origin",
    }),
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    method: "POST",
  });
  const body = (await resp.json()) as { error?: { code?: string } };
  writeFileSync(outputPath, JSON.stringify({ code: body.error?.code ?? null, status: resp.status }));
  process.exit(0);
}

const seeded = JSON.parse(readFileSync(seedPath ?? "", "utf8")) as { bearer: string; session: string };
const fresh = await login(asUrl);
writeFileSync(
  outputPath,
  JSON.stringify({
    freshSessionStatus: await sessionStatus(asUrl, fresh),
    oldBearerStatus: await bearerStatus(rsUrl, seeded.bearer),
    oldSessionStatus: await sessionStatus(asUrl, seeded.session),
  })
);
console.log("READY");

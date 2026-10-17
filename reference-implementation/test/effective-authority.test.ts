// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// CP 3.3.9: real SQLite and child code prove persistence before first egress.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { emitSpineEvent, listSpineEventsPage } from "../lib/spine.ts";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath, makeTemporaryDir } from "./helpers/temp-dir.ts";

const REQUIRED_BINDING_ERROR = /cannot satisfy required binding/;
const PERSISTENCE_ERROR = /cannot persist effective authority/;
const CSRF_INPUT = /name="_csrf" value="([^"]+)"/;

const runId = "run_effective_authority";
const connectorId = "authority_test";

function setup(t: { after: (fn: () => void) => void }) {
  closeDb();
  const dbPath = makeTemporaryDbPath("authority-");
  initDb(dbPath);
  t.after(() => closeDb());
  return dbPath;
}

function options(connectorPath: string) {
  return {
    admitRunConnection: async () => ({
      connectorId,
      connectorInstanceId: "cin_authority",
      ownerSubjectId: "owner",
    }),
    connectorId,
    connectorInstanceId: "cin_authority",
    connectorPath,
    manifest: {
      runtime_requirements: { bindings: { network: { required: true } } },
      streams: [
        {
          name: "items",
          primary_key: "id",
          schema: { properties: { id: { type: "string" } }, type: "object" },
        },
      ],
    },
    onProgress: () => undefined,
    ownerToken: "test-token-never-record",
    runId,
  };
}

test("authority is durable before child code and does not attest unenforced constraints", async (t) => {
  const dbPath = setup(t);
  const dir = makeTemporaryDir("authority-child-");
  const connectorPath = join(dir, "connector.mjs");
  const capturePath = join(dir, "capture.json");
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  writeFileSync(
    connectorPath,
    `
    import { createRequire } from 'node:module';
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const Database = createRequire(${JSON.stringify(packagePath)})('better-sqlite3');
    const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
    const row = db.prepare("SELECT data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.effective_authority'").get(${JSON.stringify(runId)});
    db.close();
    const before = row ? JSON.parse(row.data_json).effective_authority : null;
    createInterface({input: process.stdin}).once('line', line => {
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({before, start: JSON.parse(line)}));
      process.stdout.write(JSON.stringify({type:'DONE',status:'succeeded',records_emitted:0}) + '\\n');
      process.exit(0);
    });
  `
  );
  await runConnector(options(connectorPath));
  const captured = JSON.parse(readFileSync(capturePath, "utf8"));
  assert.ok(captured.before, "missing authority record before the connector's first possible egress");
  assert.equal(captured.before.run_id, runId);
  assert.equal(captured.before.connector_instance_id, "cin_authority");
  assert.equal(captured.before.instances.network.lifecycle, "granted");
  assert.equal(captured.before.instances.network.channels.hosts.coverage, "not_observable");
  assert.equal(captured.before.instances.network.effective_constraints, null);
  assert.ok(captured.before.policy.weaker_coverage.length > 0);
  assert.deepEqual(Object.keys(captured.before.instances).sort(), Object.keys(captured.start.bindings).sort());
  assert.equal(JSON.stringify(captured.before).includes("test-token-never-record"), false);
  const events = await listSpineEventsPage("run", runId, { limit: 100 });
  assert.equal(events.events.filter((e) => e.event_type === "run.effective_authority").length, 1);
  const event = events.events.find((e) => e.event_type === "run.effective_authority");
  const eventData = event?.data as Record<string, unknown>;
  assert.equal(eventData.connection_id, "cin_authority");
  assert.deepEqual(eventData.source, { id: connectorId, kind: "connector" });
});

test("cookie and owner bearer authority reads have identical durable bodies and separate guards", async (t) => {
  setup(t);
  const { mountRefRunEffectiveAuthority, mountOwnerRunEffectiveAuthority } = await import(
    "../server/routes/run-effective-authority.ts"
  );
  const { readRunEffectiveAuthority } = await import("../server/run-effective-authority-read-model.ts");
  const routes = new Map<string, unknown[]>();
  const app = {
    get(path: string, ...handlers: unknown[]) {
      routes.set(path, handlers);
      return app;
    },
  };
  const session = () => undefined;
  const token = () => undefined;
  const owner = () => undefined;
  const ctx = {
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    pdppError: (res: unknown, status: number, code: string) => {
      const response = res as {
        status: (value: number) => { json: (value: unknown) => unknown };
      };
      return response.status(status).json({ error: { code } });
    },
    readRunEffectiveAuthority,
    requireOwner: owner,
    requireOwnerSession: session,
    requireToken: token,
  };
  mountRefRunEffectiveAuthority(app, ctx);
  mountOwnerRunEffectiveAuthority(app, ctx);
  const invoke = async (path: string, id = runId) => {
    let body: unknown;
    let status = 200;
    const res = {
      json(value: unknown) {
        body = value;
      },
      status(value: number) {
        status = value;
        return res;
      },
    };
    const handlers = routes.get(path);
    assert.ok(handlers);
    const handler = handlers.at(-1) as (req: unknown, res: unknown) => Promise<unknown>;
    await handler({ params: { runId: id } }, res);
    return { body, status };
  };
  const cookiePath = "/_ref/runs/:runId/effective-authority";
  const bearerPath = "/v1/owner/runs/:runId/effective-authority";
  assert.deepEqual(routes.get(cookiePath)?.slice(0, -1), [session]);
  assert.deepEqual(routes.get(bearerPath)?.slice(0, -1), [token, owner]);
  assert.deepEqual(await invoke(cookiePath, "unknown"), {
    body: { error: { code: "not_found" } },
    status: 404,
  });
  const body = {
    instances: {},
    object: "effective_authority",
    policy: { id: "test-policy" },
    run_id: runId,
  };
  await emitSpineEvent({
    data: { effective_authority: body },
    event_type: "run.effective_authority",
    run_id: runId,
  });
  // Progress volume must not push authority outside a timeline page.
  await Promise.all(Array.from({ length: 25 }, () => emitSpineEvent({ event_type: "run.progress", run_id: runId })));
  assert.deepEqual(await invoke(cookiePath), { body, status: 200 });
  assert.deepEqual(await invoke(bearerPath), await invoke(cookiePath));
});

test("named instances preserve requested constraints and do not collapse grants by kind", async () => {
  const { buildEffectiveAuthorityRecord } = await import("../runtime/effective-authority.ts");
  const record = buildEffectiveAuthorityRecord({
    connectorId,
    connectorInstanceId: "cin_authority",
    effectiveBindings: {
      bank_site: { secret: "do-not-record" },
      report_site: {},
    },
    ownerSubjectId: "owner",
    requestedBindings: {
      bank_site: {
        constraints: { navigate: ["bank.example"] },
        kind: "browser",
        required: true,
      },
      optional_secret: { kind: "desktop_session" },
      report_site: {
        constraints: { connect: ["reports.example"] },
        kind: "browser",
      },
    },
    runId,
  });
  assert.equal(record.instances.bank_site?.kind, "browser");
  assert.equal(record.instances.bank_site?.lifecycle, "granted");
  assert.deepEqual(record.instances.bank_site?.requested_constraints, {
    navigate: ["bank.example"],
  });
  assert.equal(record.instances.bank_site?.effective_constraints, null);
  assert.equal(record.instances.bank_site?.effective_reach, "unconfined");
  assert.deepEqual(record.instances.report_site?.requested_constraints, {
    connect: ["reports.example"],
  });
  assert.equal(record.instances.optional_secret?.lifecycle, "optional_not_granted");
  assert.equal(record.instances.optional_secret?.effective_reach, "none");
  assert.equal(JSON.stringify(record).includes("do-not-record"), false);
  assert.equal(record.policy.weaker_coverage.length, 6);
});

test("missing required bindings leave a durable record and never spawn", async (t) => {
  setup(t);
  const dir = makeTemporaryDir("authority-denied-");
  const connectorPath = join(dir, "never-start.mjs");
  const marker = join(dir, "spawned");
  writeFileSync(
    connectorPath,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');`
  );
  await assert.rejects(
    runConnector({
      ...options(connectorPath),
      manifest: {
        ...options(connectorPath).manifest,
        runtime_requirements: {
          bindings: { desktop_session: { required: true } },
        },
      },
    }),
    REQUIRED_BINDING_ERROR
  );
  const { readRunEffectiveAuthority } = await import("../server/run-effective-authority-read-model.ts");
  const record = await readRunEffectiveAuthority(runId);
  const instances = record?.instances as Record<string, { lifecycle: string }>;
  assert.ok(instances.desktop_session);
  assert.equal(instances.desktop_session.lifecycle, "unsupported");
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
});

test("an unavailable durable store prevents connector spawn", async () => {
  closeDb();
  await assert.rejects(runConnector(options("does-not-exist.mjs")), PERSISTENCE_ERROR);
});

test("HTTP cookie login and owner bearer have identical authority bodies and reject anonymous reads", async (t) => {
  const { startServer } = await import("../server/index.ts");
  const { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } = await import("./fixtures/demo-clients.ts");
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "authority-test-password",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
  });
  t.after(async () => {
    server.schedulerManager?.stop();
    server.asServer.closeAllConnections?.();
    server.rsServer.closeAllConnections?.();
    await Promise.all([
      new Promise<void>((resolve) => server.asServer.close(() => resolve())),
      new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    ]);
    closeDb();
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const form = await fetch(`${asUrl}/owner/login`);
  const csrf = (await form.text()).match(CSRF_INPUT)?.[1];
  assert.ok(csrf);
  const pair = (resp: Response, name: string) =>
    resp.headers
      .getSetCookie()
      .find((h) => h.startsWith(`${name}=`))
      ?.split(";")[0];
  const login = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrf,
      password: "authority-test-password",
      return_to: "/",
    }),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: pair(form, "pdpp_owner_csrf") ?? "",
    },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(login.status, 302);
  const cookie = pair(login, "pdpp_owner_session");
  assert.ok(cookie);
  const post = (path: string, body: unknown, authenticated = false) =>
    fetch(`${asUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      method: "POST",
    });
  const deviceResp = await post("/oauth/device_authorization", {
    client_id: "cli_longview",
  });
  assert.equal(deviceResp.status, 200);
  const device = (await deviceResp.json()) as {
    user_code: string;
    device_code: string;
  };
  assert.equal((await post("/device/approve", { user_code: device.user_code }, true)).status, 200);
  const tokenResp = await post("/oauth/token", {
    client_id: "cli_longview",
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert.equal(tokenResp.status, 200);
  const token = (await tokenResp.json()) as { access_token: string };
  assert.ok(token.access_token);
  const storedBody = {
    instances: {},
    object: "effective_authority",
    run_id: runId,
    schema_version: 1,
  };
  await emitSpineEvent({
    data: { effective_authority: storedBody },
    event_type: "run.effective_authority",
    run_id: runId,
  });
  await emitSpineEvent({ event_type: "run.completed", run_id: runId });
  const cookieUrl = `${asUrl}/_ref/runs/${runId}/effective-authority`;
  const bearerUrl = `${rsUrl}/v1/owner/runs/${runId}/effective-authority`;
  assert.equal((await fetch(cookieUrl, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(bearerUrl)).status, 401);
  const ref = await fetch(cookieUrl, { headers: { Cookie: cookie } });
  const owner = await fetch(bearerUrl, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(ref.status, 200);
  assert.equal(owner.status, 200);
  assert.deepEqual(await ref.json(), storedBody);
  assert.deepEqual(await owner.json(), storedBody);
});

test("filesystem input alias and each output or secret item retain their own channel", async () => {
  const { buildEffectiveAuthorityRecord } = await import("../runtime/effective-authority.ts");
  const input = { access: "read", env_var: "IMPORT_DIR", kind: "dir" };
  const items = [
    { operations: ["read"], selector: "first", service: "os_keyring" },
    { operations: ["unwrap"], selector: "second", service: "os_keyring" },
  ];
  const record = buildEffectiveAuthorityRecord({
    connectorId,
    connectorInstanceId: "cin_authority",
    effectiveBindings: { filesystem: {} },
    ownerSubjectId: "owner",
    requestedBindings: {
      filesystem: {
        constraints: {
          outputs: [
            { access: "write", slot: "scratch" },
            { access: "write", slot: "reports" },
          ],
        },
        inputs: [input],
      },
      secret_items: { constraints: { items }, kind: "desktop_session" },
    },
    runId,
  });
  assert.deepEqual(record.instances.filesystem?.requested_constraints?.inputs, [input]);
  assert.ok(record.instances.filesystem?.channels["inputs.IMPORT_DIR"]);
  assert.ok(record.instances.filesystem?.channels["outputs.scratch"]);
  assert.ok(record.instances.filesystem?.channels["outputs.reports"]);
  assert.equal(Object.keys(record.instances.secret_items?.channels ?? {}).length, 2);
});

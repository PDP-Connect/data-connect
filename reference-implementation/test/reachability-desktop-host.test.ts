// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { respondToConsoleProof } from "../server/reachability/console-proof.ts";
import { startDesktopReachability } from "../server/reachability/desktop-host.ts";
import { createHostSecretBackend, createSealedSecretBackend } from "../server/reachability/secret-backend.ts";
import { closeTestServer } from "./helpers/close-test-server.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "./fixtures/demo-clients.ts";

async function scratch() {
  const parent = process.env.TEST_TMPDIR ?? join(homedir(), ".tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, "rhd-"));
}

test("desktop host accepts the owned console port only with the current parent lease and proof", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "unified");
  const env = {
    PDPP_DATA_DIR: dataDir,
    PDPP_MANAGED_DESKTOP_HOST: "1",
    PDPP_OWNER_CREDENTIAL_REVEAL_PROOF: randomBytes(32).toString("hex"),
    HOSTNAME: "127.0.0.1",
    PORT: "",
    PDPP_OWNER_PASSWORD: randomBytes(32).toString("hex"),
    PDPP_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let proveIdentity = true;
  const console = createServer((request, response) => {
    if (!proveIdentity) {
      response.writeHead(204).end();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
    const answer = respondToConsoleProof(new Request("http://127.0.0.1", { headers }));
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end();
  }).listen(0, "127.0.0.1");
  await once(console, "listening");
  t.after(() => console[Symbol.asyncDispose]());
  const address = console.address();
  assert.ok(address && typeof address === "object");
  process.env.PORT = String(address.port);
  const leases = join(root, "run");
  await Promise.all([mkdir(dataDir), mkdir(leases)]);
  const lease = { pid: process.ppid, owner_pid: process.pid, owner_started_at_ticks: 123, port: address.port };
  await writeFile(join(leases, "console.json"), JSON.stringify({ ...lease, label: "console" }));
  const reference = (pid: number) => writeFile(join(leases, "reference-implementation.json"), JSON.stringify({
    ...lease, pid, label: "reference-implementation",
  }));
  const input = { dataDir, bindHost: "127.0.0.1", owner: "owned-fixture", passwordConfigured: true };
  await reference(process.ppid + 1);
  assert.equal(await startDesktopReachability(input), undefined);
  await reference(process.ppid);
  assert.equal(await startDesktopReachability({ ...input, bindHost: "0.0.0.0" }), undefined);
  const host = await startDesktopReachability(input);
  assert.ok(host?.service);
  assert.equal(host.service.state().evidenceSource, null);
  assert.deepEqual(await host.service.hostSettings().then(value => value.known && value.value.target), {
    known: true, value: `127.0.0.1:${address.port}`,
  });
  assert.deepEqual(host.service.capabilities()["installer.execute"], { known: true, value: false });
  assert.deepEqual(host.service.capabilities()["secrets.backend"], { known: true, value: true });
  assert.deepEqual(host.usage("session"), { kind: "session", lifetimeMs: 3_600_000 });
  assert.deepEqual(host.usage("attached"), { kind: "attached" });
  assert.throws(() => host.usage("durable"), { code: "host_runtime_unavailable" });
  // Exercise the real startup path with no injected reachability service.
  const { startServer } = await import("../server/index.ts");
  const startup = await startServer({
    asPort: 0, rsPort: 0, dbPath: ":memory:", bindHost: "127.0.0.1", quiet: true,
    ownerAuthPassword: "",
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
  });
  try {
    const post = async (path: string, body: Record<string, string>) => (
      await fetch(`http://127.0.0.1:${startup.asPort}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })
    ).json() as Promise<Record<string, string>>;
    const device = await post("/oauth/device_authorization", { client_id: "cli_longview" });
    assert.ok(device.device_code && device.user_code);
    await fetch(`http://127.0.0.1:${startup.asPort}/device/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_code: device.user_code, subject_id: "owner_local" }),
    });
    const token = await post("/oauth/token", {
      client_id: "cli_longview", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code,
    });
    assert.ok(token.access_token);
    const endpoint = `http://127.0.0.1:${startup.rsPort}/v1/owner/reachability/host-settings`;
    assert.equal((await fetch(endpoint)).status, 401);
    const result = await fetch(endpoint, { headers: { Authorization: `Bearer ${token.access_token}` } });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json() as { data: { value: { target: unknown } } }).data.value.target,
      { known: true, value: `127.0.0.1:${address.port}` });
  } finally {
    await closeTestServer(startup);
  }
  proveIdentity = false;
  assert.equal(await host.service.hostSettings().then(value => value.known && value.value.target.known), false);
  host.service.closeObservers();
});

test("desktop custody seals bytes, scopes access and survives reopening with the same key", async (t) => {
  const root = await scratch();
  const key = randomBytes(32).toString("hex");
  const before = process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY;
  process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY = key;
  t.after(async () => {
    if (before === undefined) delete process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY = before;
    await rm(root, { recursive: true, force: true });
  });
  const bytes = randomBytes(32);
  const scopeId = "owner-scoped";
  const first = createHostSecretBackend(createSealedSecretBackend(root));
  const { handle } = await first.put({ scopeId, inputId: "input", revision: "revision", bytes });
  const [entry] = await readdir(root);
  assert.ok(entry);
  const encrypted = await readFile(join(root, entry));
  assert.ok(!encrypted.includes(bytes));
  assert.ok(!encrypted.includes(bytes.toString("base64")));
  const reopened = createHostSecretBackend(createSealedSecretBackend(root));
  const ref = { scopeId, handle };
  assert.deepEqual(await reopened.presence({ scopeId: "different", handle }), { known: true, value: false });
  assert.equal(await reopened.withSecret(ref, async value => Buffer.from(value).equals(bytes)), true);
  process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.deepEqual(await reopened.presence(ref), { known: false, reason: "secret_backend_locked" });
  await assert.rejects(reopened.delete(ref), { code: "secret_backend_locked" });
  process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY = key;
  assert.deepEqual(await reopened.delete(ref), { deleted: true });
  assert.deepEqual(await reopened.presence(ref), { known: true, value: false });
});

// The Linux launchers execve into the server, so the pid a lease names is the
// server's own pid and its parent is the app, not the launcher. The launcher
// records its pid in PDPP_LAUNCHER_PID before it execs; both servers key their
// identity checks on it instead of assuming the launcher is their parent.
test("desktop host accepts an exec'd launcher whose lease names the server's own pid", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "unified");
  const env = {
    PDPP_DATA_DIR: dataDir,
    PDPP_MANAGED_DESKTOP_HOST: "1",
    PDPP_OWNER_CREDENTIAL_REVEAL_PROOF: randomBytes(32).toString("hex"),
    PDPP_LAUNCHER_PID: String(process.pid),
    HOSTNAME: "127.0.0.1",
    PORT: "",
    PDPP_OWNER_PASSWORD: randomBytes(32).toString("hex"),
    PDPP_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const console = createServer((request, response) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
    const answer = respondToConsoleProof(new Request("http://127.0.0.1", { headers }));
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end();
  }).listen(0, "127.0.0.1");
  await once(console, "listening");
  t.after(() => console[Symbol.asyncDispose]());
  const address = console.address();
  assert.ok(address && typeof address === "object");
  process.env.PORT = String(address.port);
  const leases = join(root, "run");
  await Promise.all([mkdir(dataDir), mkdir(leases)]);
  const lease = { pid: process.pid, owner_pid: process.ppid, owner_started_at_ticks: 123, port: address.port };
  await writeFile(join(leases, "console.json"), JSON.stringify({ ...lease, label: "console" }));
  const reference = (pid: number) => writeFile(join(leases, "reference-implementation.json"), JSON.stringify({
    ...lease, pid, label: "reference-implementation",
  }));
  const input = { dataDir, bindHost: "127.0.0.1", owner: "owned-fixture", passwordConfigured: true };
  await reference(process.pid + 1);
  assert.equal(await startDesktopReachability(input), undefined);
  await reference(process.pid);
  const host = await startDesktopReachability(input);
  assert.ok(host?.service, "service starts when the lease names the exec'd server's own pid");
  t.after(() => host.service?.closeObservers());
  assert.deepEqual(await host.service.hostSettings().then(value => value.known && value.value.target), {
    known: true, value: `127.0.0.1:${address.port}`,
  });
});

test("desktop host reports loopback confinement once the service is created", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "unified");
  const env = {
    PDPP_DATA_DIR: dataDir,
    PDPP_MANAGED_DESKTOP_HOST: "1",
    PDPP_OWNER_CREDENTIAL_REVEAL_PROOF: randomBytes(32).toString("hex"),
    HOSTNAME: "127.0.0.1",
    PORT: "",
    PDPP_OWNER_PASSWORD: randomBytes(32).toString("hex"),
    PDPP_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const console = createServer((request, response) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
    const answer = respondToConsoleProof(new Request("http://127.0.0.1", { headers }));
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end();
  }).listen(0, "127.0.0.1");
  await once(console, "listening");
  t.after(() => console[Symbol.asyncDispose]());
  const address = console.address();
  assert.ok(address && typeof address === "object");
  process.env.PORT = String(address.port);
  const leases = join(root, "run");
  await Promise.all([mkdir(dataDir), mkdir(leases)]);
  const lease = { pid: process.ppid, owner_pid: process.pid, owner_started_at_ticks: 123, port: address.port };
  await writeFile(join(leases, "console.json"), JSON.stringify({ ...lease, label: "console" }));
  await writeFile(join(leases, "reference-implementation.json"), JSON.stringify({
    ...lease, pid: process.ppid, label: "reference-implementation",
  }));
  const host = await startDesktopReachability({ dataDir, bindHost: "127.0.0.1", owner: "owned-fixture", passwordConfigured: true });
  assert.ok(host?.service);
  t.after(() => host.service?.closeObservers());
  assert.deepEqual(host.service.state().lifecycle.confinement, { known: true, value: true });
});

test("desktop host repairs group- and other-writable state folders inside the data directory at start", async (t) => {
  const root = await scratch();
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "unified");
  const outside = join(root, "outside");
  const home = join(dataDir, "reachability");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o777 }),
    mkdir(outside, { recursive: true, mode: 0o777 }),
  ]);
  await chmod(home, 0o777);
  await chmod(outside, 0o777);

  const env = {
    PDPP_DATA_DIR: dataDir,
    PDPP_MANAGED_DESKTOP_HOST: "1",
    PDPP_OWNER_CREDENTIAL_REVEAL_PROOF: randomBytes(32).toString("hex"),
    HOSTNAME: "127.0.0.1",
    PORT: "",
    PDPP_OWNER_PASSWORD: randomBytes(32).toString("hex"),
    PDPP_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const leases = join(root, "run");
  await mkdir(leases, { recursive: true });
  const lease = { pid: process.ppid, owner_pid: process.pid, owner_started_at_ticks: 123, port: 12345 };
  await writeFile(join(leases, "console.json"), JSON.stringify({ ...lease, label: "console" }));
  await writeFile(join(leases, "reference-implementation.json"), JSON.stringify({
    ...lease, pid: process.ppid, label: "reference-implementation",
  }));

  const input = { dataDir, bindHost: "127.0.0.1", owner: "owned-fixture", passwordConfigured: true };
  const host = await startDesktopReachability(input);
  assert.ok(host?.statePaths);
  t.after(() => host.service?.closeObservers());

  const homeMode = (await lstat(home)).mode & 0o777;
  const outsideMode = (await lstat(outside)).mode & 0o777;

  assert.equal(homeMode & 0o022, 0, "state folder inside dataDir had group and other write bits stripped");
  assert.equal(outsideMode, 0o777, "folder outside dataDir is unchanged");

  const report = await host.statePaths.inspect();
  assert.deepEqual(report.paths, []);
});

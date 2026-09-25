// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance coverage for the owner autostart routes
 * (server/routes/owner-autostart.ts).
 *
 * These routes are the HTTP replacement for the two Tauri commands the
 * console used to call directly (get_autostart_enabled /
 * set_autostart_enabled, in src-tauri/src/commands/desktop_settings.rs) --
 * unreachable from the console's http://127.0.0.1:{port} window. Unlike
 * app-config, autostart is an imperative OS action only the Tauri/Rust
 * process can perform, so POST here hands off to a command/result bridge the
 * desktop app's spawn_autostart_watcher polls and applies -- these tests use
 * a fake AutostartStore rather than the real file-backed one, since
 * autostart-store.test.ts already covers that store's file-polling
 * contract directly.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAutostartStore, type AutostartState, type AutostartStore } from "../server/autostart-store.ts";
import { mountOwnerAutostart } from "../server/routes/owner-autostart.ts";

interface CapturedResponse {
  body: unknown;
  status: number;
}

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>;

class FakeApp {
  readonly routes = new Map<string, Handler>();

  private register(method: string, path: string, args: unknown[]): this {
    this.routes.set(`${method} ${path}`, args.at(-1) as Handler);
    return this;
  }

  get(path: string, ...args: unknown[]): this {
    return this.register("GET", path, args);
  }

  post(path: string, ...args: unknown[]): this {
    return this.register("POST", path, args);
  }
}

function makeRes(): { captured: CapturedResponse; res: unknown } {
  const captured: CapturedResponse = { body: undefined, status: 200 };
  const res = {
    json: (body: unknown) => {
      captured.body = body;
      return res;
    },
    status: (code: number) => {
      captured.status = code;
      return res;
    },
  };
  return { captured, res };
}

function fakeStore(initial: AutostartState): AutostartStore & { state: AutostartState } {
  const store = {
    load: async () => store.state,
    requestChange: async (desiredEnabled: boolean) => {
      store.state = {
        ...store.state,
        enabled: desiredEnabled,
        error: null,
        pending: false,
      };
      return store.state;
    },
    state: initial,
  };
  return store;
}

function mountWithStore(store: AutostartStore): FakeApp["routes"] {
  const app = new FakeApp();
  mountOwnerAutostart(app as unknown as Parameters<typeof mountOwnerAutostart>[0], {
    handleError: (res, err) => {
      (res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(500)
        .json({ error: { message: err instanceof Error ? err.message : String(err) } });
    },
    pdppError: (res, status, code, message) => {
      res.status(status).json({ error: { code, message } });
    },
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
    store,
  });
  return app.routes;
}

test("GET autostart projects only enabled/error/pending, not request bookkeeping", async () => {
  const routes = mountWithStore(
    fakeStore({ enabled: true, error: null, pending: false })
  );
  const handler = routes.get("GET /v1/owner/autostart");
  assert.ok(handler);
  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.deepEqual(captured.body, { data: { enabled: true, error: null, pending: false }, object: "autostart_state" });
});

test("GET autostart reports a requested change the desktop app has not applied yet as pending", async () => {
  const routes = mountWithStore(
    fakeStore({ enabled: false, error: null, pending: true })
  );
  const { captured, res } = makeRes();
  await routes.get("GET /v1/owner/autostart")?.({}, res);
  assert.deepEqual(captured.body, { data: { enabled: false, error: null, pending: true }, object: "autostart_state" });
});

test("GET autostart surfaces a load failure (desktop app not seeded yet) via handleError", async () => {
  const store: AutostartStore = {
    load: async () => {
      throw new Error("Autostart state is not available yet.");
    },
    requestChange: async () => {
      throw new Error("unused");
    },
  };
  const routes = mountWithStore(store);
  const handler = routes.get("GET /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({}, res);
  assert.equal(captured.status, 500);
});

test("POST autostart requests a change and returns the applied result", async () => {
  const routes = mountWithStore(
    fakeStore({ enabled: false, error: null, pending: false })
  );
  const handler = routes.get("POST /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({ body: { enabled: true } }, res);
  assert.deepEqual(captured.body, { data: { enabled: true, error: null, pending: false }, object: "autostart_state" });
});

test("POST autostart rejects a malformed body before it reaches the store", async () => {
  const routes = mountWithStore(
    fakeStore({ enabled: false, error: null, pending: false })
  );
  const handler = routes.get("POST /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({ body: { enabled: "yes" } }, res);
  assert.equal(captured.status, 400);
});

test("POST autostart returns a 409 when the watcher never applies the request within the timeout", async () => {
  const store: AutostartStore = {
    load: async () => ({ enabled: false, error: null, pending: false }),
    requestChange: async () => {
      throw new Error("Autostart change was not applied by the desktop app within 5s");
    },
  };
  const routes = mountWithStore(store);
  const handler = routes.get("POST /v1/owner/autostart");
  const { captured, res } = makeRes();
  await handler?.({ body: { enabled: true } }, res);
  assert.equal(captured.status, 409);
  assert.match(String((captured.body as { error: { message: string } }).error.message), /was not applied/);
});

test("POST autostart returns native failure as a 409", async () => {
  const routes = mountWithStore({
    load: async () => ({ enabled: false, error: null, pending: false }),
    requestChange: async () => { throw new Error("permission denied"); },
  });
  const response = makeRes();
  await routes.get("POST /v1/owner/autostart")?.({ body: { enabled: true } }, response.res);
  assert.equal(response.captured.status, 409);
  assert.deepEqual(response.captured.body, { error: { code: "autostart_not_applied", message: "permission denied" } });
});

test("concurrent POSTs return only their own public OS results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autostart-route-"));
  try {
    const routes = mountWithStore(createAutostartStore(dir, () => undefined, { pollIntervalMs: 5, timeoutMs: 500 }));
    const post = routes.get("POST /v1/owner/autostart")!;
    const yes = makeRes();
    const no = makeRes();
    const yesRequest = post({ body: { enabled: true } }, yes.res);
    const noRequest = post({ body: { enabled: false } }, no.res);
    const commandDir = join(dir, "autostart-commands");
    // Only match finalized command files: the store writes each command via
    // a `<name>.<uuid>.tmp` staging file that it atomically renames into
    // place, so a transient `.tmp` name can appear in the listing and vanish
    // by the time it is read. Matching the store's own filename shape (see
    // `autostart-store.ts`'s `ast_[A-Za-z0-9_-]{22}.json` pattern) excludes
    // those staging files instead of racing to read them.
    const commandFileName = /^ast_[A-Za-z0-9_-]{22}\.json$/;
    let commands: Array<{ commandId: string; desiredEnabled: boolean }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const names = (await readdir(commandDir).catch(() => [])).filter(name => commandFileName.test(name));
      if (names.length === 2) {
        commands = await Promise.all(names.map(async name => JSON.parse(await readFile(join(commandDir, name), "utf8"))));
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(commands.length, 2);
    const resultDir = join(dir, "autostart-results");
    await mkdir(resultDir);
    for (const command of commands) {
      await writeFile(join(resultDir, `${command.commandId}.json`), JSON.stringify({
        commandId: command.commandId, kind: "set_autostart_enabled", desiredEnabled: command.desiredEnabled,
        status: "succeeded", enabled: command.desiredEnabled, error: null,
      }));
    }
    await Promise.all([yesRequest, noRequest]);
    assert.deepEqual(yes.captured.body, { data: { enabled: true, error: null, pending: false }, object: "autostart_state" });
    assert.deepEqual(no.captured.body, { data: { enabled: false, error: null, pending: false }, object: "autostart_state" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

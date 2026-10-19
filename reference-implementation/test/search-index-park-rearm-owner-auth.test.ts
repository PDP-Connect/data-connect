// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerAuthPlaceholder } from "../server/owner-auth.ts";
import { mountRefConnectionSearchIndexControl } from "../server/routes/ref-connectors.ts";

interface TestResponse {
  body: unknown;
  json: (body: unknown) => this;
  redirect: (url: string) => void;
  send: (body: string) => this;
  setHeader: (name: string, value: string | string[]) => this;
  status: (code: number) => this;
  statusCode: number;
}

function response(): TestResponse {
  return {
    body: null,
    json(body) {
      this.body = body;
      return this;
    },
    redirect(url) {
      this.body = url;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    statusCode: 200,
  };
}

test("park and rearm routes reject an unauthenticated caller before mutation", async () => {
  const routes = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const app = {
    post(path: string, ...handlers: ((...args: unknown[]) => unknown)[]) {
      routes.set(path, handlers);
      return this;
    },
  };
  const auth = createOwnerAuthPlaceholder({
    allowUnauthenticatedWhenDisabled: false,
    password: null,
  });
  let mutations = 0;
  mountRefConnectionSearchIndexControl(
    app as never,
    {
      getOwnerSubjectId: () => "owner-1",
      handleError: (res: TestResponse, error: unknown) => {
        res.status(500).json({ error: String(error) });
      },
      parkSearchIndexDirtyScope: () => {
        mutations += 1;
        return true;
      },
      pdppError: (res: TestResponse, statusCode: number, code: string) => {
        res.status(statusCode).json({ error: { code } });
      },
      rearmSearchIndexDirtyScope: () => {
        mutations += 1;
        return true;
      },
      requireOwnerSession: auth.requireOwnerSession,
      resolveOwnerConnectorNamespace: () => ({
        connectorId: "owned-connector",
        connectorInstanceId: "cin-owned",
      }),
    } as never,
  );

  await Promise.all(
    (["park", "rearm"] as const).map(async (action) => {
      const path = `/_ref/connections/:connectorInstanceId/search-index/:stream/${action}`;
      const requestPath = `/_ref/connections/cin-owned/search-index/items/${action}`;
      const stack = routes.get(path);
      assert.ok(stack, `${action} route must be mounted`);
      const res = response();
      const req = {
        headers: { accept: "application/json" },
        method: "POST",
        originalUrl: requestPath,
        params: { connectorInstanceId: "cin-owned", stream: "items" },
        url: requestPath,
      };
      let nextCalled = false;
      const dispatch = async (index: number): Promise<void> => {
        const handler = stack[index];
        if (!handler) return;
        if (handler.length >= 3) {
          await (handler as (req: unknown, res: unknown, next: () => Promise<void>) => Promise<void>)(
            req,
            res,
            async () => {
              nextCalled = true;
              await dispatch(index + 1);
            },
          );
          return;
        }
        await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
      };
      await dispatch(0);
      assert.equal(res.statusCode, 401, `${action} must require an owner session`);
      assert.equal((res.body as { error?: { code?: string } }).error?.code, "owner_session_required");
      assert.equal(nextCalled, false, `${action} must not reach the route handler`);
    }),
  );
  assert.equal(mutations, 0, "neither unauthorized action may reach its store mutation");
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { mountRefAppAccess, type AppAccessRouteContext } from "../server/routes/ref-app-access.ts";
import type { AppAccess } from "../lib/app-access.ts";

function mount(apps: AppAccess[] = []) {
  const routes = new Map<string, unknown[]>();
  const gate = () => undefined;
  const errors: { status: number; code: string }[] = [];
  const ctx: AppAccessRouteContext = {
    requireOwnerSession: gate,
    ownerSubjectId: () => "owner",
    list: async () => apps,
    revokeGrant: async () => undefined,
    revokePackage: async () => undefined,
    getPackage: async () => null,
    applyRevokeSideEffects: async () => undefined,
    pdppError: (_res, status, code) => {
      errors.push({ status, code });
    },
    handleError: (_res, err) => {
      throw err;
    },
  };
  mountRefAppAccess(
    {
      get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
      post: (path, ...handlers) => routes.set(`POST ${path}`, handlers),
    },
    ctx,
  );
  return { routes, gate, errors, ctx };
}

type Handler = (
  req: { headers: Record<string, string>; body?: unknown },
  res: { json: (body: unknown) => unknown },
) => Promise<unknown>;

test("both app access routes use the existing owner session gate and complete list envelope", async () => {
  const { routes, gate } = mount();
  assert.equal(routes.get("GET /_ref/app-access")?.[0], gate);
  assert.equal(routes.get("POST /_ref/app-access/remove")?.[0], gate);
  const handler = routes.get("GET /_ref/app-access")?.[1] as Handler;
  let output: unknown;
  await handler(
    { headers: {} },
    {
      json: (body) => {
        output = body;
      },
    },
  );
  assert.deepEqual(output, { object: "list", data: [], has_more: false });
});

test("app removal rejects forged owner scope and malformed inputs before a write", async () => {
  const { routes, errors, ctx } = mount();
  let writes = 0;
  ctx.revokeGrant = async () => {
    writes += 1;
  };
  ctx.revokePackage = async () => {
    writes += 1;
  };
  const handler = routes.get("POST /_ref/app-access/remove")?.[1] as Handler;
  for (const body of [
    { client_ids: [] },
    { client_ids: ["other_owners_registration"] },
    { client_ids: ["app"], source: { id: "mail" } },
  ]) {
    await handler({ headers: {}, body }, { json: () => undefined });
  }
  assert.deepEqual(errors, [
    { status: 400, code: "invalid_request" },
    { status: 403, code: "permission_error" },
    { status: 400, code: "invalid_request" },
  ]);
  assert.equal(writes, 0);
});

test("removing a web-address app ends all selected ids and no neighbouring product", async () => {
  const make = (id: string, grant: string): AppAccess => ({
    client_id: id,
    client_name: "ChatGPT",
    domain_control_verified: true,
    reads_last_7_days: 0,
    return_host: "chatgpt.com",
    returns_to_this_computer: false,
    sources: [
      {
        active_grant_ids: [grant],
        expires_at: null,
        first_issued_at: "2026-01-01T00:00:00Z",
        grant_ids: [grant],
        in_force: true,
        kinds: ["messages"],
        last_read_at: null,
        package_ids: [],
        source: { connection_id: null, connector_id: "mail", id: "mail", kind: "connector" },
        stopped_at: null,
        stopped_reason: null,
      },
    ],
  });
  const ids = ["https://chatgpt.com/chat", "https://chatgpt.com/chat-v2"] as const;
  const { routes, ctx } = mount([
    make(ids[0], "chat1"),
    make(ids[1], "chat2"),
    make("https://chatgpt.com/codex", "codex"),
  ]);
  const ended: string[] = [];
  ctx.revokeGrant = (id) => {
    ended.push(id);
    return Promise.resolve();
  };
  const handler = routes.get("POST /_ref/app-access/remove")?.[1] as Handler;
  await handler({ body: { client_ids: ids }, headers: {} }, { json: () => undefined });
  assert.deepEqual(ended.sort(), ["chat1", "chat2"]);
});

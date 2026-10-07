// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { mountOwnerConnectionResetState } from "../server/routes/owner-connection-reset-state.ts";
import { mountRefConnectionResetState } from "../server/routes/ref-connectors.ts";

test("owner reset-state route delegates an allowed reset", async () => {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const app = {
    post(_path: string, ...args: unknown[]) {
      handler = args.at(-1) as typeof handler;
      return this;
    },
  };
  let resetInput: unknown;
  let body: unknown;
  let statusCode = 0;
  mountOwnerConnectionResetState(app as never, {
    getOwnerSubjectId: () => "owner-1",
    handleError: (_res: unknown, error: unknown) => assert.fail(String(error)),
    pdppError: () => assert.fail("unexpected validation error"),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    resetConnectionState: async (input) => {
      resetInput = input;
      return { run_id: "run-reset-1" };
    },
  });
  assert.ok(handler);
  await handler(
    { params: { connectorInstanceId: "source-1" } },
    {
      json(value: unknown) {
        body = value;
        return this;
      },
      status(code: number) {
        statusCode = code;
        return this;
      },
    }
  );
  assert.deepEqual(resetInput, { connectorInstanceId: "source-1", ownerSubjectId: "owner-1" });
  assert.equal(statusCode, 202);
  assert.deepEqual(body, {
    connection_id: "source-1",
    object: "owner_connection_state_reset",
    reset: true,
    run_id: "run-reset-1",
  });
});

test("owner reset-state route preserves the active-run refusal", async () => {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const app = {
    post(_path: string, ...args: unknown[]) {
      handler = args.at(-1) as typeof handler;
      return this;
    },
  };
  let seen: unknown;
  mountOwnerConnectionResetState(app as never, {
    getOwnerSubjectId: () => "owner-1",
    handleError: (_res, error) => {
      seen = error;
    },
    pdppError: () => assert.fail("unexpected validation error"),
    requireOwner: () => undefined,
    requireToken: () => undefined,
    resetConnectionState: async () => {
      throw Object.assign(new Error("Connector already has an active run."), {
        code: "run_already_active",
        runId: "run-7",
      });
    },
  });
  assert.ok(handler);
  await handler(
    { params: { connectorInstanceId: "source-1" } },
    {
      json() {
        return this;
      },
      status() {
        return this;
      },
    }
  );
  assert.equal((seen as { code: string }).code, "run_already_active");
  assert.equal((seen as { runId: string }).runId, "run-7");
});

test("owner-session reset-state route resolves the connection and clears its state", async () => {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const app = {
    post(_path: string, ...args: unknown[]) {
      handler = args.at(-1) as typeof handler;
      return this;
    },
  };
  let resetInput: unknown;
  let body: unknown;
  let statusCode = 0;
  mountRefConnectionResetState(
    app as never,
    {
      getOwnerSubjectId: () => "owner-1",
      handleError: (_res: unknown, error: unknown) => assert.fail(String(error)),
      requireOwnerSession: () => undefined,
      resetConnectionState: async (input: unknown) => {
        resetInput = input;
        return { run_id: "run-reset-2" };
      },
      resolveOwnerConnectorNamespace: async (
        _req: unknown,
        _connectorId: unknown,
        options: { connectorInstanceId: string }
      ) => ({
        connectorId: "github",
        connectorInstanceId: options.connectorInstanceId,
      }),
    } as never
  );
  assert.ok(handler);
  await handler(
    { params: { connectorInstanceId: "source-1" } },
    {
      json(value: unknown) {
        body = value;
        return this;
      },
      status(code: number) {
        statusCode = code;
        return this;
      },
    }
  );
  assert.deepEqual(resetInput, { connectorInstanceId: "source-1", ownerSubjectId: "owner-1" });
  assert.equal(statusCode, 202);
  assert.deepEqual(body, {
    connection_id: "source-1",
    connector_id: "github",
    object: "ref_connection_state_reset",
    reset: true,
    run_id: "run-reset-2",
  });
});

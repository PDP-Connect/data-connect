// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLocalOwnerCredentialRevealProof,
  localOwnerCredentialRevealProofHeader,
  mountOwnerCredentialReveal,
} from "./owner-credential-reveal.ts";

type Handler = (req: { headers?: Record<string, string> }, res: TestResponse, next?: () => void) => unknown;

interface TestResponse {
  body: unknown;
  code: number;
  json: (body: unknown) => TestResponse;
  status: (code: number) => TestResponse;
}

function response(): TestResponse {
  return {
    body: null,
    code: 200,
    json(body: unknown) {
      this.body = body;
      return this;
    },
    status(code: number) {
      this.code = code;
      return this;
    },
  };
}

function mountedRoute(
  isEligibleForReveal: (req: {
    headers?: Record<string, string | string[] | undefined>
  }) => boolean
) {
  const handlers: unknown[] = [];
  const app = {
    get(_path: string, ...args: unknown[]) {
      handlers.push(...args.filter((arg) => typeof arg === "function"));
      return this;
    },
  };
  mountOwnerCredentialReveal(app as unknown as Parameters<typeof mountOwnerCredentialReveal>[0], {
    handleError: (_res, err) => {
      throw err;
    },
    isEligibleForReveal,
    readOwnerPassword: () => "desktop-generated-password",
    requireOwner: (...args: unknown[]) => (args[2] as (() => void) | undefined)?.(),
    requireToken: (...args: unknown[]) => (args[2] as (() => void) | undefined)?.(),
  });
  return handlers as Handler[];
}

async function run(handlers: Handler[], req: { headers?: Record<string, string> }) {
  const res = response();
  for (const handler of handlers) {
    await handler(req, res, () => undefined);
  }
  return res;
}

test("desktop local reveal returns the generated owner password", async () => {
  const handlers = mountedRoute((req) => hasLocalOwnerCredentialRevealProof(req, "local-proof"));

  const res = await run(handlers, { headers: localOwnerCredentialRevealProofHeader("local-proof") });

  assert.equal(res.code, 200);
  assert.deepEqual(res.body, {
    data: { password: "desktop-generated-password" },
    object: "owner_credential_reveal",
  });
});

test("desktop tunnel or LAN reveal returns 404 without the local marker", async () => {
  const handlers = mountedRoute((req) => hasLocalOwnerCredentialRevealProof(req, "local-proof"));

  const res = await run(handlers, { headers: {} });

  assert.equal(res.code, 404);
  assert.match(JSON.stringify(res.body), /owner_credential_reveal_unavailable/);
});

test("desktop tunnel or LAN reveal returns 404 with a forged proof marker", async () => {
  const handlers = mountedRoute((req) => hasLocalOwnerCredentialRevealProof(req, "local-proof"));

  const res = await run(handlers, { headers: localOwnerCredentialRevealProofHeader("forged-proof") });

  assert.equal(res.code, 404);
  assert.match(JSON.stringify(res.body), /owner_credential_reveal_unavailable/);
});

test("server deployment reveal returns 404 even with the local marker", async () => {
  const handlers = mountedRoute(() => false);

  const res = await run(handlers, { headers: localOwnerCredentialRevealProofHeader("local-proof") });

  assert.equal(res.code, 404);
  assert.match(JSON.stringify(res.body), /owner_credential_reveal_unavailable/);
});

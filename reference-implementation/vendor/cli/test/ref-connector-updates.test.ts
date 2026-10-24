// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/index.ts";

const PLAN_ID = /plan-1/;
const SECRET = /do-not-print-this/;
const UUID = /^[0-9a-f-]{36}$/i;
const EXACTLY_ONE = /exactly one/;

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
    },
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}

function response(body: unknown) {
  return {
    headers: { get: () => null },
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(body),
  };
}

test("ref connectors updates plan uses owner bearer and creates a plan", async () => {
  const original = process.env.PDPP_OWNER_TOKEN;
  process.env.PDPP_OWNER_TOKEN = "do-not-print-this";
  let requestedUrl = "";
  let authorization = "";
  let method = "";
  try {
    const captured = capture();
    await runCli(
      ["ref", "connectors", "updates", "plan", "--as-url", "https://ref.test"],
      captured.io as never,
      ((url, init = {}) => {
        requestedUrl = String(url);
        authorization = (init.headers as Record<string, string>).Authorization;
        method = init.method || "";
        return response({ data: { items: [], plan_id: "plan-1", state: "checking" } });
      }) as typeof fetch
    );
    assert.equal(requestedUrl, "https://ref.test/v1/owner/connector-updates/plans");
    assert.equal(method, "POST");
    assert.equal(authorization, "Bearer do-not-print-this");
    assert.match(captured.stdout, PLAN_ID);
    assert.doesNotMatch(captured.stdout + captured.stderr, SECRET);
  } finally {
    if (original === undefined) {
      delete process.env.PDPP_OWNER_TOKEN;
    } else {
      process.env.PDPP_OWNER_TOKEN = original;
    }
  }
});

test("ref connectors updates apply sends plan, generated idempotency key, and selected ids", async () => {
  const original = process.env.PDPP_OWNER_TOKEN;
  process.env.PDPP_OWNER_TOKEN = "token";
  let body: Record<string, unknown> | null = null;
  try {
    await runCli(
      [
        "ref",
        "connectors",
        "updates",
        "apply",
        "plan/1",
        "--connector-id",
        "gmail,slack",
        "--as-url",
        "https://ref.test",
      ],
      capture().io as never,
      ((_url, init = {}) => {
        body = JSON.parse(String(init.body));
        return response({ data: { batch_id: "batch-1", items: [], state: "queued" } });
      }) as typeof fetch
    );
    assert.deepEqual(body?.plan_id, "plan/1");
    assert.match(String(body?.idempotency_key), UUID);
    assert.deepEqual(body?.selected_connector_ids, ["gmail", "slack"]);
  } finally {
    if (original === undefined) {
      delete process.env.PDPP_OWNER_TOKEN;
    } else {
      process.env.PDPP_OWNER_TOKEN = original;
    }
  }
});

test("ref connectors updates review confirms an exact digest and apply carries its consent", async () => {
  const original = process.env.PDPP_OWNER_TOKEN;
  process.env.PDPP_OWNER_TOKEN = "token";
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  try {
    const fetcher = ((url: string, init: RequestInit = {}) => {
      requests.push({ body: JSON.parse(String(init.body)), url: String(url) });
      return response({ data: { consent_token: "consent-1" } });
    }) as typeof fetch;
    await runCli([
      "ref", "connectors", "updates", "review", "plan/1", "--connector-id", "slack",
      "--target-digest", `sha256:${"a".repeat(64)}`, "--as-url", "https://ref.test",
    ], capture().io as never, fetcher);
    await runCli([
      "ref", "connectors", "updates", "apply", "plan/1", "--connector-id", "slack",
      "--consent-token", "consent-1", "--as-url", "https://ref.test",
    ], capture().io as never, fetcher);
    assert.equal(requests[0]?.url, "https://ref.test/v1/owner/connector-updates/plans/plan%2F1/consents");
    assert.deepEqual(requests[0]?.body, { connector_id: "slack", target_digest: `sha256:${"a".repeat(64)}` });
    assert.equal(requests[1]?.body.consent_token, "consent-1");
    assert.deepEqual(requests[1]?.body.selected_connector_ids, ["slack"]);
  } finally {
    if (original === undefined) {
      delete process.env.PDPP_OWNER_TOKEN;
    } else {
      process.env.PDPP_OWNER_TOKEN = original;
    }
  }
});

test("ref connectors updates status reads the requested plan or batch", async () => {
  const original = process.env.PDPP_OWNER_TOKEN;
  process.env.PDPP_OWNER_TOKEN = "token";
  const urls: string[] = [];
  try {
    await Promise.all(
      ["--plan-id", "--batch-id"].map(async (idFlag) => {
        await runCli(
          ["ref", "connectors", "updates", "status", idFlag, "job/1", "--as-url", "https://ref.test"],
          capture().io as never,
          ((url) => {
            urls.push(String(url));
            return response({ data: {} });
          }) as typeof fetch
        );
      })
    );
    assert.deepEqual(
      urls.sort(),
      [
        "https://ref.test/v1/owner/connector-updates/plans/job%2F1",
        "https://ref.test/v1/owner/connector-updates/batches/job%2F1",
      ].sort()
    );
  } finally {
    if (original === undefined) {
      delete process.env.PDPP_OWNER_TOKEN;
    } else {
      process.env.PDPP_OWNER_TOKEN = original;
    }
  }
});

test("ref connectors updates status requires exactly one job id", async () => {
  const captured = capture();
  assert.equal(await runCli(["ref", "connectors", "updates", "status"], captured.io as never), 2);
  assert.match(captured.stderr, EXACTLY_ONE);
});

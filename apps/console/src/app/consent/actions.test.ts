// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mock, test } from "node:test";

const asUrl = "http://as.test";

mock.module(new URL("../(console)/lib/owner-token.ts", import.meta.url).href, {
  namedExports: {
    getAsInternalUrl: () => asUrl,
    withOwnerSessionCookie: async (init: RequestInit) => init,
  },
});
mock.module(new URL("../(console)/lib/verify-session.ts", import.meta.url).href, {
  namedExports: { verifyDashboardSession: async () => {} },
});

const loadActions = () => import("./actions.ts");

function apiResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), { status });
}

test("the server's own owner-facing sentence is shown, not replaced by the code's copy", async () => {
  // Brief consent-repair 2: the server sends its reason to the owner as an
  // invalid_request sentence (hosted-mcp-grant-expiry.ts, as-authorize.ts
  // renderHostedMcpPickerValidationPage); that reason must reach the screen.
  const { rejectConsentChallenge } = await loadActions();
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    apiResponse({ error: "invalid_request", error_description: "Choose an end date in the future." })
  );
  try {
    assert.deepEqual(await rejectConsentChallenge("challenge"), {
      ok: false,
      message: "Choose an end date in the future.",
    });
  } finally {
    fetchMock.mock.restore();
  }
});

test("a known OAuth code with a terse server description returns plain owner-facing copy", async () => {
  const { rejectConsentChallenge } = await loadActions();
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    apiResponse({ error: "not_found", error_description: "Unknown or expired consent challenge" }, 404)
  );
  try {
    assert.deepEqual(await rejectConsentChallenge("challenge"), {
      ok: false,
      message: "This request is no longer available. Nothing was shared.",
    });
  } finally {
    fetchMock.mock.restore();
  }
});

test("an unknown code uses the server description, never a stack", async () => {
  const { rejectConsentChallenge } = await loadActions();
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    apiResponse({ error: "stale_review", error_description: "Your data sources changed. Review them and try again." })
  );
  try {
    assert.deepEqual(await rejectConsentChallenge("challenge"), {
      ok: false,
      message: "Your data sources changed. Review them and try again.",
    });
  } finally {
    fetchMock.mock.restore();
  }
});

test("an error description containing a stack is replaced with safe copy", async () => {
  const { rejectConsentChallenge } = await loadActions();
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    apiResponse({ error: "internal_error", error_description: "Error: private\n    at secret (/srv/app.js:1:2)" })
  );
  try {
    const result = await rejectConsentChallenge("challenge");
    assert.deepEqual(result, {
      ok: false,
      message: "This request could not be completed. Nothing was shared.",
    });
    assert.doesNotMatch(JSON.stringify(result), /private|secret|srv\/app/);
  } finally {
    fetchMock.mock.restore();
  }
});

test("malformed error fields cannot bypass the fallback", async () => {
  const { rejectConsentChallenge } = await loadActions();
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    apiResponse({ error: "constructor", error_description: 27 })
  );
  try {
    assert.deepEqual(await rejectConsentChallenge("challenge"), {
      ok: false,
      message: "This request could not be completed. Nothing was shared.",
    });
  } finally {
    fetchMock.mock.restore();
  }
});

test("a successful rejection returns the redirect in the result contract", async () => {
  const { rejectConsentChallenge } = await loadActions();
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ redirect_url: "https://app.example/return" }), { status: 200 })
  );
  try {
    assert.deepEqual(await rejectConsentChallenge("challenge"), {
      ok: true,
      redirectUrl: "https://app.example/return",
    });
  } finally {
    fetchMock.mock.restore();
  }
});

for (const [label, description] of [
  ["a raw exception message", "Cannot read properties of undefined (reading 'streams')"],
  ["a database error with an internal code", 'duplicate key value violates unique constraint "grants_pkey"'],
  ["a sentence carrying a URL with a secret", "Return to https://app.example/cb?code=abc123&state=s3cret to finish."],
  ["a sentence naming an internal code", "The request failed with consent_challenge_mismatch."],
]) {
  test(`${label} never reaches the screen`, async () => {
    const { rejectConsentChallenge } = await loadActions();
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      apiResponse({ error: "invalid_request", error_description: description })
    );
    try {
      assert.deepEqual(await rejectConsentChallenge("challenge"), {
        ok: false,
        message: "This request is no longer valid. Nothing was shared.",
      });
    } finally {
      fetchMock.mock.restore();
    }
  });
}

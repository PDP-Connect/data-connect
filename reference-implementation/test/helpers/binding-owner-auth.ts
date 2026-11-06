// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

const OWNER_CLIENT_ID = "cli_longview";
const OWNER_SUBJECT_ID = "owner_local";
async function fetchJson(url: string, options: RequestInit, expectedStatus = 200): Promise<{ body: unknown }> {
  const response = await fetch(url, options);
  assert.equal(response.status, expectedStatus, `fixture authentication step failed: ${new URL(url).pathname}`);
  return { body: await response.json() };
}

export async function issueOwnerToken(asUrl: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { user_code: string; device_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = (
    await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: OWNER_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { access_token?: string };
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return tok.access_token;
}

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind:
// "client"). These must NOT reach the owner-agent control surface.
export async function approveClientGrant(
  asUrl: string,
  sourceId: string,
  streamName: string,
  instanceId: string
): Promise<string> {
  const par = (
    await fetchJson(
      `${asUrl}/oauth/par`,
      {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/analytics",
              purpose_description: "owner-connection diagnostics boundary test",
              source: { id: sourceId, kind: "connector" },
              streams: [{ fields: ["id"], instance_ids: [instanceId], name: streamName }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
      201
    )
  ).body as { request_uri?: string };
  assert.ok(par.request_uri);
  const review = (
    await fetchJson(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { approval_review?: object; approval_review_revision?: string; request_uri?: string };
  assert.ok(review.approval_review);
  assert.ok(review.approval_review_revision);
  assert.equal(review.request_uri, par.request_uri);
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.approval_review_revision,
        request_uri: review.request_uri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token;
}

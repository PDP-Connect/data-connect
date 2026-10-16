// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the authorization-server vectors of the experimental client range
// filters profile (spec-client-range-filters.md Section 11.1) against a real
// reference server. The resource-server vectors run in
// client-range-filters-rs.test.ts.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { CLIENT_RANGE_FILTERS_PROFILE_URI } from "../server/client-range-filters.ts";
import { createHostedMcpGrantPackage } from "../server/auth.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import {
  fetchJson,
  type Fixture,
  type JsonObject,
  loadVectors,
  manifestFor,
  materializeConnection,
  registerManifest,
  SOURCE_ID,
  type Step,
  startWorld,
  type Vector,
  type World,
} from "./helpers/client-range-filters-harness.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";

const { file } = loadVectors();
const REDIRECT = "https://client.example/callback";
let world: World;
let clientId: string;
let manifestVersion = 0;

interface AuthorizationOutcome {
  // The client-visible grant: the granted authorization detail.
  grant?: JsonObject | undefined;
  refreshToken?: string | undefined;
  accessToken?: string | undefined;
  failure?: { code: string };
}

function isAsVector(vector: Vector): boolean {
  return vector.id.startsWith("as-");
}

class AsRun {
  readonly vector: Vector;
  readonly instanceId: string;

  constructor(vector: Vector, ordinal: number) {
    this.vector = vector;
    this.instanceId = `inst_as${ordinal}`;
  }

  get fixture(): Fixture {
    return file.fixtures[this.vector.fixture as string] as Fixture;
  }

  rename<T>(value: T): T {
    return JSON.parse(JSON.stringify(value).replaceAll("inst_a", this.instanceId)) as T;
  }

  async activate(declaration: JsonObject): Promise<void> {
    manifestVersion += 1;
    await registerManifest(world, manifestFor(declaration, `crf-as.v${manifestVersion}`));
  }

  // The vectors name their source https://example.test/source and give dates
  // where the vendored Core schema wants date-time. Same facts, adapted form.
  adaptDetails(details: JsonObject[]): JsonObject[] {
    return this.rename(details).map((detail) => ({
      ...detail,
      source: { id: SOURCE_ID, kind: "connector" },
      ...(detail.streams
        ? {
            streams: (detail.streams as JsonObject[]).map((stream) => ({
              ...stream,
              ...(stream.time_range
                ? {
                    time_range: Object.fromEntries(
                      Object.entries(stream.time_range as Record<string, string>).map(([key, value]) => [
                        key,
                        /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
                      ])
                    ),
                  }
                : {}),
            })),
          }
        : {}),
    }));
  }

  // Authorization-code flow with PKCE. `between` runs after the request is
  // retained and before the owner approves, where a vector changes the
  // current declaration.
  async authorize(details: JsonObject[], between?: () => Promise<void>): Promise<AuthorizationOutcome> {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${world.asUrl}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", REDIRECT);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", "crf");
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("authorization_details", JSON.stringify(details));
    const authorize = await fetch(url, { redirect: "manual" });
    if (authorize.status !== 302) {
      const body = (await authorize.json()) as { error?: { code?: string } | string };
      const code = typeof body.error === "string" ? body.error : body.error?.code;
      return { failure: { code: code ?? `http_${authorize.status}` } };
    }
    const consent = new URL(authorize.headers.get("location") as string, world.asUrl);
    const redirected = consent.searchParams.get("error");
    if (redirected) {
      return { failure: { code: redirected } };
    }
    const requestUri = consent.searchParams.get("request_uri") as string;
    await between?.();
    const review = await fetchJson(`${world.asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: requestUri, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const approved = await fetch(`${world.asUrl}/consent/approve`, {
      body: new URLSearchParams({
        approval_review_revision: review.body.approval_review_revision,
        request_uri: requestUri,
      }).toString(),
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approved.status, 302, await approved.clone().text());
    const callback = new URL(approved.headers.get("location") as string);
    const token = await fetchJson(`${world.asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code: callback.searchParams.get("code") as string,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    return {
      accessToken: token.body.access_token,
      grant: token.body.authorization_details?.[0],
      refreshToken: token.body.refresh_token,
    };
  }

  async refresh(refreshToken: string): Promise<JsonObject | undefined> {
    const response = await fetchJson(`${world.asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.authorization_details?.[0];
  }

  async introspect(accessToken: string): Promise<JsonObject | undefined> {
    const response = await fetchJson(`${world.asUrl}/introspect`, {
      body: JSON.stringify({ token: accessToken }),
      headers: introspectionHeaders(),
      method: "POST",
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.authorization_details?.[0];
  }

  // The owner-selected path grants what the owner picks and freezes no set.
  async issueOwnerSelected(): Promise<AuthorizationOutcome> {
    const [stream] = this.rename(this.fixture.grant).streams as JsonObject[];
    const result = await createHostedMcpGrantPackage({
      authorizationDetails: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/analytics",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ fields: stream?.fields, instance_ids: stream?.instance_ids, name: stream?.name }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      clientId,
      connectionIds: [this.instanceId],
      storageBindings: [{ connector_id: "spotify" }],
    });
    const [child] = result.child_grants as Array<{ grant: JsonObject }>;
    return { grant: child?.grant };
  }

  check(expected: NonNullable<Step["expected"]>, outcome: AuthorizationOutcome | undefined, where: string): void {
    if (expected.error !== undefined) {
      assert.equal(outcome?.failure?.code, expected.error, `${where}: error code`);
      return;
    }
    assert.equal(outcome?.failure, undefined, `${where}: ${JSON.stringify(outcome?.failure)}`);
    if (expected.grant_member) {
      const member = expected.grant_member.path.reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        outcome?.grant
      );
      if (expected.grant_member.absent) {
        assert.equal(member, undefined, `${where}: grant member must be absent`);
      } else {
        assert.deepEqual(member, expected.grant_member.value, `${where}: grant member`);
      }
    }
  }

  // Each vector's connection stays out of the next vector's wildcard
  // resolution, which counts every active connection of the source.
  async run(): Promise<void> {
    try {
      await this.execute();
    } finally {
      await createSqliteConnectorInstanceStore().updateStatus(this.instanceId, {
        revokedAt: new Date().toISOString(),
        status: "revoked",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async execute(): Promise<void> {
    const { vector } = this;
    if (vector.id === "as-advertises-profile") {
      const metadata = await fetchJson(`${world.asUrl}/.well-known/oauth-authorization-server`);
      assert.deepEqual(metadata.body.pdpp_client_range_filters_supported, [CLIENT_RANGE_FILTERS_PROFILE_URI]);
      return;
    }
    await this.activate(this.fixture.retained_declaration);
    await materializeConnection(this.instanceId);
    const request = vector.request;
    if (request?.operation === "issue_owner_selected_grant") {
      this.check(vector.expected as NonNullable<Vector["expected"]>, await this.issueOwnerSelected(), vector.id);
      return;
    }
    const details = this.adaptDetails((request?.body as JsonObject).authorization_details as JsonObject[]);
    // A vector that moves the declaration before issuance does so between
    // retaining the consent snapshot and approval.
    const moveBeforeIssuance = (vector.setup ?? []).some((step) => step.operation === "activate_declaration");
    const outcome = await this.authorize(
      details,
      moveBeforeIssuance ? () => this.activate(this.fixture.current_declaration as JsonObject) : undefined
    );
    this.check(vector.expected as NonNullable<Vector["expected"]>, outcome, vector.id);
    for (const step of vector.follow_up ?? []) {
      if (step.operation === "activate_declaration") {
        await this.activate(this.fixture.current_declaration as JsonObject);
        continue;
      }
      const path = step.request?.path;
      let delivered: JsonObject | undefined;
      if (path === "$token_endpoint") {
        delivered = await this.refresh(outcome.refreshToken as string);
      } else if (path === "$introspection_endpoint") {
        delivered = await this.introspect(outcome.accessToken as string);
      } else {
        assert.fail(`${vector.id}: unsupported follow-up ${path}`);
      }
      const expected = step.expected as NonNullable<Step["expected"]>;
      this.check(expected, { grant: delivered }, `${vector.id} ${path}`);
      if ((expected as { equals_capture?: string }).equals_capture === "issued_grant") {
        assert.deepEqual(
          delivered?.extensions,
          outcome.grant?.extensions,
          `${vector.id} ${path}: delivered member equals the issued member`
        );
      }
    }
  }
}

test.before(async () => {
  world = await startWorld();
  const registration = await fetchJson(`${world.asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "Client range filter vectors",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: {
      Authorization: "Bearer pdpp-reference-test-initial-access-token",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  assert.equal(registration.status, 201, JSON.stringify(registration.body));
  clientId = registration.body.client_id;
});

test.after(async () => {
  await world.close();
});

for (const [ordinal, vector] of file.vectors.filter(isAsVector).entries()) {
  test(`vector ${vector.id} (${vector.requirements.join(", ")})`, async () => {
    await new AsRun(vector, ordinal).run();
  });
}

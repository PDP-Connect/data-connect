// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared setup for the auth kill-boundary tests (test/auth-kill-boundaries.test.ts).
 *
 * The parent test and the crash child (test/fixtures/crash/auth-kill-child.ts)
 * open the SAME real storage through this module: a SQLite file, or a private
 * Postgres database. Storage is described by `StorageSpec`, which crosses the
 * process boundary as JSON in a child argument.
 *
 * Seeding is done in the parent with the production lifecycle functions
 * (registerConnector, initiateGrant, approveGrant, createHostedMcpGrantPackage,
 * ...). The child then does ONE piece of real auth work and is killed at a
 * named crash point. The parent reopens storage and asserts.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  approveGrant,
  createHostedMcpGrantPackage,
  getPendingConsent,
  initiateGrant,
  introspect,
  parsePendingConsentRequestUri,
  registerConnector,
  seedPreRegisteredClients,
  stageOAuthAuthorizationCodeRequest,
} from "../../server/auth.ts";
import { closeDb, getDb, initDb } from "../../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../../server/stores/connector-instance-store.ts";

export type Backend = "postgres" | "sqlite";

export interface StorageSpec {
  readonly backend: Backend;
  readonly pgUrl?: string;
  readonly sqlitePath: string;
}

export const OAUTH_CLIENT_ID = "auth_kill_oauth_client";
export const OAUTH_REDIRECT_URI = "https://client.example/callback";
const CONSENT_CLIENT_ID = "auth_kill_consent_client";

export async function openStorage(spec: StorageSpec): Promise<void> {
  if (spec.backend === "postgres") {
    // The SQLite handle is only a stand-in for helpers that always touch SQLite;
    // every auth read and write routes to Postgres.
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: spec.pgUrl as string,
    });
    return;
  }
  initDb(spec.sqlitePath);
}

export async function closeStorage(spec: StorageSpec): Promise<void> {
  if (spec.backend === "postgres") {
    await closePostgresStorage();
  }
  closeDb();
}

/** One row query that works on both backends (`?` placeholders, as in SQLite). */
export async function rows<T extends Record<string, unknown>>(
  spec: StorageSpec,
  sqliteSql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (spec.backend === "postgres") {
    let index = 0;
    const pgSql = sqliteSql.replace(/\?/g, () => `$${++index}`);
    return (await postgresQuery<T>(pgSql, params)).rows;
  }
  return getDb()
    .prepare(sqliteSql)
    .all(...params) as T[];
}

export async function count(spec: StorageSpec, sqliteSql: string, params: unknown[] = []): Promise<number> {
  const result = await rows<{ n: number | string }>(spec, sqliteSql, params);
  return Number(result[0]?.n ?? 0);
}

function loadSpotifyManifest(): { connector_id: string } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/seed-manifests/spotify.json"), "utf8"));
}

async function seedInstance(spec: StorageSpec, connectorInstanceId: string): Promise<void> {
  const now = new Date().toISOString();
  const store =
    spec.backend === "postgres" ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId: "spotify",
    connectorInstanceId,
    createdAt: now,
    displayName: connectorInstanceId,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

/** Register the connector and two clients (a consent client and a refresh-capable OAuth client). */
export async function seedBase(): Promise<void> {
  await registerConnector(loadSpotifyManifest());
  await seedPreRegisteredClients([
    {
      client_id: CONSENT_CLIENT_ID,
      client_name: "Auth kill consent client",
      registration_mode: "pre_registered_public",
    },
    {
      client_id: OAUTH_CLIENT_ID,
      metadata: {
        client_name: "Auth kill OAuth client",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [OAUTH_REDIRECT_URI],
        token_endpoint_auth_method: "none",
      },
    },
  ]);
}

function authorizationDetail(instanceId: string, clientPurpose = "auth kill boundary") {
  return {
    access_mode: "continuous",
    purpose_code: "https://pdpp.dev/purpose/personalization",
    purpose_description: clientPurpose,
    source: { id: loadSpotifyManifest().connector_id, kind: "connector" },
    streams: [{ instance_ids: [instanceId], name: "top_artists", view: "basic" }],
    type: "https://pdpp.dev/data-access",
  };
}

export interface ReviewedConsent {
  readonly deviceCode: string;
  readonly reviewRevision: string;
}

/** A pending consent whose review is finalized, ready for `approveGrant`. */
export async function startReviewedConsent(
  spec: StorageSpec,
  clientId: string = CONSENT_CLIENT_ID
): Promise<ReviewedConsent> {
  const instanceId = `cin_kill_${randomBytes(4).toString("hex")}`;
  await seedInstance(spec, instanceId);
  const initiated = await initiateGrant({
    authorization_details: [authorizationDetail(instanceId)],
    client_id: clientId,
  });
  const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
  if (!deviceCode) throw new Error("initiateGrant returned an unparsable request_uri");
  const pending = await getPendingConsent(deviceCode, {
    finalizeReview: true,
    subjectId: "owner_local",
  });
  if (typeof pending?.reviewRevision !== "string") throw new Error("pending consent review was not finalized");
  return { deviceCode, reviewRevision: pending.reviewRevision };
}

export interface ApprovedGrant {
  readonly deviceCode: string;
  readonly grantId: string;
  readonly token: string;
}

export async function approveReviewedConsent(
  spec: StorageSpec,
  clientId: string = CONSENT_CLIENT_ID
): Promise<ApprovedGrant & { grant: Record<string, unknown> }> {
  const reviewed = await startReviewedConsent(spec, clientId);
  const approved = await approveGrant(reviewed.deviceCode, "owner_local", {
    approval_review_revision: reviewed.reviewRevision,
  });
  return {
    deviceCode: reviewed.deviceCode,
    grant: approved.grant as Record<string, unknown>,
    grantId: approved.grant.grant_id as string,
    token: approved.token,
  };
}

export interface PkceMaterial {
  readonly challenge: string;
  readonly verifier: string;
}

export function newPkce(): PkceMaterial {
  const verifier = randomBytes(32).toString("base64url");
  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    verifier,
  };
}

/** An approved grant plus a staged OAuth authorization request for the same device code. */
export async function approveAndStageOAuthRequest(spec: StorageSpec): Promise<ApprovedGrant & { pkce: PkceMaterial }> {
  const approved = await approveReviewedConsent(spec, OAUTH_CLIENT_ID);
  const pkce = newPkce();
  await stageOAuthAuthorizationCodeRequest({
    clientId: OAUTH_CLIENT_ID,
    codeChallenge: pkce.challenge,
    codeChallengeMethod: "S256",
    deviceCode: approved.deviceCode,
    redirectUri: OAUTH_REDIRECT_URI,
    state: "kill-state",
  });
  return {
    deviceCode: approved.deviceCode,
    grantId: approved.grantId,
    pkce,
    token: approved.token,
  };
}

export interface CreatedPackage {
  readonly childGrantIds: readonly string[];
  readonly childTokens: readonly string[];
  readonly packageId: string;
  readonly packageToken: string;
}

export function packageCreationArguments(instanceIds: readonly string[], clientId: string = CONSENT_CLIENT_ID) {
  return {
    authorizationDetails: instanceIds.map((id) => authorizationDetail(id, "auth kill package")),
    clientId,
    connectionIds: [...instanceIds],
    storageBindings: instanceIds.map(() => ({ connector_id: "spotify" })),
  };
}

export async function seedInstances(spec: StorageSpec, prefix: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `cin_${prefix}_${i}`;
    await seedInstance(spec, id);
    ids.push(id);
  }
  return ids;
}

export async function createPackage(spec: StorageSpec, members: number): Promise<CreatedPackage> {
  const ids = await seedInstances(spec, `pkg_${randomBytes(3).toString("hex")}`, members);
  const created = await createHostedMcpGrantPackage(packageCreationArguments(ids, OAUTH_CLIENT_ID));
  const children = created.child_grants as {
    grant: { grant_id: string };
    token: string;
  }[];
  return {
    childGrantIds: children.map((child) => child.grant.grant_id),
    childTokens: children.map((child) => child.token),
    packageId: created.package_id as string,
    packageToken: created.token as string,
  };
}

export async function isActive(token: string): Promise<boolean> {
  return (await introspect(token)).active === true;
}

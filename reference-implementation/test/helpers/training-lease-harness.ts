// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Shared HTTP harness for the AI-training lease prototype tests. PROTOTYPE. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { AI_TRAINING_PERMISSION } from "../../lib/training-lease/constants.ts";
import { makeDpopProof } from "../../lib/training-lease/dpop.ts";
import {
  type Ed25519KeyPair,
  generateEd25519KeyPair,
} from "../../lib/training-lease/jws.ts";
import { canonicalConnectorKey } from "../../server/connector-key.ts";
import { startServer } from "../../server/index.ts";
import { createRequestConnectorInstanceStore } from "../../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../../server/stores/connector-instance-store.ts";
import { TEST_PRE_REGISTERED_PUBLIC_CLIENTS } from "../fixtures/demo-clients.ts";
import { TEST_INTROSPECTION_SERVER_OPTS } from "./introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(__dirname, "..", "..", "fixtures", "seed-manifests");
export const HOUR = 60 * 60 * 1000;
export const MIN = 60 * 1000;
const tempDirs: string[] = [];

after(() => {
  for (const d of tempDirs) {
    rmSync(d, { force: true, recursive: true });
  }
});

export type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: {
    close: (cb: (err?: Error) => void) => void;
    closeAllConnections: () => void;
  };
  rsServer: {
    close: (cb: (err?: Error) => void) => void;
    closeAllConnections: () => void;
  };
};

export async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

export async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as T, status: resp.status };
}

export const json = (
  body: unknown,
  extra: Record<string, string> = {},
): RequestInit => ({
  body: JSON.stringify(body),
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  },
  method: "POST",
});

export async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const form = (o: Record<string, string>): RequestInit => ({
    body: new URLSearchParams(o).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: device } = await fetchJson<{
    device_code: string;
    user_code: string;
  }>(`${asUrl}/oauth/device_authorization`, form({ client_id: clientId }));
  await fetch(
    `${asUrl}/device/approve`,
    form({ subject_id: "owner_local", user_code: device.user_code }),
  );
  const { body: token } = await fetchJson<{ access_token: string }>(
    `${asUrl}/oauth/token`,
    form({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  );
  return token.access_token;
}

export async function seedInstance(connectorId: string): Promise<void> {
  const store = createRequestConnectorInstanceStore();
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(
    "owner_local",
    connectorKey,
  );
  if (await store.get(connectorInstanceId)) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: "training-lease-e2e" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

export interface Harness {
  asUrl: string;
  rsUrl: string;
  connectorId: string;
  clock: { now: number };
  ownerToken: string;
}

export async function withServer(
  enabled: boolean,
  fn: (h: Harness) => Promise<void>,
  extraOpts: Partial<NonNullable<Parameters<typeof startServer>[0]>> = {},
): Promise<void> {
  const clock = { now: Date.now() };
  const storeDir = mkdtempSync(join(tmpdir(), "pdpp-lease-e2e-"));
  const journalDir = mkdtempSync(join(tmpdir(), "pdpp-lease-e2e-journal-"));
  tempDirs.push(storeDir, journalDir);
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    experimentalAiTrainingLeases: enabled
      ? { journalDir, now: () => clock.now, storeDir }
      : null,
    preRegisteredPublicClients: TEST_PRE_REGISTERED_PUBLIC_CLIENTS,
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
    ...extraOpts,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = JSON.parse(
    readFileSync(join(MANIFESTS_DIR, "spotify.json"), "utf8"),
  ) as { connector_id: string };
  const reg = await fetch(`${asUrl}/connectors`, json(manifest));
  assert.equal(reg.status, 201);
  await seedInstance(manifest.connector_id);
  try {
    await fn({
      asUrl,
      clock,
      connectorId: manifest.connector_id,
      ownerToken: await issueOwnerToken(asUrl),
      rsUrl,
    });
  } finally {
    await closeServer(server);
  }
}

export function trainingDetail(
  connectorId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    access_mode: "single_use",
    processing_permissions: [AI_TRAINING_PERMISSION],
    purpose_code: "https://pdpp.dev/purpose/personalization",
    purpose_description: "Train an on-device ranking model for Concert Finder",
    source: {
      id: connectorId.includes("://")
        ? connectorId
        : `https://registry.pdpp.dev/connectors/${connectorId}`,
      kind: "connector",
    },
    streams: [{ fields: ["id", "name", "popularity"], name: "top_artists" }],
    type: "https://pdpp.dev/data-access",
    ...extra,
  };
}

export async function par(
  asUrl: string,
  detail: unknown,
  clientId = "concert_recommendation_app",
) {
  const r = await fetchJson<{
    request_uri?: string;
    error?: string | { code?: string };
  }>(
    `${asUrl}/oauth/par`,
    json({ authorization_details: [detail], client_id: clientId }),
  );
  const e = r.body?.error;
  return { ...r, errorCode: typeof e === "string" ? e : e?.code };
}

export async function issueTrainingGrant(
  h: Harness,
  clientId = "concert_recommendation_app",
) {
  const p = await par(h.asUrl, trainingDetail(h.connectorId), clientId);
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const review = await fetchJson<{
    approval_review: Record<string, unknown>;
    approval_review_revision: string;
  }>(
    `${h.asUrl}/consent/review`,
    json({
      processing_permissions_approved: true,
      request_uri: p.body.request_uri,
      subject_id: "owner_local",
    }),
  );
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const approved = await fetchJson<{
    grant: { grant_id: string; expires_at?: string };
    token: string;
  }>(
    `${h.asUrl}/consent/approve`,
    json({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: p.body.request_uri,
    }),
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { ...approved.body, review: review.body.approval_review };
}

export class PublicLeaseClient {
  readonly key: Ed25519KeyPair = generateEd25519KeyPair();
  credential: string | null = null;
  #n = 0;
  readonly h: Harness;
  readonly grantId: string;
  constructor(h: Harness, grantId: string) {
    this.h = h;
    this.grantId = grantId;
  }

  proof(jti?: string, iatMs = this.h.clock.now) {
    this.#n += 1;
    return makeDpopProof({
      iatS: Math.floor(iatMs / 1000),
      jti: jti ?? `proof-${this.#n}-${Math.random().toString(36).slice(2)}`,
      method: "POST",
      privateKey: this.key.privateKey,
      publicJwk: this.key.publicJwk as unknown as Record<string, unknown>,
      url: `${this.h.asUrl}/oauth/processing-lease`,
    });
  }

  async bootstrap(accessToken: string) {
    const r = await fetchJson<{
      lease?: string;
      lease_credential?: string;
      error?: string;
    }>(
      `${this.h.asUrl}/oauth/processing-lease`,
      json(
        { grant_id: this.grantId },
        { Authorization: `Bearer ${accessToken}`, DPoP: this.proof() },
      ),
    );
    if (r.body.lease_credential) {
      this.credential = r.body.lease_credential;
    }
    return r;
  }

  async renew(
    opts: { credential?: string; proof?: string; adopt?: boolean } = {},
  ) {
    const r = await fetchJson<{
      lease?: string;
      lease_credential?: string;
      error?: string;
    }>(
      `${this.h.asUrl}/oauth/processing-lease`,
      json(
        {
          grant_id: this.grantId,
          lease_credential: opts.credential ?? this.credential,
        },
        { DPoP: opts.proof ?? this.proof() },
      ),
    );
    if (r.body.lease_credential && opts.adopt !== false) {
      this.credential = r.body.lease_credential;
    }
    return r;
  }
}

export function leaseExpMs(lease: string): number {
  const payload = JSON.parse(
    Buffer.from(lease.split(".")[1] as string, "base64url").toString("utf8"),
  );
  return payload.exp * 1000;
}

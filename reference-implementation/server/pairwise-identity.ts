// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "./request-store-factories.ts";

export function pairwiseInstanceIdentityEnabled(): boolean {
  return process.env.PDPP_EXPERIMENTAL_PAIRWISE_INSTANCE_IDENTITY === "1";
}

export const OWNER_PAIRWISE_CLIENT_ID = "@owner";

export async function assertStoredPairwiseInstance(
  subjectId: string,
  connectorId: string,
  internalId: string
): Promise<void> {
  const instance = await createRequestConnectorInstanceStore().get(internalId);
  if (!instance || instance.ownerSubjectId !== subjectId || instance.connectorId !== connectorId) {
    throw Object.assign(
      new Error("Authenticated instance binding cannot be resolved to the subject's stored instance"),
      { code: "grant_invalid" }
    );
  }
}

export async function filterPairwiseSearchBindings<T extends { connectorId: string; connectorInstanceId: string }>(
  bindings: T[],
  tokenInfo: {
    pdpp_token_kind: string;
    subject_id?: string | null;
    grant?: { source?: { id?: string } };
    pdpp_instance_bindings?: PairwiseInstanceBinding[];
  }
): Promise<T[]> {
  if (!pairwiseInstanceIdentityEnabled()) {
    return bindings;
  }
  const supplied = tokenInfo.pdpp_instance_bindings;
  if (!supplied) {
    throw Object.assign(new Error("Authenticated instance bindings are missing"), { code: "grant_invalid" });
  }
  const owner = tokenInfo.pdpp_token_kind === "owner";
  const covered = bindings.filter((binding) =>
    supplied.some(
      (entry) =>
        entry.source_id === (owner ? binding.connectorId : tokenInfo.grant?.source?.id) &&
        entry.rs_instance === binding.connectorInstanceId
    )
  );
  if (!owner && covered.length !== bindings.length) {
    throw Object.assign(new Error("Grant instance binding is missing"), {
      code: "grant_invalid",
    });
  }
  await Promise.all(
    covered.map((binding) =>
      assertStoredPairwiseInstance(tokenInfo.subject_id ?? "", binding.connectorId, binding.connectorInstanceId)
    )
  );
  return covered;
}

interface IdentityScope {
  clientId: string;
  issuer?: string;
  sourceId?: string;
  subjectId: string;
}

/** Immutable random handles, scoped by the issuing store, subject and client. */
export async function getPairwiseHandle(
  input: IdentityScope & {
    kind: "subject" | "grantor" | "instance";
    internalId: string;
  }
): Promise<string> {
  const values = [
    input.issuer ?? "local",
    input.subjectId,
    input.clientId,
    input.kind,
    input.sourceId ?? "",
    input.internalId,
  ];
  const candidate = `${input.kind === "instance" ? "inst" : "sub"}_${randomBytes(24).toString("base64url")}`;
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO pairwise_identity_handles (issuer, subject_id, client_id, kind, source_id, internal_id, handle)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (issuer,subject_id,client_id,kind,source_id,internal_id) DO NOTHING`,
      [...values, candidate]
    );
    const result = await postgresQuery<{ handle: string }>(
      "SELECT handle FROM pairwise_identity_handles WHERE issuer=$1 AND subject_id=$2 AND client_id=$3 AND kind=$4 AND source_id=$5 AND internal_id=$6",
      values
    );
    const handle = result.rows[0]?.handle;
    if (!handle) {
      throw new Error("Pairwise identity persistence failed");
    }
    return handle;
  }
  const db = getDb();
  db.prepare(`INSERT INTO pairwise_identity_handles (issuer, subject_id, client_id, kind, source_id, internal_id, handle)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (issuer,subject_id,client_id,kind,source_id,internal_id) DO NOTHING`).run(
    ...values,
    candidate
  );
  const row = db
    .prepare(
      "SELECT handle FROM pairwise_identity_handles WHERE issuer=? AND subject_id=? AND client_id=? AND kind=? AND source_id=? AND internal_id=?"
    )
    .get<{ handle: string }>(...values);
  if (!row) {
    throw new Error("Pairwise identity persistence failed");
  }
  return row.handle;
}

export async function resolvePairwiseInstanceHandle(input: IdentityScope & { handle: string }): Promise<string | null> {
  const values = [input.issuer ?? "local", input.subjectId, input.clientId, input.sourceId ?? "", input.handle];
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{ internal_id: string }>(
      `SELECT internal_id FROM pairwise_identity_handles WHERE issuer=$1 AND subject_id=$2 AND client_id=$3 AND kind='instance' AND source_id=$4 AND handle=$5`,
      values
    );
    return result.rows[0]?.internal_id ?? null;
  }
  return (
    getDb()
      .prepare(
        `SELECT internal_id FROM pairwise_identity_handles WHERE issuer=? AND subject_id=? AND client_id=? AND kind='instance' AND source_id=? AND handle=?`
      )
      .get<{ internal_id: string }>(...values)?.internal_id ?? null
  );
}

interface GrantIdentity {
  client: { client_id: string };
  grantors?: { id: string; capacity: string }[];
  source: { id: string };
  streams: { name: string; instance_ids?: string[] }[];
  subject: { id: string };
}

/** Only presentation identifiers change. Retained internal grants remain enforcement authority. */
export async function projectPairwiseGrant<T extends GrantIdentity>(
  grant: T,
  subjectId = grant.subject.id
): Promise<T> {
  if (!pairwiseInstanceIdentityEnabled()) {
    return grant;
  }
  const projected = structuredClone(grant);
  const scope = { clientId: grant.client.client_id, subjectId };
  projected.subject.id = await getPairwiseHandle({
    ...scope,
    internalId: subjectId,
    kind: "subject",
  });
  if (projected.grantors) {
    await Promise.all(
      projected.grantors.map(async (grantor) => {
        grantor.id = await getPairwiseHandle({
          ...scope,
          internalId: grantor.id,
          kind: "subject",
          subjectId: grantor.id,
        });
      })
    );
  }
  await Promise.all(
    projected.streams.map(async (stream) => {
      if (stream.instance_ids) {
        stream.instance_ids = await Promise.all(
          stream.instance_ids.map((internalId) =>
            getPairwiseHandle({
              ...scope,
              internalId,
              kind: "instance",
              sourceId: grant.source.id,
            })
          )
        );
      }
    })
  );
  return projected;
}

export interface PairwiseInstanceBinding {
  instance_id: string;
  rs_instance: string;
  source_id: string;
  stream?: string;
}

export async function buildPairwiseInstanceBindings(
  grant: GrantIdentity,
  subjectId = grant.subject.id
): Promise<PairwiseInstanceBinding[]> {
  const projected = await projectPairwiseGrant(grant, subjectId);
  const bindings: PairwiseInstanceBinding[] = [];
  for (const [index, stream] of grant.streams.entries()) {
    for (const [instanceIndex, internalId] of (stream.instance_ids ?? []).entries()) {
      const handle = projected.streams[index]?.instance_ids?.[instanceIndex];
      if (!handle) {
        throw new Error("Pairwise grant projection lost an instance binding");
      }
      bindings.push({
        instance_id: handle,
        rs_instance: internalId,
        source_id: grant.source.id,
        stream: stream.name,
      });
    }
  }
  return bindings;
}

export async function buildPairwiseOwnerBindings(subjectId: string): Promise<PairwiseInstanceBinding[]> {
  interface Row {
    connector_id: string;
    connector_instance_id: string;
    manifest: string | null;
  }
  const rows = isPostgresStorageBackend()
    ? (
        await postgresQuery<Row>(
          `SELECT ci.connector_instance_id,ci.connector_id,c.manifest::text AS manifest FROM connector_instances ci LEFT JOIN connectors c ON c.connector_id=ci.connector_id WHERE ci.owner_subject_id=$1 AND ci.status='active'`,
          [subjectId]
        )
      ).rows
    : getDb()
        .prepare(
          `SELECT ci.connector_instance_id,ci.connector_id,c.manifest FROM connector_instances ci LEFT JOIN connectors c ON c.connector_id=ci.connector_id WHERE ci.owner_subject_id=? AND ci.status='active'`
        )
        .all<Row>(subjectId);
  const nestedBindings = await Promise.all(
    rows.map(async (row) => {
      const manifest = row.manifest
        ? (JSON.parse(row.manifest) as {
            source_declaration?: { source?: { id?: string } };
          })
        : null;
      // Owner discovery also addresses installed connectors by their local key.
      const sourceIds = new Set(
        [row.connector_id, manifest?.source_declaration?.source?.id].filter((id): id is string => Boolean(id))
      );
      return await Promise.all(
        [...sourceIds].map(async (sourceId) => ({
          instance_id: await getPairwiseHandle({
            clientId: OWNER_PAIRWISE_CLIENT_ID,
            internalId: row.connector_instance_id,
            kind: "instance",
            sourceId,
            subjectId,
          }),
          rs_instance: row.connector_instance_id,
          source_id: sourceId,
        }))
      );
    })
  );
  return nestedBindings.flat();
}

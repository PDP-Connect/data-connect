// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { decideBindingAuthority } from "../../runtime/binding-authority.ts";
import { getDb } from "../../server/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../../server/postgres-storage.ts";
import type { BindingAuthorityPut } from "../../server/stores/connector-binding-authority-store.ts";

/** Fictional trusted facts only; no resource handles or policy approvals are acquired. */
export function bindingFixture(
  connectionId: string,
  runId = "run-shared",
  ownerId = "owner_local"
): BindingAuthorityPut {
  const policyIdentity = "fixture-policy-revision-7";
  const { record } = decideBindingAuthority({
    accessIdentityByInstance: { files: { identity: "fixture-access", revision: "rev-3" } },
    connectionId,
    instances: [
      {
        declaration: {
          constraints: { outputs: ["/fixture/requested"] },
          description: "full declaration",
          inputs: { archive: { metadata: [1, false, null], selection: "owner-selected" } },
          kind: "filesystem",
          required: true,
        },
        interface: "filesystem@1",
        key: "files",
        kind: "filesystem",
        required: true,
      },
    ],
    now: 100,
    ownerId,
    policyIdentity,
    resolutions: [
      {
        channels: {
          "ambient.extra": { coverage: "not_observable", observedAttempts: ["/fixture/ambient-attempt"] },
          "filesystem.inputs": { coverage: "recorded", observedAttempts: ["/fixture/selected"] },
          "filesystem.outputs": { coverage: "enforced", observedAttempts: [] },
        },
        effectiveConstraints: { inputs: { archive: "/fixture/selected" }, outputs: ["/fixture/narrower"] },
        handleIdentity: "fixture-nonsecret-resource-id",
        instanceKey: "files",
        lifecycle: "granted",
        mechanism: "fixture-trusted-adapter",
        mechanismVersion: "2",
        remainingAmbientAccess: ["unmediated extra channel"],
      },
    ],
    runId,
    weakerCoverageAuthorizations: [
      {
        accessIdentity: "fixture-access",
        accessRevision: "rev-3",
        channel: "filesystem.inputs",
        connectionId,
        expiresAt: 200,
        instanceKey: "files",
        ownerId,
        policyIdentity,
        revoked: false,
      },
    ],
  });
  return { connectionId, ownerId, policyIdentity, record, runId };
}

/** Test-only query bridge; both profiles use their real database. */
export async function bindingQuery(sql: string, values: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  if (isPostgresStorageBackend()) {
    let index = 0;
    const statement = sql.replaceAll("?", () => {
      index += 1;
      return `$${index}`;
    });
    const { rows } = await postgresQuery(statement, values);
    return rows;
  }
  const statement = getDb().prepare(sql);
  if (sql.startsWith("SELECT")) {
    return statement.all(...values) as Record<string, unknown>[];
  }
  statement.run(...values);
  return [];
}

export async function seedBindingConnection(connectionId: string, ownerId = "owner_local"): Promise<void> {
  await bindingQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?) ON CONFLICT DO NOTHING",
    ["binding-fixture-connector", "2026-11-03T00:00:00.000Z"]
  );
  await bindingQuery(
    `INSERT INTO connector_instances (
    connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind,
    source_binding_key, source_binding_json, created_at, updated_at
  ) VALUES (?, ?, ?, 'binding fixture', 'active', 'account', ?, '{}', ?, ?)`,
    [
      connectionId,
      ownerId,
      "binding-fixture-connector",
      connectionId,
      "2026-11-03T00:00:00.000Z",
      "2026-11-03T00:00:00.000Z",
    ]
  );
}

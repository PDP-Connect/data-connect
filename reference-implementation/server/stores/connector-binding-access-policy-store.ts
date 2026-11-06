// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged, writeTransaction } from "../../lib/db.ts";
import type { BindingCoverage, WeakerCoverageAuthorization } from "../../runtime/binding-authority.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "../postgres-storage.ts";
import { BINDING_JSON_MAX_BYTES, BindingJsonError, canonicalBindingJson } from "./binding-json.ts";

import {
  encodeBindingAuthority,
  replayBindingAuthority,
  type BindingAuthorityPut,
  type BindingAuthorityRow,
} from "./connector-binding-authority-store.ts";
import {
  resourceIntent,
  insertBindingResourceIntentSqlite,
  insertBindingResourceIntentPostgres,
  type BindingResourceIntent,
} from "./connector-binding-resource-store.ts";
import { bindingResourceReference, type BindingResourceReference } from "../../runtime/binding-resource-reference.ts";

/** Provisional trusted adapter input. PREPARED is not a grant or an enforcement attestation.
 * Adapters must sanitize all display facts before calling: no tokens, credentials or capability URLs.
 * No public route accepts these facts. This module cannot verify their truth or detect every secret.
 */
export interface PreparedBindingAccess {
  readonly connectionId: string;
  readonly expiresAt: number;
  readonly instances: readonly {
    readonly instanceKey: string;
    readonly kind: string;
    readonly availability: "prepared" | "unsupported" | "unavailable" | "denied";
    readonly accessIdentity: string;
    readonly accessRevision: string;
    readonly requestedDeclaration: Readonly<Record<string, unknown>>;
    readonly effectiveReach: Readonly<Record<string, unknown>>;
    readonly effectiveConstraints: Readonly<Record<string, unknown>>;
    readonly mechanism: string;
    readonly mechanismVersion: string;
    readonly purpose: string;
    readonly consequentialActions: readonly string[];
    readonly remainingAmbientAccess: readonly string[];
    readonly channels: readonly { readonly name: string; readonly coverage: BindingCoverage }[];
  }[];
  readonly ownerId: string;
  readonly phase: "PREPARED";
  readonly policyIdentity: string;
}
export interface AccessPolicyKey {
  readonly connectionId: string;
  readonly ownerId: string;
}
export interface WeakCoverageAcknowledgment {
  readonly accessIdentity: string;
  readonly accessRevision: string;
  readonly channel: string;
  readonly coverage: "recorded" | "not_observable";
  readonly instanceKey: string;
}
export interface AccessPolicyAction extends AccessPolicyKey {
  readonly baseEpoch: number;
  readonly proposalId: string;
  readonly revision: number;
  readonly snapshotDigest: string;
}
export type AccessPolicyStatus = "proposed" | "confirmed" | "rejected" | "superseded" | "withdrawn";
export interface AccessPolicyProposal {
  readonly acknowledgments: readonly WeakCoverageAcknowledgment[] | null;
  readonly baseEpoch: number;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly proposalId: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly snapshot: PreparedBindingAccess;
  readonly snapshotDigest: string;
  readonly status: AccessPolicyStatus;
}
export interface AccessPolicyState {
  readonly active: AccessPolicyProposal | null;
  readonly epoch: number;
  readonly proposal: AccessPolicyProposal | null;
  readonly revision: number;
}
type ErrorCode = "invalid" | "not_found" | "stale" | "conflict" | "storage_error";
export class BindingAccessPolicyError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(`Binding access policy: ${code}`);
    this.code = code;
  }
}
function fail(code: ErrorCode): never {
  throw new BindingAccessPolicyError(code);
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(identity);
}
function keyValid(key: AccessPolicyKey): void {
  if (!(identity(key.ownerId) && identity(key.connectionId))) {
    fail("invalid");
  }
}
function snapshotCopy(input: PreparedBindingAccess): { snapshot: PreparedBindingAccess; json: string; digest: string } {
  const json = canonicalBindingJson(input);
  const value = JSON.parse(json) as PreparedBindingAccess;
  keyValid(value);
  if (
    value.phase !== "PREPARED" ||
    !identity(value.policyIdentity) ||
    !Number.isFinite(value.expiresAt) ||
    !Array.isArray(value.instances) ||
    value.instances.length === 0
  ) {
    fail("invalid");
  }
  const keys = new Set<string>();
  for (const item of value.instances) {
    if (
      !(
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        [
          item.instanceKey,
          item.kind,
          item.accessIdentity,
          item.accessRevision,
          item.mechanism,
          item.mechanismVersion,
          item.purpose,
        ].every(identity)
      ) ||
      keys.has(item.instanceKey) ||
      !["prepared", "unsupported", "unavailable", "denied"].includes(item.availability) ||
      !object(item.requestedDeclaration) ||
      !object(item.effectiveReach) ||
      !object(item.effectiveConstraints) ||
      !strings(item.remainingAmbientAccess) ||
      !strings(item.consequentialActions) ||
      !Array.isArray(item.channels) ||
      item.channels.length === 0
    ) {
      fail("invalid");
    }
    keys.add(item.instanceKey);
    const channels = new Set<string>();
    for (const channel of item.channels) {
      if (
        !(typeof channel === "object" && channel !== null && !Array.isArray(channel) && identity(channel.name)) ||
        channels.has(channel.name) ||
        !["enforced", "recorded", "not_observable"].includes(channel.coverage)
      ) {
        fail("invalid");
      }
      channels.add(channel.name);
    }
  }
  return { digest: createHash("sha256").update(json).digest("hex"), json, snapshot: value };
}
interface Head {
  active_id: string | null;
  epoch: number;
  revision: number;
}
interface Row {
  acknowledgments_json: string | null;
  base_epoch: number;
  confirmed_at: string | null;
  connection_id: string;
  created_at: string;
  owner_id: string;
  proposal_id: string;
  provenance_json: string;
  revision: number;
  snapshot_digest: string;
  snapshot_json: string;
  status: AccessPolicyStatus;
}
interface Statement {
  sql: string;
  values: (string | number | null)[];
}
interface Loaded {
  head: Head;
  rows: Row[];
  connectorId?: string;
}
interface Plan<T> {
  result: T;
  writes: Statement[];
  issuance?: { authority: BindingAuthorityPut; payload: string; intent: BindingResourceIntent };
}
function decode(row: Row): AccessPolicyProposal {
  if (
    [row.snapshot_json, row.provenance_json, row.acknowledgments_json ?? ""].some(
      (json) => Buffer.byteLength(json) > BINDING_JSON_MAX_BYTES
    )
  ) {
    fail("storage_error");
  }
  const { snapshot, digest } = snapshotCopy(JSON.parse(row.snapshot_json) as PreparedBindingAccess);
  if (
    digest !== row.snapshot_digest ||
    snapshot.ownerId !== row.owner_id ||
    snapshot.connectionId !== row.connection_id
  ) {
    fail("storage_error");
  }
  return {
    acknowledgments:
      row.acknowledgments_json === null ? null : (JSON.parse(row.acknowledgments_json) as WeakCoverageAcknowledgment[]),
    baseEpoch: row.base_epoch,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    proposalId: row.proposal_id,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    revision: row.revision,
    snapshot,
    snapshotDigest: digest,
    status: row.status,
  };
}
function statement(sql: string, values: Statement["values"]): Statement {
  return { sql, values };
}
function pgSql(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => {
    index += 1;
    return `$${index}`;
  });
}
export interface IssueRunAuthorityInput {
  readonly snapshot: PreparedBindingAccess;
  readonly expectedAcknowledgments: readonly WeakCoverageAcknowledgment[];
  readonly record: BindingAuthorityPut["record"];
  readonly resource: BindingResourceReference;
}
const AUTHORITY_SELECT = "SELECT * FROM connector_binding_authority_runs WHERE connection_id = ? AND run_id = ?";
const AUTHORITY_INSERT =
  "INSERT INTO connector_binding_authority_runs (owner_id, connection_id, run_id, policy_identity, record_version, recorded_at, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?)";
const HEAD_SQL = "SELECT epoch, revision, active_id FROM connector_binding_access_heads WHERE connection_id = ?";
const ROW_SQL =
  "SELECT * FROM connector_binding_access_policies WHERE connection_id = ? AND owner_id = ? AND (proposal_id = ? OR proposal_id = ? OR revision = ?)";

/** The live connection row is always locked first, including reads/resolution. Transfer and deletion
 * serialize with this transaction. At most three payloads are loaded: target, active and latest.
 */
async function transaction<T>(
  key: AccessPolicyKey,
  id: string | undefined,
  action: (loaded: Loaded) => Plan<T>
): Promise<T> {
  try {
    keyValid(key);
    if (id !== undefined && !identity(id)) {
      fail("invalid");
    }
    if (isPostgresStorageBackend()) {
      return await withPostgresTransaction(async (client) => {
        const owner = await client.query<{ owner_subject_id: string; connector_id: string }>(
          "SELECT owner_subject_id, connector_id FROM connector_instances WHERE connector_instance_id = $1 FOR UPDATE",
          [key.connectionId]
        );
        if (owner.rows[0]?.owner_subject_id !== key.ownerId) {
          fail("not_found");
        }
        const heads = await client.query<Head>(pgSql(HEAD_SQL) + " FOR UPDATE", [key.connectionId]);
        const head = heads.rows[0] ?? { active_id: null, epoch: 0, revision: 0 };
        const rows = await client.query<Row>(pgSql(ROW_SQL), [
          key.connectionId,
          key.ownerId,
          id ?? null,
          head.active_id,
          head.revision,
        ]);
        const plan = action({ head, rows: rows.rows, connectorId: owner.rows[0]!.connector_id });
        await plan.writes.reduce(async (previous, write) => {
          await previous;
          await client.query(pgSql(write.sql), write.values);
        }, Promise.resolve());
        if (plan.issuance) {
          const { authority, payload, intent } = plan.issuance;
          const found = await client.query<BindingAuthorityRow>(pgSql(AUTHORITY_SELECT) + " FOR UPDATE", [
            key.connectionId,
            authority.runId,
          ]);
          replayBindingAuthority(found.rows[0], authority, payload);
          if (!found.rows[0])
            await client.query(pgSql(AUTHORITY_INSERT), [
              authority.ownerId,
              authority.connectionId,
              authority.runId,
              authority.policyIdentity,
              new Date().toISOString(),
              payload,
            ]);
          await insertBindingResourceIntentPostgres(client, intent);
        }
        return plan.result;
      });
    }
    return writeTransaction(() => {
      const [owner] = [
        ...iterateDynamicSqlAcknowledged<{ owner_subject_id: string; connector_id: string }>(
          "SELECT owner_subject_id, connector_id FROM connector_instances WHERE connector_instance_id = ?",
          [key.connectionId]
        ),
      ];
      if (owner?.owner_subject_id !== key.ownerId) {
        fail("not_found");
      }
      const [found] = [...iterateDynamicSqlAcknowledged<Head>(HEAD_SQL, [key.connectionId])];
      const head = found ?? { active_id: null, epoch: 0, revision: 0 };
      const rows = [
        ...iterateDynamicSqlAcknowledged<Row>(ROW_SQL, [
          key.connectionId,
          key.ownerId,
          id ?? null,
          head.active_id,
          head.revision,
        ]),
      ];
      const plan = action({ head, rows, connectorId: owner!.connector_id });
      for (const write of plan.writes) {
        execDynamicSqlAcknowledged(write.sql, write.values);
      }
      if (plan.issuance) {
        const { authority, payload, intent } = plan.issuance;
        const [row] = [
          ...iterateDynamicSqlAcknowledged<BindingAuthorityRow>(AUTHORITY_SELECT, [key.connectionId, authority.runId]),
        ];
        replayBindingAuthority(row, authority, payload);
        if (!row)
          execDynamicSqlAcknowledged(AUTHORITY_INSERT, [
            authority.ownerId,
            authority.connectionId,
            authority.runId,
            authority.policyIdentity,
            new Date().toISOString(),
            payload,
          ]);
        insertBindingResourceIntentSqlite(intent);
      }
      return plan.result;
    });
  } catch (error) {
    if (error instanceof BindingAccessPolicyError) {
      throw error;
    }
    if (error instanceof BindingJsonError) {
      fail("invalid");
    }
    fail("storage_error");
  }
}
function noWrites<T>(result: T): Plan<T> {
  return { result, writes: [] };
}
const DIGEST = /^[a-f0-9]{64}$/;
function validateAction(input: AccessPolicyAction): void {
  if (
    !(identity(input.proposalId) && Number.isSafeInteger(input.revision)) ||
    input.revision < 1 ||
    !Number.isSafeInteger(input.baseEpoch) ||
    input.baseEpoch < 0 ||
    typeof input.snapshotDigest !== "string" ||
    !DIGEST.test(input.snapshotDigest)
  ) {
    fail("invalid");
  }
}
function acknowledgmentsJson(
  proposal: AccessPolicyProposal,
  acknowledgments: readonly WeakCoverageAcknowledgment[]
): string {
  const json = canonicalBindingJson(acknowledgments);
  const copied = JSON.parse(json) as WeakCoverageAcknowledgment[];
  if (!Array.isArray(copied)) {
    fail("invalid");
  }
  const seen = new Set<string>();
  for (const ack of copied) {
    if (!object(ack)) {
      fail("invalid");
    }
    const instance = proposal.snapshot.instances.find((item) => item.instanceKey === ack.instanceKey);
    const channel = instance?.channels.find((item) => item.name === ack.channel);
    const key = canonicalBindingJson([ack.instanceKey, ack.channel]);
    if (
      instance?.availability !== "prepared" ||
      !channel ||
      channel.coverage === "enforced" ||
      ack.coverage !== channel.coverage ||
      ack.accessIdentity !== instance.accessIdentity ||
      ack.accessRevision !== instance.accessRevision ||
      seen.has(key) ||
      Object.keys(ack).length !== 5
    ) {
      fail("invalid");
    }
    seen.add(key);
  }
  return canonicalBindingJson(copied.sort((a, b) => canonicalBindingJson(a).localeCompare(canonicalBindingJson(b))));
}

type Decision = "confirm" | "reject" | "withdraw";
const DECISION_STATUS = { confirm: "confirmed", reject: "rejected", withdraw: "withdrawn" } as const;
function isDecisionReplay(
  proposal: AccessPolicyProposal,
  key: AccessPolicyAction,
  decision: Decision,
  head: Head,
  ackJson: string | null
): boolean {
  if (proposal.status !== DECISION_STATUS[decision]) {
    return false;
  }
  if (
    decision === "confirm" &&
    (head.active_id !== key.proposalId || canonicalBindingJson(proposal.acknowledgments) !== ackJson)
  ) {
    return false;
  }
  const expectedEpoch = decision === "withdraw" ? head.epoch - 1 : proposal.baseEpoch;
  if (key.baseEpoch !== expectedEpoch) {
    fail("stale");
  }
  return true;
}
function requireDecisionTransition(
  proposal: AccessPolicyProposal,
  key: AccessPolicyAction,
  decision: Decision,
  head: Head,
  now: number
): void {
  if (key.baseEpoch !== head.epoch || (decision !== "withdraw" && proposal.baseEpoch !== head.epoch)) {
    fail("stale");
  }
  if (decision === "withdraw") {
    if (proposal.status !== "confirmed" || head.active_id !== key.proposalId) {
      fail("conflict");
    }
    return;
  }
  if (proposal.status !== "proposed") {
    fail("conflict");
  }
  if (decision === "confirm" && proposal.snapshot.expiresAt <= now) {
    fail("conflict");
  }
}

function decisionPlan(
  proposal: AccessPolicyProposal,
  key: AccessPolicyAction,
  decision: Decision,
  head: Head,
  row: Row,
  ackJson: string | null,
  time: number
): Plan<AccessPolicyProposal> {
  const status = DECISION_STATUS[decision];
  const confirmedAt = decision === "confirm" ? new Date(time).toISOString() : proposal.confirmedAt;
  let activeId = head.active_id;
  if (decision === "confirm") {
    activeId = key.proposalId;
  }
  if (decision === "withdraw") {
    activeId = null;
  }
  return {
    result: {
      ...proposal,
      acknowledgments:
        ackJson === null ? proposal.acknowledgments : (JSON.parse(ackJson) as WeakCoverageAcknowledgment[]),
      confirmedAt,
      status,
    },
    writes: [
      statement(
        "UPDATE connector_binding_access_policies SET status = ?, acknowledgments_json = ?, confirmed_at = ? WHERE connection_id = ? AND proposal_id = ?",
        [status, ackJson ?? row.acknowledgments_json, confirmedAt, key.connectionId, key.proposalId]
      ),
      ...(decision === "confirm"
        ? [
            statement(
              "UPDATE connector_binding_access_policies SET status = 'superseded' WHERE connection_id = ? AND proposal_id <> ? AND status IN ('proposed', 'confirmed')",
              [key.connectionId, key.proposalId]
            ),
          ]
        : []),
      statement("UPDATE connector_binding_access_heads SET epoch = epoch + 1, active_id = ? WHERE connection_id = ?", [
        activeId,
        key.connectionId,
      ]),
    ],
  };
}

function activePolicy(
  loaded: Loaded,
  copied: ReturnType<typeof snapshotCopy>,
  now: number
): AccessPolicyProposal | null {
  const row = loaded.rows.find((item) => item.proposal_id === loaded.head.active_id);
  if (row?.status !== "confirmed") return null;
  const policy = decode(row);
  if (
    policy.snapshotDigest !== copied.digest ||
    canonicalBindingJson(policy.snapshot) !== copied.json ||
    policy.snapshot.expiresAt <= now ||
    !policy.confirmedAt ||
    !policy.acknowledgments
  )
    return null;
  acknowledgmentsJson(policy, policy.acknowledgments);
  return policy;
}

export function createConnectorBindingAccessPolicyStore(now: () => number = Date.now) {
  return {
    async issueRunAuthority(input: IssueRunAuthorityInput): Promise<BindingResourceIntent> {
      const copied = snapshotCopy(input.snapshot);
      const resource = bindingResourceReference(input.resource);
      const authority: BindingAuthorityPut = {
        connectionId: copied.snapshot.connectionId,
        ownerId: copied.snapshot.ownerId,
        runId: resource.runId,
        policyIdentity: copied.snapshot.policyIdentity,
        record: input.record,
      };
      const payload = encodeBindingAuthority(authority);
      // Copy before any await. The immutable record must contain this exact run generation and resource.
      const record = JSON.parse(payload) as BindingAuthorityPut["record"];
      const granted = record.instances.find((item) => item.instanceKey === resource.instanceKey);
      if (
        resource.connectionId !== authority.connectionId ||
        resource.ownerId !== authority.ownerId ||
        !granted ||
        granted.lifecycle !== "granted" ||
        granted.kind !== "browser" ||
        !granted.handleIdentity
      )
        fail("invalid");
      let handle: Record<string, unknown>;
      try {
        handle = JSON.parse(granted.handleIdentity);
      } catch {
        fail("invalid");
      }
      if (
        !object(handle) ||
        handle.runAdmissionGeneration !== resource.runGeneration ||
        [
          "reservationId",
          "containerId",
          "generation",
          "configurationRevision",
          "allocatorId",
          "deploymentId",
          "bindingScopeIdentity",
          "profileIdentity",
        ].some((key) => handle[key] !== resource[key as keyof BindingResourceReference])
      )
        fail("invalid");
      const acknowledgments = JSON.parse(
        canonicalBindingJson(input.expectedAcknowledgments)
      ) as WeakCoverageAcknowledgment[];
      const intent = resourceIntent(resource);
      return await transaction(copied.snapshot, undefined, (loaded) => {
        if (loaded.connectorId !== resource.connectorId) fail("invalid");
        const policy = activePolicy(loaded, copied, now());
        if (
          !policy ||
          acknowledgmentsJson(policy, acknowledgments) !== acknowledgmentsJson(policy, policy.acknowledgments!)
        )
          fail("stale");
        const prepared = policy.snapshot.instances.find((item) => item.instanceKey === resource.instanceKey);
        if (
          !prepared ||
          prepared.availability !== "prepared" ||
          prepared.kind !== granted.kind ||
          canonicalBindingJson(granted.requestedDeclaration) !== canonicalBindingJson(prepared.requestedDeclaration) ||
          granted.channels.some((channel) => {
            const actual = prepared.channels.find((item) => item.name === channel.name);
            if (!actual || actual.coverage !== channel.coverage) return true;
            if (channel.coverage === "enforced") return false;
            const ack = policy.acknowledgments!.find(
              (item) => item.instanceKey === resource.instanceKey && item.channel === channel.name
            );
            const auth = channel.authorization;
            return (
              !ack ||
              !channel.weakerCoverageAuthorized ||
              !auth ||
              auth.revoked ||
              auth.ownerId !== resource.ownerId ||
              auth.connectionId !== resource.connectionId ||
              auth.instanceKey !== resource.instanceKey ||
              auth.channel !== channel.name ||
              auth.policyIdentity !== policy.snapshot.policyIdentity ||
              auth.expiresAt !== policy.snapshot.expiresAt ||
              auth.accessIdentity !== prepared.accessIdentity ||
              auth.accessRevision !== prepared.accessRevision
            );
          }) ||
          prepared.channels.some((channel) => !granted.channels.some((item) => item.name === channel.name))
        )
          fail("invalid");
        return { result: intent, writes: [], issuance: { authority, payload, intent } };
      });
    },
    async decide(
      input: AccessPolicyAction,
      decision: "confirm" | "reject" | "withdraw",
      acknowledgments: readonly WeakCoverageAcknowledgment[] = []
    ): Promise<AccessPolicyProposal> {
      validateAction(input);
      // Snapshot all caller-owned fields synchronously before waiting on the transaction lock.
      const key = { ...input };
      let ackCopy: readonly WeakCoverageAcknowledgment[];
      try {
        ackCopy = JSON.parse(canonicalBindingJson(acknowledgments)) as WeakCoverageAcknowledgment[];
      } catch {
        fail("invalid");
      }
      return await transaction(key, key.proposalId, ({ head, rows }) => {
        const row = rows.find((item) => item.proposal_id === key.proposalId);
        if (!row) {
          fail("not_found");
        }
        const proposal = decode(row);
        if (proposal.revision !== key.revision || proposal.snapshotDigest !== key.snapshotDigest) {
          fail("conflict");
        }
        const ackJson = decision === "confirm" ? acknowledgmentsJson(proposal, ackCopy) : null;
        if (isDecisionReplay(proposal, key, decision, head, ackJson)) {
          return noWrites(proposal);
        }
        requireDecisionTransition(proposal, key, decision, head, now());
        return decisionPlan(proposal, key, decision, head, row, ackJson, now());
      });
    },
    /** Internal only. Preparation/provenance never implies owner confirmation. Finite expiry is supplied by trusted policy. */
    async propose(input: {
      snapshot: PreparedBindingAccess;
      provenance: Readonly<Record<string, unknown>>;
      baseEpoch: number;
      baseRevision: number;
    }): Promise<AccessPolicyProposal> {
      const { baseEpoch, baseRevision } = input;
      let copied: ReturnType<typeof snapshotCopy>;
      let provenance: string;
      try {
        copied = snapshotCopy(input.snapshot);
        provenance = canonicalBindingJson(input.provenance);
      } catch {
        fail("invalid");
      }
      if (
        !object(JSON.parse(provenance)) ||
        copied.snapshot.expiresAt <= now() ||
        !Number.isSafeInteger(baseEpoch) ||
        !Number.isSafeInteger(baseRevision)
      ) {
        fail("invalid");
      }
      return await transaction(copied.snapshot, undefined, ({ head }) => {
        if (head.epoch !== baseEpoch || head.revision !== baseRevision) {
          fail("stale");
        }
        const revision = head.revision + 1;
        const id = randomUUID();
        const createdAt = new Date(now()).toISOString();
        const result: AccessPolicyProposal = {
          acknowledgments: null,
          baseEpoch: head.epoch,
          confirmedAt: null,
          createdAt,
          proposalId: id,
          provenance: JSON.parse(provenance) as Record<string, unknown>,
          revision,
          snapshot: copied.snapshot,
          snapshotDigest: copied.digest,
          status: "proposed",
        };
        return {
          result,
          writes: [
            statement(
              "INSERT INTO connector_binding_access_heads (connection_id, epoch, revision, active_id) VALUES (?, ?, ?, ?) ON CONFLICT (connection_id) DO UPDATE SET revision = excluded.revision",
              [copied.snapshot.connectionId, head.epoch, revision, head.active_id]
            ),
            statement(
              "INSERT INTO connector_binding_access_policies (connection_id, proposal_id, owner_id, revision, base_epoch, snapshot_digest, snapshot_json, provenance_json, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')",
              [
                copied.snapshot.connectionId,
                id,
                copied.snapshot.ownerId,
                revision,
                head.epoch,
                copied.digest,
                copied.json,
                provenance,
                createdAt,
              ]
            ),
          ],
        };
      });
    },
    async read(key: AccessPolicyKey, proposalId?: string): Promise<AccessPolicyState> {
      return await transaction(key, proposalId, ({ head, rows }) => {
        const active = rows.find((row) => row.proposal_id === head.active_id);
        const proposal = rows.find((row) =>
          proposalId === undefined ? row.revision === head.revision : row.proposal_id === proposalId
        );
        if (proposalId !== undefined && !proposal) {
          fail("not_found");
        }
        return noWrites({
          active: active ? decode(active) : null,
          epoch: head.epoch,
          proposal: proposal ? decode(proposal) : null,
          revision: head.revision,
        });
      });
    },
    /** Trusted fresh preparation only. Full canonical equality defeats reused identities with changed facts.
     * Withdrawal affects future resolution only; no resource closure, admission or runtime wiring here.
     */
    async resolve(fresh: PreparedBindingAccess): Promise<WeakerCoverageAuthorization[]> {
      let copied: ReturnType<typeof snapshotCopy>;
      try {
        copied = snapshotCopy(fresh);
      } catch {
        return [];
      }
      try {
        return await transaction(copied.snapshot, undefined, ({ head, rows }) => {
          const policy = activePolicy({ head, rows }, copied, now());
          if (!policy) return noWrites([]);
          return noWrites(
            policy.acknowledgments!.map((ack) => ({
              accessIdentity: ack.accessIdentity,
              accessRevision: ack.accessRevision,
              channel: ack.channel,
              connectionId: copied.snapshot.connectionId,
              expiresAt: policy.snapshot.expiresAt,
              instanceKey: ack.instanceKey,
              ownerId: copied.snapshot.ownerId,
              policyIdentity: copied.snapshot.policyIdentity,
              revoked: false,
            }))
          );
        });
      } catch (error) {
        if (error instanceof BindingAccessPolicyError && error.code === "not_found") {
          return [];
        }
        throw error;
      }
    },
  };
}

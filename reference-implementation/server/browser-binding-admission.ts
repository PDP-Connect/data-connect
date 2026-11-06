// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { iterateDynamicSqlAcknowledged } from "../lib/db.ts";
import { emitSpineEvent } from "../lib/spine.ts";
import { decideBindingAuthority } from "../runtime/binding-authority.ts";
import {
  BINDING_CONTROL_PREFIX,
  type BindingActivationContext,
  type BindingControlTarget,
  BrowserBindingOwnerActionRequired,
  BrowserBindingPlacementRefused,
  bindingPermit,
  controlAuthenticated,
  NekoBindingControlClient,
  refuseBindingControl,
} from "../runtime/binding-control.ts";
import {
  type BindingInstance,
  normalizeBindingDeclarations,
  unsupportedReason,
} from "../runtime/binding-declarations.ts";
import { bindingResourceReference } from "../runtime/binding-resource-reference.ts";
import type { PreparedNekoReservation } from "./neko-surface-allocator-server.ts";
import { type BrowserBindingApprovalLifetime, newBrowserBindingApprovalExpiry } from "./browser-binding-lifetime.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";
import { canonicalBindingJson } from "./stores/binding-json.ts";
import {
  createConnectorBindingAccessPolicyStore,
  type PreparedBindingAccess,
} from "./stores/connector-binding-access-policy-store.ts";
import { createConnectorBindingAuthorityStore } from "./stores/connector-binding-authority-store.ts";
import { createConnectorBindingResourceStore, resourceIntent } from "./stores/connector-binding-resource-store.ts";
import type { createApp } from "./transport.ts";

export interface BrowserBindingAdmissionOptions {
  readonly allocator: BindingControlTarget;
  readonly credential: string;
  readonly policyIdentity: string;
  /** Exactly one lifecycle form is required when protected sync is enabled. */
  readonly syncLifecycle?: BrowserBindingApprovalLifetime;
}
interface RunFacts {
  connector_id: string;
  manifest: unknown;
  owner_subject_id: string;
  run_generation: number;
}
interface RegisteredRun {
  cancelled?: boolean;
  readonly deadline: number;
  readonly instances: readonly BindingInstance[];
  readonly manifest: string;
  readonly reservation: PreparedNekoReservation;
  readonly runGeneration: number;
  readonly snapshot: PreparedBindingAccess;
}
const SUPPORT = {
  constraintKinds: new Set<string>(),
  features: new Set<string>(),
  interfaceVersions: new Map([["browser", new Set([1])]]),
  kinds: new Set(["browser"]),
};
function key(connectionId: string, runId: string): string {
  return canonicalBindingJson([connectionId, runId]);
}
async function runFacts(connectionId: string, runId: string): Promise<RunFacts> {
  const sql = `SELECT c.owner_subject_id, c.connector_id, m.manifest, r.run_generation FROM connector_instances c
    JOIN connectors m ON m.connector_id = c.connector_id
    JOIN controller_active_runs r ON r.connector_instance_id = c.connector_instance_id AND r.connector_id = c.connector_id
    WHERE c.connector_instance_id = ? AND r.run_id = ? AND c.status = 'active'`;
  const rows = isPostgresStorageBackend()
    ? (await postgresQuery<RunFacts>(sql.replace("?", "$1").replace("?", "$2"), [connectionId, runId])).rows
    : [...iterateDynamicSqlAcknowledged<RunFacts>(sql, [connectionId, runId])];
  const [row] = rows;
  if (rows.length !== 1 || !row?.owner_subject_id) {
    return refuseBindingControl();
  }
  return row;
}
function manifestObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuseBindingControl();
  }
  return parsed as Record<string, unknown>;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
}
function preparedInstance(
  item: BindingInstance,
  reservation: PreparedNekoReservation
): PreparedBindingAccess["instances"][number] {
  const base = {
    accessIdentity: `unsupported:${item.key}`,
    accessRevision: hash(item.declaration),
    availability: "unsupported" as const,
    channels: [{ coverage: "not_observable" as const, name: `${item.kind}.unavailable` }],
    consequentialActions: [],
    effectiveConstraints: {},
    effectiveReach: {},
    instanceKey: item.key,
    kind: item.kind,
    mechanism: "unsupported-resource",
    mechanismVersion: "1",
    purpose: "No resource is resolved for this optional declaration",
    remainingAmbientAccess: [],
    requestedDeclaration: item.declaration,
  };
  if (item.key !== reservation.scope.instanceKey) {
    return base;
  }
  const { access } = reservation;
  return {
    ...base,
    accessIdentity: access.identity,
    accessRevision: access.revision,
    availability: "prepared",
    channels: access.channels,
    consequentialActions: access.consequentialActions,
    effectiveReach: {
      imageId: access.imageId,
      launchConfigurationRevision: access.launchConfigurationRevision,
      networkId: access.networkId,
      networkName: access.networkName,
      profileIdentity: access.profileIdentity,
      reach: access.effectiveReach,
    },
    mechanism: access.mechanism,
    mechanismVersion: access.mechanismVersion,
    purpose: access.purpose,
    remainingAmbientAccess: access.remainingAmbientAccess,
  };
}

function activationInput(body: unknown): { reservation: PreparedNekoReservation; runId: string; deadline: number } {
  const input = new Object(body) as { reservation?: PreparedNekoReservation; runId?: string; deadline?: number };
  if (
    typeof input.reservation?.scope.connectionId !== "string" ||
    typeof input.runId !== "string" ||
    typeof input.deadline !== "number" ||
    !Number.isFinite(input.deadline) ||
    input.deadline <= Date.now()
  ) {
    return refuseBindingControl();
  }
  return { deadline: input.deadline, reservation: input.reservation, runId: input.runId };
}

/** Authenticated admission over real controller bookkeeping. */
export function createBrowserBindingAdmission(rawOptions: BrowserBindingAdmissionOptions) {
  const options = structuredClone(rawOptions);
  const lifecycle = options.syncLifecycle;
  if (lifecycle) {
    newBrowserBindingApprovalExpiry(lifecycle, Date.now());
  }
  const client = new NekoBindingControlClient(options.allocator);
  if (!(controlAuthenticated(`Bearer ${options.credential}`, options.credential) && options.policyIdentity.trim())) {
    refuseBindingControl();
  }
  const registered = new Map<string, RegisteredRun>();
  const policies = createConnectorBindingAccessPolicyStore();
  const authority = createConnectorBindingAuthorityStore();
  const resources = createConnectorBindingResourceStore();
  async function current(connectionId: string, runId: string, startup = true): Promise<RegisteredRun> {
    const registration = registered.get(key(connectionId, runId));
    if (
      !registration ||
      registration.cancelled ||
      (startup && registration.deadline <= Date.now()) ||
      registration.reservation.expiresAt <= Date.now()
    ) {
      return refuseBindingControl();
    }
    const facts = await runFacts(connectionId, runId);
    if (
      registered.get(key(connectionId, runId)) !== registration ||
      registration.cancelled ||
      (startup && registration.deadline <= Date.now()) ||
      registration.reservation.expiresAt <= Date.now() ||
      facts.run_generation !== registration.runGeneration ||
      facts.owner_subject_id !== registration.snapshot.ownerId ||
      facts.connector_id !== registration.reservation.scope.connectorId ||
      canonicalBindingJson(manifestObject(facts.manifest)) !== registration.manifest
    ) {
      refuseBindingControl();
    }
    return registration;
  }
  async function observeGrant(body: unknown) {
    const input = activationInput(body);
    const { connectionId } = input.reservation.scope;
    const registration = await current(connectionId, input.runId, false);
    if (canonicalBindingJson(input.reservation) !== canonicalBindingJson(registration.reservation)) {
      refuseBindingControl();
    }
    const stored = await authority.get({ connectionId, ownerId: registration.snapshot.ownerId, runId: input.runId });
    if (!stored || registration.snapshot.expiresAt <= Date.now()) {
      refuseBindingControl();
    }
    await current(connectionId, input.runId, false);
    return bindingPermit(registration.reservation, { deadline: input.deadline, runId: input.runId });
  }
  async function authorize(body: unknown, check: boolean) {
    const input = activationInput(body);
    const { connectionId } = input.reservation.scope;
    const registration = await current(connectionId, input.runId);
    if (
      input.deadline !== registration.deadline ||
      canonicalBindingJson(input.reservation) !== canonicalBindingJson(registration.reservation)
    ) {
      refuseBindingControl();
    }
    const { snapshot, reservation, instances } = registration;
    const weak = await policies.resolve(snapshot);
    // Both channels must have explicit authorization even for an optional browser.
    if (
      !reservation.access.channels.every((channel) =>
        weak.some((ack) => ack.instanceKey === reservation.scope.instanceKey && ack.channel === channel.name)
      )
    ) {
      refuseBindingControl();
    }
    const decision = decideBindingAuthority({
      accessIdentityByInstance: Object.fromEntries(
        snapshot.instances.map((item) => [
          item.instanceKey,
          { identity: item.accessIdentity, revision: item.accessRevision },
        ])
      ),
      connectionId,
      instances,
      now: Date.now(),
      ownerId: snapshot.ownerId,
      policyIdentity: snapshot.policyIdentity,
      resolutions: instances.map((instance) =>
        instance.key === reservation.scope.instanceKey
          ? {
              channels: Object.fromEntries(
                reservation.access.channels.map((channel) => [channel.name, { coverage: channel.coverage }])
              ),
              effectiveConstraints: {},
              handleIdentity: canonicalBindingJson({
                reservationId: reservation.reservationId,
                runAdmissionGeneration: registration.runGeneration,
                ...reservation.resource,
              }),
              instanceKey: instance.key,
              lifecycle: "granted" as const,
              mechanism: reservation.access.mechanism,
              mechanismVersion: reservation.access.mechanismVersion,
              remainingAmbientAccess: reservation.access.remainingAmbientAccess,
            }
          : { channels: {}, instanceKey: instance.key, lifecycle: "unsupported" as const }
      ),
      runId: input.runId,
      weakerCoverageAuthorizations: weak,
    });
    if (!decision.placeable) {
      refuseBindingControl();
    }
    const recordKey = { connectionId, ownerId: snapshot.ownerId, runId: input.runId };
    const resource = bindingResourceReference({
      ...reservation.resource,
      ...reservation.scope,
      reservationId: reservation.reservationId,
      runGeneration: registration.runGeneration,
      runId: input.runId,
      version: 1,
    });
    if (check) {
      const stored = await authority.get(recordKey);
      if (!stored || canonicalBindingJson(stored.record) !== canonicalBindingJson(decision.record)) {
        refuseBindingControl();
      }
      const intentId = resourceIntent(resource).intentId;
      if (!(await resources.listUnresolved()).some((intent) => intent.intentId === intentId)) {
        refuseBindingControl();
      }
    } else {
      const expectedAcknowledgments = weak.map((authorization) => {
        const instance = snapshot.instances.find((item) => item.instanceKey === authorization.instanceKey);
        const channel = instance?.channels.find((item) => item.name === authorization.channel);
        if (!instance || !channel || channel.coverage === "enforced") {
          return refuseBindingControl();
        }
        return {
          accessIdentity: authorization.accessIdentity,
          accessRevision: authorization.accessRevision,
          channel: authorization.channel,
          coverage: channel.coverage,
          instanceKey: authorization.instanceKey,
        };
      });
      await policies.issueRunAuthority({ expectedAcknowledgments, record: decision.record, resource, snapshot });
    }
    // Writer/storage waits may span withdrawal, expiry, cancellation or run completion.
    await current(connectionId, input.runId);
    if (canonicalBindingJson(await policies.resolve(snapshot)) !== canonicalBindingJson(weak)) {
      refuseBindingControl();
    }
    return bindingPermit(reservation, { deadline: input.deadline, runId: input.runId });
  }
  return {
    async getRunAuthority(connectionId: string, runId: string, freshPolicy = false) {
      const registration = await current(connectionId, runId, false);
      const stored = await authority.get({ connectionId, ownerId: registration.snapshot.ownerId, runId });
      if (!stored || stored.policyIdentity !== options.policyIdentity) {
        return refuseBindingControl();
      }
      if (freshPolicy) {
        await authorize({ deadline: registration.deadline, reservation: registration.reservation, runId }, true);
      } else {
        await current(connectionId, runId, false);
      }
      return stored.record;
    },
    async activateRun(connectionId: string, rawContext: BindingActivationContext) {
      const context = { ...rawContext };
      const registration = await current(connectionId, context.runId);
      if (context.deadline !== registration.deadline) {
        refuseBindingControl();
      }
      return await client.activate(registration.reservation, context);
    },
    async assertRunManifest(connectionId: string, runId: string, manifest: unknown) {
      const facts = await runFacts(connectionId, runId);
      if (canonicalBindingJson(manifestObject(facts.manifest)) !== canonicalBindingJson(manifest)) {
        refuseBindingControl();
      }
      const requirements = manifestObject(facts.manifest).runtime_requirements as { bindings?: unknown } | undefined;
      for (const instance of normalizeBindingDeclarations(requirements?.bindings)) {
        const reason = unsupportedReason(instance, SUPPORT);
        if (instance.required && reason !== null) {
          throw new BrowserBindingPlacementRefused(instance.key, reason);
        }
      }
    },
    async assertRunPolicy(connectionId: string, runId: string) {
      const registration = registered.get(key(connectionId, runId));
      if (!registration || registration.cancelled) {
        return;
      }
      const { snapshot, reservation } = await current(connectionId, runId);
      const acknowledgments = await policies.resolve(snapshot);
      if (
        reservation.access.channels.every((channel) =>
          acknowledgments.some(
            (ack) => ack.instanceKey === reservation.scope.instanceKey && ack.channel === channel.name
          )
        )
      ) {
        return;
      }
      const state = await policies.read({ connectionId, ownerId: snapshot.ownerId });
      const proposal =
        state.proposal?.status === "proposed" &&
        canonicalBindingJson(state.proposal.snapshot) === canonicalBindingJson(snapshot)
          ? state.proposal
          : await policies.propose({
              baseEpoch: state.epoch,
              baseRevision: state.revision,
              provenance: { mechanism: reservation.access.mechanism },
              snapshot,
            });
      throw new BrowserBindingOwnerActionRequired({
        connectionId,
        kind: "confirm_browser_access",
        proposalId: proposal.proposalId,
      });
    },
    async cancelRun(connectionId: string, runId: string, deadline: number) {
      const registration = registered.get(key(connectionId, runId));
      if (registration) {
        registration.cancelled = true;
        await client.cancel(registration.reservation, deadline);
        registered.delete(key(connectionId, runId));
      }
    },
    async disposeRun(reservation: PreparedNekoReservation, runId: string) {
      try {
        await client.dispose(reservation, Date.now() + options.allocator.timeoutMs);
      } catch (error) {
        // Physical closure is durable, but allocator scope release is not.
        // Retain this exact retirement so explicit reconciliation can replay it.
        await emitSpineEvent({
          actor_id: reservation.scope.connectorId,
          actor_type: "runtime",
          data: { connection_id: reservation.scope.connectionId },
          event_type: "run.browser_binding_retirement",
          object_id: runId,
          object_type: "run",
          run_id: runId,
          status: "metadata_retained",
        }).catch(() => undefined);
        throw error;
      }
    },
    mount(app: Pick<ReturnType<typeof createApp>, "fastify">) {
      for (const action of ["authorize", "check", "observe"] as const) {
        app.fastify.post(
          `${BINDING_CONTROL_PREFIX}/${action}`,
          {
            bodyLimit: 131_072,
            errorHandler: (_error, _req, reply) => reply.code(400).send({ error: "binding_control_refused" }),
            onRequest: (req, reply, done) => {
              reply.header("Cache-Control", "no-store");
              if (!controlAuthenticated(req.headers.authorization, options.credential)) {
                reply.code(401).send({ error: "control_unauthorized" });
                return;
              }
              done();
            },
          },
          async (req, reply) => {
            try {
              return reply
                .code(200)
                .send(await (action === "observe" ? observeGrant(req.body) : authorize(req.body, action === "check")));
            } catch {
              return reply.code(409).send({ error: "binding_control_refused" });
            }
          }
        );
      }
    },
    /** Trusted in-process lifetime policy and run/readiness deadline.
     * Owner and declaration come from storage; this never confirms access.
     */
    async prepareRun(rawInput: {
      connectionId: string;
      runId: string;
      policyExpiresAt?: number;
      approvalMaxAgeMs?: number;
      deadline: number;
      expectedManifest?: unknown;
    }) {
      const input = { ...rawInput };
      const facts = await runFacts(input.connectionId, input.runId);
      const manifest = manifestObject(facts.manifest);
      if (
        input.expectedManifest !== undefined &&
        canonicalBindingJson(input.expectedManifest) !== canonicalBindingJson(manifest)
      ) {
        refuseBindingControl();
      }
      const requirements = manifest.runtime_requirements as { bindings?: unknown } | undefined;
      const instances = normalizeBindingDeclarations(requirements?.bindings);
      for (const instance of instances) {
        const reason = unsupportedReason(instance, SUPPORT);
        if (instance.required && reason !== null) {
          throw new BrowserBindingPlacementRefused(instance.key, reason);
        }
      }
      const browser = instances.filter((candidate) => unsupportedReason(candidate, SUPPORT) === null);
      const now = Date.now();
      const requestedLifetime = {
        ...(input.policyExpiresAt === undefined ? {} : { policyExpiresAt: input.policyExpiresAt }),
        ...(input.approvalMaxAgeMs === undefined ? {} : { approvalMaxAgeMs: input.approvalMaxAgeMs }),
      };
      if (
        browser.length !== 1 ||
        instances.some((candidate) => candidate.required && unsupportedReason(candidate, SUPPORT) !== null) ||
        (lifecycle && Object.keys(requestedLifetime).length > 0 &&
          canonicalBindingJson(lifecycle) !== canonicalBindingJson(requestedLifetime)) ||
        !Number.isFinite(input.deadline) ||
        input.deadline <= now ||
        input.deadline - now > options.allocator.timeoutMs ||
        registered.has(key(input.connectionId, input.runId))
      ) {
        refuseBindingControl();
      }
      const expiresAt = newBrowserBindingApprovalExpiry(
        lifecycle ?? (requestedLifetime as BrowserBindingApprovalLifetime), now
      );
      const [instance] = browser;
      if (!instance) {
        return refuseBindingControl();
      }
      const state = await policies.read({ connectionId: input.connectionId, ownerId: facts.owner_subject_id });
      const reservation = await client.prepare(
        {
          connectionId: input.connectionId,
          connectorId: facts.connector_id,
          expiresAt,
          instanceKey: instance.key,
          ownerId: facts.owner_subject_id,
          requestedOrigins: [],
        },
        input.deadline
      );
      let snapshot: PreparedBindingAccess = {
        connectionId: input.connectionId,
        expiresAt,
        instances: instances.map((item) => preparedInstance(item, reservation)),
        ownerId: facts.owner_subject_id,
        phase: "PREPARED",
        policyIdentity: options.policyIdentity,
      };
      if (state.active && state.active.snapshot.expiresAt > now) {
        const retained = { ...snapshot, expiresAt: state.active.snapshot.expiresAt };
        if (canonicalBindingJson(retained) === canonicalBindingJson(state.active.snapshot)) {
          snapshot = retained;
        }
      }
      registered.set(key(input.connectionId, input.runId), {
        deadline: input.deadline,
        instances,
        manifest: canonicalBindingJson(manifest),
        reservation,
        runGeneration: facts.run_generation,
        snapshot,
      });
      const proposal =
        state.active && canonicalBindingJson(state.active.snapshot) === canonicalBindingJson(snapshot)
          ? state.active
          : await policies.propose({
              baseEpoch: state.epoch,
              baseRevision: state.revision,
              provenance: { mechanism: reservation.access.mechanism },
              snapshot,
            });
      const acknowledgments = await policies.resolve(snapshot);
      const approved = reservation.access.channels.every((channel) =>
        acknowledgments.some((ack) => ack.instanceKey === reservation.scope.instanceKey && ack.channel === channel.name)
      );
      return { approved, proposal, reservation };
    },
    async statusRun(connectionId: string, runId: string, freshPolicy = false) {
      const registration = await current(connectionId, runId, freshPolicy);
      if (freshPolicy) {
        await authorize({ deadline: registration.deadline, reservation: registration.reservation, runId }, true);
      }
      const surface = await client.status(registration.reservation, {
        deadline: Date.now() + options.allocator.timeoutMs,
        runId,
      });
      if (freshPolicy) {
        // Readiness I/O can span policy withdrawal. Final handoff is a future
        // resolution even though ordinary active observation is not.
        await authorize({ deadline: registration.deadline, reservation: registration.reservation, runId }, true);
      }
      return surface;
    },
    async stopRun(connectionId: string, runId: string, deadline: number) {
      const registration = registered.get(key(connectionId, runId));
      if (registration) {
        registration.cancelled = true;
        // Keep registration on uncertain cleanup. A normal release is not stop.
        await client.stop(registration.reservation, deadline);
        const resource = bindingResourceReference({
          ...registration.reservation.resource,
          ...registration.reservation.scope,
          reservationId: registration.reservation.reservationId,
          runGeneration: registration.runGeneration,
          runId,
          version: 1,
        });
        const intentId = resourceIntent(resource).intentId;
        if ((await resources.listUnresolved()).some((intent) => intent.intentId === intentId)) {
          const receipt = await client.recoverStoppedResource(resource, deadline);
          await resources.retire(intentId, receipt);
        }
        registered.delete(key(connectionId, runId));
      }
    },
  };
}

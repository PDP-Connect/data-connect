// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Representative (parent) approval for the DR pilot, transport-neutral so the
// browser routes and the headless load harness run the same logic.
//
// PDPP Core #378 "Representative approval" -> where it happens here:
//   1. authenticate each grantor            -> Cuenta Única session (caller)
//   2. verify authority before showing any
//      subject-specific information           -> selectChild(): registry.isGuardian()
//                                               runs before any child data is read
//   3. show the representative context       -> review display (routes.ts)
//   4. bind grantor + capacity into the
//      final approval artifact               -> pilot revision over (core review
//                                               revision, grantors, subject, actor)
//   5. never record a grantor as the subject -> grant.subject = child; grantors =
//                                               [{ pairwise id, capacity URI }]
// "current authority is checked when used"  -> registry re-checked at approval
//                                               and on every management action.

import { createHash } from "node:crypto";
import { emitSpineEvent } from "../../lib/spine.ts";
import {
  approveGrant,
  denyGrant,
  getPendingConsent,
  getStagedOAuthAuthorizationRedirect,
  issueOAuthAuthorizationCodeForDeviceCode,
  parsePendingConsentRequestUri,
  revokeGrant,
} from "../auth.ts";
import { postgresQuery } from "../postgres-storage.ts";
import { CAPACITY_URIS, type GuardianCapacity, PILOT_EVENTS, pilotSourceId, registerOwnerSubjectId } from "./config.ts";
import type { ParentSession } from "./cuenta-unica-stub.ts";
import type { Grantor } from "./grantors.ts";
import { type CivilRegistry, eighteenthBirthday, type RegistryChild } from "./registry-stub.ts";
import {
  getRepresentativeGrant,
  getRepresentativeReview,
  INSERT_REPRESENTATIVE_GRANT_SQL,
  listGrantsForChildren,
  pairwiseGrantorId,
  type RepresentativeGrantRow,
  recordRevocation,
  saveRepresentativeReview,
} from "./store.ts";

export class PilotError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface PendingSummary {
  clientId: string;
  clientName: string | null;
  deviceCode: string;
  purposeCode: string;
  purposeDescription: string | null;
  requestedResources: string[] | null;
  sourceId: string;
  streams: string[];
}

export interface RefusedOutcome {
  kind: "refused";
  /** OAuth error redirect when the client started at /oauth/authorize. */
  redirectTo: string | null;
  registryReason: string;
}

export interface ReviewOutcome {
  capacity: GuardianCapacity;
  child: RegistryChild;
  expiresAt: string;
  grantors: Grantor[];
  kind: "review";
  pilotRevision: string;
  pending: PendingSummary;
  requestUri: string;
  review: Record<string, unknown>;
}

export interface ApprovedOutcome {
  grant: Record<string, unknown>;
  grantId: string;
  kind: "approved";
  redirectTo: string | null;
  token: string;
}

function sha256b64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, (v as Record<string, unknown>)[key]])
        )
      : v
  );
}

interface PendingParams {
  client?: { client_display?: { name?: string | null }; client_id?: string };
  selection?: {
    purpose_code?: string;
    purpose_description?: string;
    streams?: Array<Record<string, unknown>>;
  };
  source_binding?: { id?: string };
}

/** Light read of a pending consent; null when it is not a pending pilot request. */
export async function loadPendingPilotRequest(requestUri: unknown): Promise<PendingSummary | null> {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  if (!deviceCode) {
    return null;
  }
  const result = await postgresQuery(
    `SELECT params_json, status, expires_at FROM pending_consents WHERE device_code = $1`,
    [deviceCode]
  );
  const row = result.rows[0];
  if (row?.status !== "pending" || Date.parse(String(row.expires_at)) <= Date.now()) {
    return null;
  }
  const params = row.params_json as PendingParams;
  const sourceId = params.source_binding?.id;
  const streams = params.selection?.streams;
  if (sourceId !== pilotSourceId() || !Array.isArray(streams)) {
    return null;
  }
  const resourceLists = streams.filter((s) => Array.isArray(s.resources)).map((s) => s.resources as string[]);
  const requestedResources = resourceLists.length > 0 ? [...new Set(resourceLists.flat())] : null;
  return {
    clientId: String(params.client?.client_id),
    clientName: params.client?.client_display?.name ?? null,
    deviceCode,
    purposeCode: String(params.selection?.purpose_code),
    purposeDescription: params.selection?.purpose_description ?? null,
    requestedResources,
    sourceId,
    streams: streams.map((s) => String(s.name)),
  };
}

export function createRepresentativeConsent(registry: CivilRegistry) {
  async function audit(
    eventType: string,
    session: ParentSession,
    fields: {
      clientId?: string | null;
      data: Record<string, unknown>;
      grantId?: string;
      objectId: string;
      objectType: string;
      status: string;
      subjectId?: string;
    }
  ): Promise<void> {
    await emitSpineEvent({
      actor_id: session.parentRef,
      actor_type: "representative",
      client_id: fields.clientId ?? null,
      data: fields.data,
      event_type: eventType,
      grant_id: fields.grantId ?? null,
      object_id: fields.objectId,
      object_type: fields.objectType,
      status: fields.status,
      subject_id: fields.subjectId ?? null,
      subject_type: "subject",
    });
  }

  async function refuse(
    session: ParentSession,
    pending: PendingSummary,
    childId: string | null,
    registryReason: string,
    origin: "registry_refusal" | "representative_declined"
  ): Promise<RefusedOutcome> {
    // The pending request ends denied: the client sees an ordinary
    // access_denied (OAuth redirect or device-code poll), indistinguishable
    // from a parent saying no (#390 "Authorization privacy boundary").
    await denyGrant(pending.deviceCode);
    await audit(
      origin === "registry_refusal" ? PILOT_EVENTS.authorityRefused : "representative.consent_declined",
      session,
      {
        clientId: pending.clientId,
        data: { reason: origin, registry_reason: registryReason },
        objectId: pending.deviceCode,
        objectType: "pending_consent",
        status: "denied",
        ...(childId ? { subjectId: childId } : {}),
      }
    );
    const staged = await getStagedOAuthAuthorizationRedirect(pending.deviceCode);
    let redirectTo: string | null = null;
    if (staged) {
      const url = new URL(staged.redirectUri);
      url.searchParams.set("error", "access_denied");
      if (staged.state) {
        url.searchParams.set("state", staged.state);
      }
      redirectTo = url.toString();
    }
    return { kind: "refused", redirectTo, registryReason };
  }

  async function requirePending(requestUri: unknown): Promise<PendingSummary> {
    const pending = await loadPendingPilotRequest(requestUri);
    if (!pending) {
      throw new PilotError(404, "not_found", "No pending vaccination-record request for this link");
    }
    return pending;
  }

  /** Which child the request is for; null means the parent picks from their own children. */
  function fixedChild(pending: PendingSummary): string | null {
    if (pending.requestedResources?.length === 1) {
      return pending.requestedResources[0] as string;
    }
    if (pending.requestedResources && pending.requestedResources.length > 1) {
      throw new PilotError(400, "invalid_request", "A parent approval covers one child's record per grant");
    }
    return null;
  }

  return {
    fixedChild,

    async listOwnChildren(session: ParentSession) {
      return await registry.listChildren(session.cedula);
    },

    async describeRequest(requestUri: unknown): Promise<PendingSummary> {
      return await requirePending(requestUri);
    },

    /**
     * Step 2 of #378: verify authority before anything about the child is
     * read or shown. On success, finalize the core review for the child and
     * bind the grantor to it.
     */
    async selectChild(
      session: ParentSession,
      requestUri: string,
      pickedChildId: unknown
    ): Promise<RefusedOutcome | ReviewOutcome> {
      const pending = await requirePending(requestUri);
      const childId = fixedChild(pending) ?? (typeof pickedChildId === "string" ? pickedChildId.trim() : "");
      if (!childId) {
        throw new PilotError(400, "invalid_request", "child_id is required");
      }
      const verdict = await registry.isGuardian(session.cedula, childId);
      if (!verdict.ok) {
        return await refuse(session, pending, childId, verdict.reason, "registry_refusal");
      }
      // Authority confirmed: only now read the child's registry entry.
      const child = await registry.getChild(childId);
      if (!child) {
        return await refuse(session, pending, childId, "unknown_child", "registry_refusal");
      }
      const expiresAtCap = eighteenthBirthday(child.birth_date);
      if (Date.parse(expiresAtCap) <= Date.now()) {
        return await refuse(session, pending, childId, "subject_of_age", "registry_refusal");
      }
      let reviewed: Record<string, unknown> | null;
      try {
        reviewed = await getPendingConsent(pending.deviceCode, {
          finalizeReview: true,
          representative: {
            dataSubjectId: childId,
            expiresAtCap,
            instanceOwnerSubjectId: registerOwnerSubjectId(),
            resourceId: childId,
          },
          subjectId: registerOwnerSubjectId(),
        });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "access_denied") {
          return await refuse(session, pending, childId, "resource_not_requested", "registry_refusal");
        }
        throw err;
      }
      const review = reviewed?.review as { expires_at?: string; subject?: { id?: string } } | null;
      const coreRevision = reviewed?.reviewRevision;
      if (!(review && typeof coreRevision === "string")) {
        throw new PilotError(409, "approval_conflict", "The request could not be prepared for review");
      }
      if (review.subject?.id !== childId) {
        throw new PilotError(409, "approval_conflict", "This request is already under review for another record");
      }
      const capacity = verdict.capacity;
      const grantors: Grantor[] = [
        {
          capacity: CAPACITY_URIS[capacity],
          id: pairwiseGrantorId(pending.clientId, session.parentRef),
        },
      ];
      const pilotRevision = `pilot.dr-vacuna.representative-review.v1:sha256:${sha256b64url(
        canonical({
          actor: session.parentRef,
          core_revision: coreRevision,
          grantors,
          subject: { id: childId },
        })
      )}`;
      await saveRepresentativeReview({
        capacity,
        child_id: childId,
        core_revision: coreRevision,
        device_code: pending.deviceCode,
        grantors,
        parent_ref: session.parentRef,
        pilot_revision: pilotRevision,
      });
      await audit(PILOT_EVENTS.authorityVerified, session, {
        clientId: pending.clientId,
        data: {
          capacity: CAPACITY_URIS[capacity],
          registry: "civil_registry_stub",
        },
        objectId: pending.deviceCode,
        objectType: "pending_consent",
        status: "succeeded",
        subjectId: childId,
      });
      return {
        capacity,
        child,
        expiresAt: String(review.expires_at ?? expiresAtCap),
        grantors,
        kind: "review",
        pending,
        pilotRevision,
        requestUri,
        review: review as Record<string, unknown>,
      };
    },

    async approve(
      session: ParentSession,
      requestUri: string,
      pilotRevision: unknown
    ): Promise<ApprovedOutcome | RefusedOutcome> {
      const pending = await requirePending(requestUri);
      const bound = await getRepresentativeReview(pending.deviceCode);
      if (!bound || bound.pilot_revision !== pilotRevision || bound.parent_ref !== session.parentRef) {
        throw new PilotError(409, "approval_conflict", "The reviewed request changed; review it again");
      }
      // Authority can change between review and approval: check it again.
      const verdict = await registry.isGuardian(session.cedula, bound.child_id);
      if (!verdict.ok || CAPACITY_URIS[verdict.capacity] !== bound.grantors[0]?.capacity) {
        return await refuse(
          session,
          pending,
          bound.child_id,
          verdict.ok ? "capacity_changed" : verdict.reason,
          "registry_refusal"
        );
      }
      const grantor = bound.grantors[0] as Grantor;
      const result = await approveGrant(pending.deviceCode, bound.child_id, {
        approval_review_revision: bound.core_revision,
        representative: {
          actorId: session.parentRef,
          dataSubjectId: bound.child_id,
          grantors: bound.grantors,
          instanceOwnerSubjectId: registerOwnerSubjectId(),
          recordInTransaction: async (client, issued) => {
            await client.query(INSERT_REPRESENTATIVE_GRANT_SQL, [
              issued.grantId,
              bound.child_id,
              pending.clientId,
              session.parentRef,
              session.cedula,
              bound.capacity,
              grantor.id,
              pending.clientName,
            ]);
          },
        },
      });
      const grantId = String(result.grant.grant_id);
      const oauthCode = (await issueOAuthAuthorizationCodeForDeviceCode(pending.deviceCode, {
        grantId,
        token: result.token,
      })) as {
        code: string;
        redirect_uri: string;
        state?: string | null;
      } | null;
      let redirectTo: string | null = null;
      if (oauthCode) {
        const url = new URL(oauthCode.redirect_uri);
        url.searchParams.set("code", oauthCode.code);
        if (oauthCode.state) {
          url.searchParams.set("state", oauthCode.state);
        }
        redirectTo = url.toString();
      }
      return {
        grant: result.grant,
        grantId,
        kind: "approved",
        redirectTo,
        token: result.token,
      };
    },

    async decline(session: ParentSession, requestUri: string): Promise<RefusedOutcome> {
      const pending = await requirePending(requestUri);
      return await refuse(session, pending, null, "declined_by_representative", "representative_declined");
    },

    /**
     * "Mis autorizaciones": grants for the children this person has authority
     * for today (registry), whoever approved them. Authority is read fresh.
     */
    async listAuthorizations(session: ParentSession): Promise<{
      children: Array<RegistryChild & { capacity: GuardianCapacity }>;
      grants: Array<RepresentativeGrantRow & { approved_by_you: boolean }>;
    }> {
      const children = await registry.listChildren(session.cedula);
      const grants = await listGrantsForChildren(children.map((c) => c.child_id));
      return {
        children,
        grants: grants.map((g) => ({
          ...g,
          approved_by_you: g.parent_ref === session.parentRef,
        })),
      };
    },

    async revoke(session: ParentSession, grantId: string, disposition: unknown): Promise<RepresentativeGrantRow> {
      if (disposition !== "keep" && disposition !== "delete") {
        // #401 (draft): no default disposition; the request must carry one.
        throw new PilotError(400, "invalid_request", "disposition must be 'keep' or 'delete'");
      }
      const grant = await getRepresentativeGrant(grantId);
      if (!grant) {
        throw new PilotError(404, "not_found", "Authorization not found");
      }
      const verdict = await registry.isGuardian(session.cedula, grant.child_id);
      if (!verdict.ok) {
        await audit(PILOT_EVENTS.managementRefused, session, {
          clientId: grant.client_id,
          data: {
            action: "revoke",
            reason: "registry_refusal",
            registry_reason: verdict.reason,
          },
          grantId,
          objectId: grantId,
          objectType: "grant",
          status: "denied",
          subjectId: grant.child_id,
        });
        throw new PilotError(403, "forbidden", "The civil registry does not confirm your authority for this child");
      }
      if (grant.grant_status !== "active") {
        throw new PilotError(409, "already_ended", "This authorization has already ended");
      }
      await revokeGrant(grantId);
      await recordRevocation(grantId, session.parentRef, disposition);
      await audit(PILOT_EVENTS.grantRevoked, session, {
        clientId: grant.client_id,
        data: { capacity: CAPACITY_URIS[verdict.capacity], disposition },
        grantId,
        objectId: grantId,
        objectType: "grant",
        status: "succeeded",
        subjectId: grant.child_id,
      });
      return (await getRepresentativeGrant(grantId)) as RepresentativeGrantRow;
    },
  };
}

export type RepresentativeConsent = ReturnType<typeof createRepresentativeConsent>;

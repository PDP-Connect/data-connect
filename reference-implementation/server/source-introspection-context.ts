// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ResolvedGrantStream } from "@pdpp/reference-contract/public/source";
import { parseCoreResolvedGrant } from "./core-source-authorization.ts";
import { pairwiseInstanceIdentityEnabled } from "./pairwise-identity.ts";
import {
  buildGrantedAuthorizationDetail,
  requireGrantedAuthorizationDetailEnvelope,
} from "./source-approved-authorization.ts";

type JsonObject = Record<string, unknown>;

export type SourceIntrospectionFailureCode =
  | "context.field_not_granted"
  | "context.grant_mismatch"
  | "context.identity_mismatch"
  | "context.instance_mismatch"
  | "context.kind_mismatch"
  | "context.rights_duplicated"
  | "context.rights_missing"
  | "context.source_mismatch"
  | "context.stream_not_allowed";

export class SourceIntrospectionContextError extends Error {
  readonly code: SourceIntrospectionFailureCode;

  constructor(code: SourceIntrospectionFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SourceReadRequest {
  readonly fields?: readonly string[] | undefined;
  readonly instance_id?: string | undefined;
  readonly stream: string;
}

const SUPPLEMENTARY_RIGHT_KEYS = [
  "authorization_details",
  "fields",
  "instance_ids",
  "resources",
  "streams",
  "time_constraint",
] as const;

function fail(code: SourceIntrospectionFailureCode, message: string): never {
  throw new SourceIntrospectionContextError(code, message);
}

function requireObject(value: unknown, code: SourceIntrospectionFailureCode, label: string): JsonObject {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    fail(code, `${label} is missing or invalid`);
  }
  return value as JsonObject;
}

function requireSingleDetail(info: JsonObject): JsonObject {
  if (!Array.isArray(info.authorization_details) || info.authorization_details.length !== 1) {
    fail("context.rights_missing", "Introspection must carry one granted authorization detail");
  }
  return requireObject(info.authorization_details[0], "context.rights_missing", "Granted authorization detail");
}

function rejectDuplicatedRights(info: JsonObject, pdpp: JsonObject): void {
  if (info.grant !== undefined) {
    fail("context.rights_duplicated", "Supplementary context duplicates approved rights");
  }
  const duplicatedRight = SUPPLEMENTARY_RIGHT_KEYS.find((key) => pdpp[key] !== undefined);
  if (duplicatedRight) {
    fail("context.rights_duplicated", `PDPP context duplicates '${duplicatedRight}' rights`);
  }
}

function requireBindingIdentity(info: JsonObject, pdpp: JsonObject): void {
  if (info.client_id !== pdpp.client_id || info.subject_id !== pdpp.subject_id) {
    fail("context.identity_mismatch", "Introspection identity does not match its PDPP context");
  }
  if (info.grant_id !== pdpp.grant_id) {
    fail("context.grant_mismatch", "Introspection grant does not match its PDPP context");
  }
}

function requireBindingContext(info: JsonObject): JsonObject {
  const pdpp = requireObject(info.pdpp, "context.kind_mismatch", "PDPP context");
  rejectDuplicatedRights(info, pdpp);
  if (pdpp.context_kind !== "oauth_rar_0_1") {
    fail("context.kind_mismatch", "PDPP context kind is not supported");
  }
  requireBindingIdentity(info, pdpp);
  return pdpp;
}

function requireMatchingSource(detail: JsonObject, pdpp: JsonObject): JsonObject {
  const granted = pairwiseInstanceIdentityEnabled()
    ? requireObject(detail.grant, "context.rights_missing", "Granted rights")
    : detail;
  const source = requireObject(granted.source, "context.source_mismatch", "Granted source");
  const contextSource = requireObject(pdpp.source, "context.source_mismatch", "PDPP source");
  if (source.id !== contextSource.id || source.kind !== contextSource.kind) {
    fail("context.source_mismatch", "Granted source does not match its PDPP context");
  }
  return source;
}

function resolvedGrantInput(info: JsonObject, pdpp: JsonObject, detail: JsonObject, source: JsonObject): JsonObject {
  return {
    access_mode: detail.access_mode,
    client: { client_id: pdpp.client_id },
    // Absent-only expiry: omit the field when the token carries no `exp`.
    ...(typeof info.exp === "number" ? { expires_at: new Date(info.exp * 1000).toISOString() } : {}),
    grant_id: pdpp.grant_id,
    issued_at: pdpp.issued_at,
    ...(detail.purpose_description ? { purpose_description: detail.purpose_description } : {}),
    purpose_code: detail.purpose_code,
    ...(detail.retention ? { retention: detail.retention } : {}),
    ...(detail.selection_preset ? { selection_preset: detail.selection_preset } : {}),
    source,
    source_declaration: pdpp.source_declaration,
    streams: detail.streams,
    subject: { id: pdpp.subject_id },
    version: "0.1.0",
  };
}

function parseGrantedContext(info: JsonObject, pdpp: JsonObject, detail: JsonObject, source: JsonObject) {
  try {
    if (pairwiseInstanceIdentityEnabled()) {
      if (
        detail.type !== "https://pdpp.dev/data-access" ||
        Object.keys(detail).some((key) => key !== "type" && key !== "grant")
      ) {
        fail("context.rights_missing", "Granted detail must contain type and grant only");
      }
      const grant = parseCoreResolvedGrant(detail.grant);
      if (grant.grant_id !== pdpp.grant_id || grant.client.client_id !== pdpp.client_id) {
        fail("context.identity_mismatch", "Granted artifact does not match its enforcement binding");
      }
      return { ...grant, subject: { id: String(pdpp.subject_id) } };
    }
    requireGrantedAuthorizationDetailEnvelope(detail);
    return parseCoreResolvedGrant(resolvedGrantInput(info, pdpp, detail, source));
  } catch (cause: unknown) {
    const error = new SourceIntrospectionContextError(
      "context.rights_missing",
      "Granted authorization detail is invalid"
    );
    error.cause = cause;
    throw error;
  }
}

/** Resolve complete client context from one authenticated introspection response. */
export function validatePairwiseInstanceBindings(value: unknown, owner = false): void {
  if (!Array.isArray(value)) { fail("context.instance_mismatch", "Introspection instance bindings are missing"); }
  const instanceTargets = new Map<string, string>();
  const instanceHandles = new Map<string, string>();
  for (const candidate of value) {
    const binding = requireObject(candidate, "context.instance_mismatch", "Instance binding");
    if (
      !(
        typeof binding.source_id === "string" &&
        binding.source_id &&
        typeof binding.instance_id === "string" &&
        binding.instance_id &&
        typeof binding.rs_instance === "string" &&
        binding.rs_instance
      )
    ) {
      fail("context.instance_mismatch", "Malformed instance binding");
    }
    if (owner && binding.stream !== undefined) {
      fail("context.instance_mismatch", "Owner bindings must not contain stream selectors");
    }
    const key = JSON.stringify([binding.source_id, binding.instance_id]);
    const target = JSON.stringify([binding.source_id, binding.rs_instance]);
    if (instanceTargets.has(key) && instanceTargets.get(key) !== binding.rs_instance) {
      fail("context.instance_mismatch", "Instance handle has conflicting storage bindings");
    }
    if (instanceHandles.has(target) && instanceHandles.get(target) !== binding.instance_id) {
      fail("context.instance_mismatch", "Stored instance has conflicting handles");
    }
    instanceTargets.set(key, binding.rs_instance);
    instanceHandles.set(target, binding.instance_id);
  }
}

export function resolveSourceIntrospectionContext(value: unknown): JsonObject {
  const info = requireObject(value, "context.rights_missing", "Introspection response");
  const pdpp = requireBindingContext(info);
  const detail = requireSingleDetail(info);
  const source = requireMatchingSource(detail, pdpp);
  const grant = parseGrantedContext(info, pdpp, detail, source);
  if (pairwiseInstanceIdentityEnabled()) {
    validatePairwiseInstanceBindings(info.pdpp_instance_bindings);
    for (const stream of grant.streams) {
      stream.instance_ids = stream.instance_ids.map((handle) => {
        const matches = (info.pdpp_instance_bindings as unknown[]).filter(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            "source_id" in candidate &&
            candidate.source_id === source.id &&
            "stream" in candidate &&
            candidate.stream === stream.name &&
            "instance_id" in candidate &&
            candidate.instance_id === handle
        );
        const match = matches[0];
        if (
          !(
            matches.length === 1 &&
            match &&
            typeof match === "object" &&
            "rs_instance" in match &&
            typeof match.rs_instance === "string" &&
            match.rs_instance
          )
        ) {
          fail("context.instance_mismatch", "Introspection instance binding is missing or duplicated");
        }
        return match.rs_instance;
      });
    }
  }
  return {
    ...info,
    grant,
    ...(pairwiseInstanceIdentityEnabled() ? { pairwise_source_primary_keys: pdpp.source_primary_keys } : {}),
  };
}

function requireApprovedStream(value: unknown, streamName: string): ResolvedGrantStream {
  const info = requireObject(value, "context.rights_missing", "Resolved authorization context");
  const stream = parseCoreResolvedGrant(info.grant).streams.find((candidate) => candidate.name === streamName);
  return stream ?? fail("context.stream_not_allowed", `Stream '${streamName}' is not approved`);
}

function enforceSelectors(stream: ResolvedGrantStream, request: SourceReadRequest): void {
  if (request.instance_id && !stream.instance_ids.includes(request.instance_id)) {
    fail("context.instance_mismatch", "The requested source instance is not approved");
  }
  if (request.fields?.some((field) => !stream.fields.includes(field))) {
    fail("context.field_not_granted", "The requested field is not approved");
  }
}

/** Enforce request selectors from the response-derived grant before route handling. */
export function enforceSourceReadRequest(value: unknown, request: SourceReadRequest): void {
  const stream = requireApprovedStream(value, request.stream);
  enforceSelectors(stream, request);
}

/** Project the AS-internal grant into the single-rights RFC 7662 wire carrier. */
export function projectSourceIntrospectionWireContext(value: unknown): JsonObject {
  const info = requireObject(value, "context.rights_missing", "Introspection response");
  if (info.pdpp_token_kind !== "client") {
    return { ...info };
  }
  const grant = parseCoreResolvedGrant(pairwiseInstanceIdentityEnabled() ? info.pairwise_grant : info.grant);
  const {
    grant: _internalGrant,
    pairwise_grant: _pairwiseGrant,
    pairwise_source_primary_keys: sourcePrimaryKeys,
    grant_trust_signal: relianceRecord,
    ...bindingAndLifecycle
  } = info;
  return {
    ...bindingAndLifecycle,
    authorization_details: [
      pairwiseInstanceIdentityEnabled()
        ? { grant, type: "https://pdpp.dev/data-access" }
        : buildGrantedAuthorizationDetail(grant),
    ],
    pdpp: {
      client_id: info.client_id,
      context_kind: "oauth_rar_0_1",
      grant_id: info.grant_id,
      issued_at: grant.issued_at,
      source: grant.source,
      source_declaration: grant.source_declaration,
      ...(pairwiseInstanceIdentityEnabled() && sourcePrimaryKeys ? { source_primary_keys: sourcePrimaryKeys } : {}),
      subject_id: info.subject_id,
      // The trust signal the AS relied on to accept this client's identity
      // (spec-core.md#trust-registry-queries). Present only when it relied on one:
      // a relying party has to be able to read back which signal was relied on and
      // when, because a status may be withdrawn after issuance. Absent means the
      // AS relied on no assertion, which is a different claim from an empty one.
      ...(relianceRecord ? { trust_signal: relianceRecord } : {}),
    },
  };
}

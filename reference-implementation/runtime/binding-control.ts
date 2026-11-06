// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NekoBindingScope, PreparedNekoReservation } from "../server/neko-surface-allocator-server.ts";

import {
  bindingResourceReference,
  bindingResourceCleanupReceipt,
  type BindingResourceReference,
  type BindingResourceCleanupReceipt,
} from "./binding-resource-reference.ts";

export const BINDING_CONTROL_PREFIX = "/internal/browser-binding";
const CREDENTIAL_RE = /^[\x21-\x7e]{32,1024}$/;
const MAX_BYTES = 131_072;
export interface BrowserBindingOwnerAction {
  readonly connectionId: string;
  readonly kind: "confirm_browser_access";
  readonly proposalId: string;
}
export class BrowserBindingOwnerActionRequired extends Error {
  readonly action: BrowserBindingOwnerAction;
  constructor(action: BrowserBindingOwnerAction) {
    super("Browser access requires owner confirmation");
    this.action = action;
  }
}
export class BrowserBindingPlacementRefused extends Error {
  readonly failure: {
    readonly code: "unsupported_binding" | "binding_unavailable" | "binding_cleanup_unverified";
    readonly instanceKey: string;
    readonly reason: string;
  };
  constructor(
    instanceKey: string,
    reason: string,
    code: "unsupported_binding" | "binding_unavailable" | "binding_cleanup_unverified" = "unsupported_binding"
  ) {
    super("Required browser binding placement is unsupported");
    this.failure = { code, instanceKey, reason };
  }
}
export class BindingControlError extends Error {
  constructor() {
    super("Browser binding control refused");
  }
}
export function refuseBindingControl(): never {
  throw new BindingControlError();
}
export function controlAuthenticated(header: unknown, credential: string | undefined): boolean {
  if (!(credential && CREDENTIAL_RE.test(credential)) || typeof header !== "string") {
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${credential}`));
}
export interface BindingControlTarget {
  readonly credential: string;
  readonly timeoutMs: number;
  readonly url: string;
}
export function validateControlTarget(target: BindingControlTarget): URL {
  try {
    const url = new URL(target.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ) ||
      !target.credential ||
      !CREDENTIAL_RE.test(target.credential) ||
      !Number.isSafeInteger(target.timeoutMs) ||
      target.timeoutMs < 1 ||
      target.timeoutMs > 30_000
    ) {
      refuseBindingControl();
    }
    return url;
  } catch {
    return refuseBindingControl();
  }
}
export async function readControlBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) {
      refuseBindingControl();
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return refuseBindingControl();
  }
}
export async function postBindingControl(
  target: BindingControlTarget,
  action: string,
  body: unknown,
  deadline: number
): Promise<unknown> {
  const url = validateControlTarget(target);
  if (
    !["prepare", "read", "activate", "cancel", "status", "stop", "dispose", "authorize", "check", "observe", "recover"].includes(
      action
    )
  ) {
    refuseBindingControl();
  }
  const budget = Math.min(target.timeoutMs, deadline - Date.now());
  if (!Number.isFinite(budget) || budget <= 0) {
    refuseBindingControl();
  }
  try {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_BYTES) {
      refuseBindingControl();
    }
    const response = await fetch(new URL(`${BINDING_CONTROL_PREFIX}/${action}`, url), {
      body: payload,
      headers: { Authorization: `Bearer ${target.credential}`, "Content-Type": "application/json" },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(Math.ceil(budget)),
    });
    if (!(response.ok && response.body)) {
      await response.body?.cancel();
      refuseBindingControl();
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        refuseBindingControl();
      }
      chunks.push(chunk);
    }
    if (Date.now() >= deadline) {
      refuseBindingControl();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return refuseBindingControl();
  }
}
export interface BindingActivationContext {
  readonly deadline: number;
  readonly runId: string;
}
export interface BindingActivationPermit extends BindingActivationContext {
  readonly configurationRevision: string;
  readonly containerId: string;
  readonly expiresAt: number;
  readonly generation: string;
  readonly reservationId: string;
}
export function bindingPermit(
  reservation: PreparedNekoReservation,
  context: BindingActivationContext
): BindingActivationPermit {
  return {
    ...context,
    ...reservation.resource,
    expiresAt: reservation.expiresAt,
    reservationId: reservation.reservationId,
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      freezeDeep(item);
    }
    Object.freeze(value);
  }
  return value;
}
function reservationResponse(value: unknown, scope: NekoBindingScope, reservationId?: string): PreparedNekoReservation {
  if (
    !object(value) ||
    value.phase !== "PREPARED" ||
    !nonempty(value.reservationId) ||
    (reservationId !== undefined && value.reservationId !== reservationId) ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    !object(value.scope) ||
    !(["ownerId", "connectionId", "connectorId", "instanceKey"] as const).every(
      (name) => (value.scope as Record<string, unknown>)[name] === scope[name]
    ) ||
    !object(value.resource) ||
    !["containerId", "generation", "configurationRevision", "allocatorId", "deploymentId", "bindingScopeIdentity", "profileIdentity"].every((name) =>
      nonempty((value.resource as Record<string, unknown>)[name])
    ) ||
    !object(value.access)
  ) {
    return refuseBindingControl();
  }
  const { access } = value;
  if (
    ![
      "identity",
      "revision",
      "imageId",
      "networkId",
      "networkName",
      "profileIdentity",
      "launchConfigurationRevision",
      "purpose",
      "effectiveReach",
    ].every((name) => nonempty(access[name])) ||
    access.mechanism !== "neko-docker-reservation" ||
    access.mechanismVersion !== "1" ||
    !["remainingAmbientAccess", "consequentialActions", "requestedOrigins"].every(
      (name) => Array.isArray(access[name]) && access[name].every((item: unknown) => typeof item === "string")
    ) ||
    !Array.isArray(access.channels) ||
    access.channels.length !== 2 ||
    !["browser.navigate", "browser.connect"].every((name) =>
      (access.channels as unknown[]).some(
        (channel) => object(channel) && channel.name === name && channel.coverage === "not_observable"
      )
    )
  ) {
    return refuseBindingControl();
  }
  return freezeDeep(value as unknown as PreparedNekoReservation);
}

export class NekoBindingControlClient {
  readonly #target: BindingControlTarget;
  constructor(target: BindingControlTarget) {
    validateControlTarget(target);
    this.#target = { ...target };
  }
  async recoverStoppedResource(
    reference: BindingResourceReference,
    deadline: number
  ): Promise<BindingResourceCleanupReceipt> {
    const copied = bindingResourceReference(reference);
    return bindingResourceCleanupReceipt(
      await postBindingControl(this.#target, "recover", { reference: copied, deadline }, deadline),
      copied
    );
  }
  /** Call only after the receipt has committed. This releases stopped allocator bookkeeping. */
  async releaseRecoveredResource(input: BindingResourceReference, deadline: number): Promise<void> {
    const reference = bindingResourceReference(input);
    const { ownerId, connectionId, connectorId, instanceKey } = reference;
    const result = await postBindingControl(
      this.#target,
      "dispose",
      { deadline, reservationId: reference.reservationId, scope: { ownerId, connectionId, connectorId, instanceKey } },
      deadline
    );
    if (!object(result) || result.disposed !== true || result.reservationId !== reference.reservationId)
      refuseBindingControl();
  }
  async prepare(
    input: NekoBindingScope & { expiresAt: number; requestedOrigins: readonly string[] },
    deadline: number
  ): Promise<PreparedNekoReservation> {
    return reservationResponse(await postBindingControl(this.#target, "prepare", { deadline, input }, deadline), input);
  }
  async read(reservationId: string, scope: NekoBindingScope, deadline: number): Promise<PreparedNekoReservation> {
    return reservationResponse(
      await postBindingControl(this.#target, "read", { deadline, reservationId, scope }, deadline),
      scope,
      reservationId
    );
  }

  async activate(reservation: PreparedNekoReservation, context: BindingActivationContext): Promise<unknown> {
    return await postBindingControl(
      this.#target,
      "activate",
      { reservationId: reservation.reservationId, scope: reservation.scope, ...context },
      context.deadline
    );
  }
  async status(reservation: PreparedNekoReservation, context: BindingActivationContext) {
    const value = await postBindingControl(
      this.#target,
      "status",
      { reservationId: reservation.reservationId, scope: reservation.scope, ...context },
      context.deadline
    );
    if (
      !object(value) ||
      value.reservationId !== reservation.reservationId ||
      !object(value.resource) ||
      Object.entries(reservation.resource).some(
        ([name, expected]) => (value.resource as Record<string, unknown>)[name] !== expected
      ) ||
      !object(value.surface)
    ) {
      refuseBindingControl();
    }
    return value.surface;
  }
  async stop(reservation: PreparedNekoReservation, deadline: number): Promise<void> {
    const result = await postBindingControl(
      this.#target,
      "stop",
      { deadline, reservationId: reservation.reservationId, scope: reservation.scope },
      deadline
    );
    if (!object(result) || result.stopped !== true || result.reservationId !== reservation.reservationId) {
      refuseBindingControl();
    }
  }
  /** Metadata retirement only; never evidence of physical cleanup. */
  async dispose(reservation: PreparedNekoReservation, deadline: number): Promise<void> {
    const result = await postBindingControl(
      this.#target,
      "dispose",
      { deadline, reservationId: reservation.reservationId, scope: reservation.scope },
      deadline
    );
    if (!object(result) || result.disposed !== true || result.reservationId !== reservation.reservationId) {
      refuseBindingControl();
    }
  }
  async cancel(reservation: PreparedNekoReservation, deadline: number): Promise<void> {
    await postBindingControl(
      this.#target,
      "cancel",
      { deadline, reservationId: reservation.reservationId, scope: reservation.scope },
      deadline
    );
  }
}

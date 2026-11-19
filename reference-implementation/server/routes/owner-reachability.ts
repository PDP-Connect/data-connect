// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Usage } from "@tnunamak/gozar";
import { ReachabilityError } from "../reachability/approvals.ts";
import { projectHostSettings, validateHostSettingsInput } from "../reachability/host-settings.ts";
import type { OperationRecord, ReachabilityOperations } from "../reachability/operations.ts";
import type { ReachabilitySetups } from "../reachability/setups.ts";
import {
  projectCandidate,
  projectConfiguration,
  projectDraft,
  projectInventory,
  projectRoute,
  projectRuntimeReview,
  projectSetupOperation,
} from "../reachability/projection.ts";
import type { ReachabilityService } from "../reachability/service.ts";
import { type StatePathReport, unsafeStatePathCause } from "../reachability/state-paths.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

interface Request {
  body?: unknown;
  params: Record<string, string>;
  query?: Record<string, unknown>;
}
interface Response {
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
  status(code: number): Response;
}
type Handler = (request: Request, response: Response) => Promise<unknown>;
interface App {
  get(path: string, ...args: RouteArg<Handler>[]): unknown;
  post(path: string, ...args: RouteArg<Handler>[]): unknown;
}
export type OwnerReachabilityContext = {
  service: ReachabilityService | null;
  operations: ReachabilityOperations;
  setups: ReachabilitySetups;
  requireToken: MiddlewareHandler;
  requireOwner: MiddlewareHandler;
  requireCsrf: MiddlewareHandler;
  usage: (kind: string) => Usage;
  /** The folders Gozar's safety check refuses, and the one repair for those inside the data directory. */
  statePaths?: { inspect: () => Promise<StatePathReport>; fix: () => Promise<StatePathReport> };
  /** Whether the owner has chosen a password. Absent where remote access is not hosted. */
  passwordSet?: () => Promise<boolean>;
};
const safeCodes = new Set([
  "host_policy_denied",
  "artifact_integrity_failed",
  "verification_failed",
  "requirements_unsatisfied",
  "consent_required",
  "consent_unknown",
  "configuration_migration_required",
  "internal_error",
  "ambiguous_selection",
  "operation_in_progress",
  "operation_conflict",
  "operation_recovery_unauthorized",
  "operation_not_found",
  "host_supervisor_unavailable",
  "host_runtime_unavailable",
  "consent_details_unavailable",
  "invalid_input",
  "draft_not_found",
  "draft_read_required",
  "draft_read_unavailable",
  "draft_scope_mismatch",
  "configuration_stale",
  "configuration_in_use",
  "consent_kind_mismatch",
  "consent_changed",
  "consent_expired",
  "consent_mismatch",
  "candidate_stale",
  "review_not_found",
  "setup_required",
  "setup_scope_mismatch",
  "setup_action_unavailable",
  "setup_configuration_inconsistent",
  "secret_input_unavailable",
  "secret_reference_inconsistent",
  "secret_backend_locked",
  "secret_backend_unavailable",
  "secret_in_use",
  "clear_input_unavailable",
  "route_generation_mismatch",
  "route_not_found",
  "provider_unavailable",
  "proof_refresh_unsupported",
  "embedding_contract_unavailable",
  "owner_password_required",
  "host_path_too_long",
  "remote_disconnect_acknowledgment_required",
  "unsupported",
  "cleanup_debt",
  "operation_superseded",
  "unsafe_state_path",
]);
export function publicReachabilityError(error: unknown): { code: string; message: string } {
  const candidate =
    unsafeStatePathCause(error) ? "unsafe_state_path" : error && typeof error === "object" && "code" in error ? error.code : null;
  const code = typeof candidate === "string" && safeCodes.has(candidate) ? candidate : "reachability_unavailable";
  // Never echo raw messages, causes or arbitrary error properties.
  return {
    code,
    message:
      code === "proof_refresh_unsupported"
        ? "This route cannot safely refresh its proof. It remains unpublished. Stop it before starting a new route."
        : "The reachability operation could not complete. Review its current state before retrying.",
  };
}
function body(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new ReachabilityError("invalid_input");
  }
  return request.body as Record<string, unknown>;
}
function text(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new ReachabilityError("invalid_input");
  }
  return input;
}
function boundedIdentifier(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 200 || /[^A-Za-z0-9._:-]/.test(input)) {
    throw new ReachabilityError("invalid_input");
  }
  return input;
}
function generation(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new ReachabilityError("invalid_input");
  }
  return input as number;
}
export function mountOwnerReachability(app: App, ctx: OwnerReachabilityContext): void {
  function service(): ReachabilityService {
    if (!ctx.service) {
      throw new ReachabilityError("host_runtime_unavailable");
    }
    return ctx.service;
  }
  // Attribution is bound to the journaled creation, never the current selection.
  type Route = Parameters<typeof projectRoute>[0];
  type Records = Map<string, Promise<OperationRecord | null>>;
  // True when a settled stop the owner asked for names this route's handle. Unknown (undefined) when
  // the operation records were not read, so a caller never reads "no stop" from a missing list.
  const ownerStopped = (route: Route, known: OperationRecord[] | undefined) =>
    known === undefined
      ? undefined
      : known.some(
          (record) =>
            record.kind === "stop" &&
            record.stage === "settled" &&
            record.failureCode === null &&
            record.handle?.id === route.handle.id &&
            record.handle.generation === route.handle.generation
        );
  async function projectOwnedRoute(route: Route, records: Records = new Map(), stopped?: boolean) {
    let journaled: { providerId: string | null; approvedConsentFactsDigest: string | null } | null = null;
    if (route.operationId) {
      let pending = records.get(route.operationId);
      if (!pending) {
        pending = Promise.resolve().then(() => ctx.operations.read(route.operationId!)).catch(() => null);
        records.set(route.operationId, pending);
      }
      const record = await pending;
      // The one identity check: only the start record that created this exact handle speaks for the route.
      if (record?.kind === "start" && record.operationId === route.operationId &&
          record.handle?.kind === route.handle.kind && record.handle.id === route.handle.id &&
          record.handle.generation === route.handle.generation) {
        const nonEmpty = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
        journaled = {
          providerId: nonEmpty(record.intent?.providerId),
          approvedConsentFactsDigest: nonEmpty(record.intent?.consentFactsDigest),
        };
      }
    }
    return { ...projectRoute(route, journaled), ...(stopped === undefined ? {} : { stopRequested: stopped }) };
  }
  function projectRoutes(routes: Route[], known?: OperationRecord[]) {
    const records: Records = new Map((known ?? []).map((record) => [record.operationId, Promise.resolve(record)]));
    return Promise.all(routes.map((route) => projectOwnedRoute(route, records, ownerStopped(route, known))));
  }
  const guarded = [ctx.requireToken, ctx.requireOwner];
  function get(path: string, run: (request: Request) => Promise<unknown>) {
    app.get(`/v1/owner/reachability${path}`, ...guarded, wrap(run));
  }
  function post(path: string, run: (request: Request) => Promise<unknown>) {
    app.post(`/v1/owner/reachability${path}`, ...guarded, ctx.requireCsrf, wrap(run));
  }
  function wrap(run: (request: Request) => Promise<unknown>): Handler {
    return async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const data = await run(request);
        if (data && typeof data === "object" && "operationId" in data && !("stage" in data) && !("revision" in data)) {
          response.status(202);
        }
        return response.json({ data });
      } catch (error) {
        return response.status(409).json({ error: publicReachabilityError(error) });
      }
    };
  }
  get("/operations/:id", async (request) => {
    const record = await ctx.operations.read(text(request.params.id));
    return {
      failureCode: record.failureCode,
      handle: record.handle
        ? { id: record.handle.id, kind: record.handle.kind, generation: record.handle.generation }
        : null,
      kind: record.kind,
      operationId: record.operationId,
      recovery: record.recovery ? { available: record.recovery.available, reason: record.recovery.reason } : null,
      route: null,
      stage: record.stage,
    };
  });
  post("/operations/:id/reconcile", async (request) => {
    const input = body(request);
    if (input.action !== "check" && input.action !== "stop") {
      throw new ReachabilityError("invalid_input");
    }
    const current = service();
    const id = text(request.params.id);
    const terminal = await current.observeOperationRecovery(await ctx.operations.read(id));
    if (input.action === "stop") {
      await current.authorizeDisconnect(input.acknowledgeDisconnect === true);
    }
    if (terminal) return projectOwnedRoute(terminal);
    if (input.action === "stop") {
      await ctx.operations.requestStop(id);
    }
    const record = await ctx.operations.read(id);
    const route = record.handle
      ? await current.reconcileKnownHandle(record.handle, record.stopTombstone)
      : await current.recoverOperation(
          record,
          input.action,
          record.stopTombstone || input.acknowledgeDisconnect === true,
          record.stopTombstone
        );
    await ctx.operations.recordRecovered(record.operationId, route);
    return projectOwnedRoute(route);
  });
  function setupReference(request: Request, providerId: unknown) {
    return { operationId: text(request.params.id), providerId: text(providerId) };
  }
  function setupCommand(input: Record<string, unknown>) {
    return {
      actionId: text(input.actionId),
      expectedConfigurationRevision: text(input.expectedConfigurationRevision),
      expectedSetupRevision: generation(input.expectedSetupRevision),
      acknowledgeDisconnect: input.acknowledgeDisconnect === true,
      ...(input.draftId === undefined ? {} : { draftId: text(input.draftId) }),
      ...(input.approval === undefined ? {} : { approval: input.approval }),
      ...(input.value === undefined ? {} : { value: text(input.value) }),
      ...(input.secret === undefined ? {} : { secret: text(input.secret) }),
    };
  }
  // A cancelled setup with nothing left to remove has ended: forget it.
  async function settled(view: ReturnType<typeof projectSetupOperation>) {
    const removing = view.resources.some((item) => item.removal === "required" || item.removal === "unconfirmed");
    if (view.state === "cancelled" && !removing) await ctx.setups.dropSetup(view.operationId);
    return view;
  }
  get("/setup-operations/:id", async (request) =>
    settled(projectSetupOperation(await service().readSetupOperation(setupReference(request, request.query?.providerId))))
  );
  post("/setup-operations/:id", async (request) => {
    const input = body(request);
    return projectSetupOperation(await service().runSetupOperation(setupReference(request, input.providerId), setupCommand(input)));
  });
  post("/setup-operations/:id/cancel", async (request) =>
    settled(projectSetupOperation(await service().cancelSetupOperation(setupReference(request, body(request).providerId))))
  );
  // Starts a service's setup. A service has one setup: calling this again resumes it.
  post("/setups", async (request) => {
    const input = body(request);
    const current = service();
    const providerId = text(input.providerId);
    const draftId = text(input.draftId);
    const actionId = text(input.actionId);
    const expectedConfigurationRevision = text(input.expectedConfigurationRevision);
    const usage = typeof input.usage === "string" && input.usage ? input.usage : null;
    const known = await ctx.setups.get(providerId);
    const { entry, created } = await ctx.setups.reserveSetup({
      providerId,
      providerLabel: known?.providerLabel ?? (await current.providerLabel(providerId)),
      draftId,
      usage,
      actionId,
      expectedConfigurationRevision,
    });
    const operationId = entry.setup!.operationId;
    // The id is saved before the effect runs, so a retry reuses it.
    const view = created
      ? await current.runSetupOperation(
          { operationId, providerId },
          { actionId, expectedConfigurationRevision, expectedSetupRevision: 0, draftId: entry.draftId ?? draftId }
        )
      : await current.readSetupOperation({ operationId, providerId });
    return { created, entry, view: await settled(projectSetupOperation(view)) };
  });
  // One-time takeover of a setup an older console kept in the browser.
  post("/setups/adopt", async (request) => {
    const input = body(request);
    const providerId = text(input.providerId);
    const operationId = text(input.operationId);
    let view: ReturnType<typeof projectSetupOperation>;
    try {
      view = projectSetupOperation(await service().readSetupOperation({ operationId, providerId }));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "route_not_found") {
        return { adopted: false, reason: "unknown" };
      }
      throw error;
    }
    const removing = view.resources.some((item) => item.removal === "required" || item.removal === "unconfirmed");
    if (view.state === "cancelled" && !removing) return { adopted: false, reason: "ended" };
    const { adopted } = await ctx.setups.adoptSetup({
      providerId,
      providerLabel: text(input.providerLabel),
      draftId: text(input.draftId),
      usage: typeof input.usage === "string" && input.usage ? input.usage : null,
      committed: false,
      setup: {
        operationId,
        actionId: text(input.actionId),
        expectedConfigurationRevision: text(input.expectedConfigurationRevision),
      },
    });
    if (adopted) return { adopted: true };
    const known = await ctx.setups.get(providerId);
    if (known?.setup?.operationId === operationId) return { adopted: true };
    // A second live setup for this service. The host still holds it, so it is
    // cancelled if the host can do that with nothing left to remove. If not,
    // the journal keeps its id as a leftover that needs cleaning up.
    try {
      const cancelled = projectSetupOperation(await service().cancelSetupOperation({ operationId, providerId }));
      const leftover = cancelled.resources.some((item) => item.removal === "required" || item.removal === "unconfirmed");
      if (cancelled.state === "cancelled" && !leftover) return { adopted: false, reason: "cancelled" };
    } catch {
      // The host could not cancel it. Treat it as a leftover below.
    }
    await ctx.setups.addCleanup({ providerId, providerLabel: text(input.providerLabel), operationId });
    return { adopted: false, reason: "needs_cleanup" };
  });
  // One-time takeover of a draft an older console kept in the browser.
  post("/setups/adopt-draft", async (request) => {
    const input = body(request);
    const providerId = text(input.providerId);
    const draftId = text(input.draftId);
    try {
      await service().reload(providerId, draftId);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "draft_not_found") {
        return { adopted: false, reason: "unknown" };
      }
      throw error;
    }
    const { adopted } = await ctx.setups.adoptDraft({
      providerId,
      providerLabel: (await ctx.setups.get(providerId))?.providerLabel ?? (await service().providerLabel(providerId)),
      draftId,
      usage: typeof input.usage === "string" && input.usage ? input.usage : null,
    });
    return adopted ? { adopted: true } : { adopted: false, reason: "service_has_draft" };
  });
  post("/setup-operations/:id/handoff", async (request) => {
    const input = body(request);
    return service().setupHandoff(setupReference(request, input.providerId), setupCommand(input));
  });
  get("/host-capabilities", async () => service().capabilities());
  get("/state-paths", async () => {
    if (!ctx.statePaths) throw new ReachabilityError("host_runtime_unavailable");
    return ctx.statePaths.inspect();
  });
  post("/state-paths/fix", async () => {
    if (!ctx.statePaths) throw new ReachabilityError("host_runtime_unavailable");
    return ctx.statePaths.fix();
  });
  get("/host-settings", async () => {
    const observation = await service().hostSettings();
    return observation.known
      ? { known: true, value: projectHostSettings(observation.value) }
      : { known: false, reason: observation.reason };
  });
  post("/host-settings", async (request) => {
    const input = body(request);
    return projectHostSettings(
      await service().applyHostSettings(
        validateHostSettingsInput({ expectedRevision: input.expectedRevision, mode: input.mode, port: input.port }),
        input.acknowledgeDisconnect === true
      )
    );
  });
  get("/catalog", async () => projectInventory(await service().inventory()));
  get("/events", async () => {
    const state = service().state();
    return {
      evidenceSource: state.evidenceSource,
      lifecycle: state.lifecycle,
      reasons: state.reasons,
      routes: await projectRoutes(state.routes),
      type: "snapshot",
    };
  });
  get("/state", async () => {
    const state = service().state();
    const records = await ctx.operations.list();
    const operations = records
      .filter((record) => record.stage !== "settled")
      .map((record) => ({
        failureCode: record.failureCode,
        handle: record.handle ? { id: record.handle.id, kind: record.handle.kind, generation: record.handle.generation } : null,
        kind: record.kind,
        operationId: record.operationId,
        recovery: record.recovery ? { available: record.recovery.available, reason: record.recovery.reason } : null,
        stage: record.stage,
      }));
    return {
      evidenceSource: state.evidenceSource,
      lifecycle: state.lifecycle,
      operations,
      reasons: state.reasons,
      routes: await projectRoutes(state.routes, records),
      passwordSet: ctx.passwordSet ? await ctx.passwordSet() : true,
      services: await ctx.setups.list(),
      starting: state.starting,
    };
  });
  get("/drafts/:id", async (request) =>
    projectDraft(await service().reload(text(request.query?.providerId), text(request.params.id)))
  );
  // Per-router single flight includes the journal read, host effect and durable record.
  // Once settled, a later request follows the normal resume path below.
  const draftFlights = new Map<string, Promise<ReturnType<typeof projectDraft>>>();
  // A service has one draft. Asking again for a service that has one resumes it.
  post("/drafts", async (request) => {
    const input = body(request);
    const current = service();
    const providerId = text(input.providerId);
    const usage = typeof input.usage === "string" && input.usage ? input.usage : null;
    const pending = draftFlights.get(providerId);
    if (pending) return pending;
    const flight = (async () => {
      const known = await ctx.setups.get(providerId);
      if (known?.draftId && !known.committed) {
        try {
          const draft = await current.resume(providerId, known.draftId);
          await ctx.setups.recordDraft({ providerId, providerLabel: known.providerLabel, draftId: known.draftId, usage });
          return projectDraft(draft);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "draft_not_found")) throw error;
          // The draft no longer exists on the host: start a fresh one below.
        }
      }
      const draft = await current.begin(providerId, text(input.expectedRevision));
      await ctx.setups.recordDraft({
        providerId,
        providerLabel: known?.providerLabel ?? (await current.providerLabel(providerId)),
        draftId: draft.draftId,
        usage,
      });
      return projectDraft(draft);
    })();
    draftFlights.set(providerId, flight);
    try {
      return await flight;
    } finally {
      draftFlights.delete(providerId);
    }
  });
  post("/drafts/:id/actions/:actionId", async (request) => {
    const input = body(request);
    if (input.value !== undefined && typeof input.value !== "string") {
      throw new ReachabilityError("invalid_input");
    }
    if (input.secret !== undefined && typeof input.secret !== "string") {
      throw new ReachabilityError("invalid_input");
    }
    return projectConfiguration(
      await service().setup(text(request.params.id), {
        actionId: text(request.params.actionId),
        approval: input.approval,
        expectedRevision: text(input.expectedRevision),
        ...(typeof input.value === "string" ? { value: input.value } : {}),
        ...(typeof input.secret === "string" ? { secret: input.secret } : {}),
      })
    );
  });
  post("/drafts/:id/clear/:actionId", async (request) => {
    const input = body(request);
    return projectConfiguration(
      await service().clear(text(request.params.id), {
        actionId: text(request.params.actionId),
        approval: input.approval,
        expectedRevision: text(input.expectedRevision),
      })
    );
  });
  post("/drafts/:id/discard", async (request) => {
    const result = await service().discard(text(request.params.id));
    await ctx.setups.dropDraft(text(request.params.id));
    return result;
  });
  post("/drafts/:id/commit", async (request) => {
    const configuration = projectConfiguration(
      await service().commit(text(request.params.id), text(body(request).expectedRevision))
    );
    await ctx.setups.markCommitted(text(request.params.id));
    return configuration;
  });
  post("/drafts/:id/review", async (request) => {
    const review = await service().review(text(request.params.id), ctx.usage(text(body(request).usage)));
    return { candidate: projectCandidate(review.candidate), id: review.id, kind: "route" };
  });
  post("/operations", async (request) => {
    const input = body(request);
    const current = service();
    const reviewId = boundedIdentifier(input.reviewId);
    const digest = boundedIdentifier(input.consentFactsDigest);
    if (input.kind !== "route") {
      throw new ReachabilityError("consent_kind_mismatch");
    }
    // The review id and the digest the owner approved. Neither is a secret, so
    // a log reader can compare them with what the screen showed.
    console.info(`[reachability] approve reviewId=${reviewId} consentFactsDigest=${digest}`);
    await current.authorizeDisconnect(input.acknowledgeDisconnect === true);
    // Consent is checked here, before the 202: a review that expired or changed
    // is refused now, so the console can fetch a new one. Apply checks again.
    await current.precheckApply(reviewId, { consentFactsDigest: digest, kind: "route" });
    return ctx.operations.start(
      "start",
      null,
      async (operationId) =>
        current.apply(operationId, reviewId, {
          acknowledgeDisconnect: input.acknowledgeDisconnect === true,
          consentFactsDigest: digest,
          kind: "route",
        }),
      current.operationIntent(reviewId)
    );
  });
  post("/routes/:id/check", async (request) =>
    projectOwnedRoute(await service().check(text(request.params.id), generation(body(request).generation)))
  );
  post("/routes/:id/stop", async (request) => {
    const input = body(request);
    const current = service(),
      id = text(request.params.id),
      expected = generation(input.generation);
    const handle = current.routeReference(id, expected);
    await current.authorizeDisconnect(input.acknowledgeDisconnect === true);
    // A stop whose close did not confirm still settles: the route keeps its cleanup debt
    // and retry action, and the journal records that cleanup did not confirm.
    return ctx.operations.start("stop", handle, async () =>
      current.stop(id, expected, input.acknowledgeDisconnect === true)
    );
  });
  post("/routes/:id/review", async (request) =>
    projectRuntimeReview(await service().reviewRuntime(text(request.params.id), generation(body(request).generation)))
  );
  post("/routes/:id/approve", async (request) => {
    const input = body(request);
    if (input.kind !== "route") {
      throw new ReachabilityError("consent_kind_mismatch");
    }
    return projectOwnedRoute(
      await service().approveRuntime(
        text(request.params.id),
        generation(input.generation),
        text(input.consentFactsDigest)
      )
    );
  });
}

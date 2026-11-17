// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Usage } from "@tnunamak/gozar";
import { ReachabilityError } from "../reachability/approvals.ts";
import { projectHostSettings, validateHostSettingsInput } from "../reachability/host-settings.ts";
import type { ReachabilityOperations } from "../reachability/operations.ts";
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
  requireToken: MiddlewareHandler;
  requireOwner: MiddlewareHandler;
  requireCsrf: MiddlewareHandler;
  usage: (kind: string) => Usage;
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
  "remote_disconnect_acknowledgment_required",
  "unsupported",
  "cleanup_debt",
  "operation_superseded",
]);
export function publicReachabilityError(error: unknown): { code: string; message: string } {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : null;
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
    if (input.action === "stop") await ctx.operations.requestStop(text(request.params.id));
    const record = await ctx.operations.read(text(request.params.id));
    const route = record.handle
      ? await service().reconcileKnownHandle(record.handle, record.stopTombstone || input.action === "stop")
      : await service().recoverOperation(
          record.operationId,
          input.action,
          input.acknowledgeDisconnect === true,
          record.stopTombstone
        );
    await ctx.operations.recordRecovered(record.operationId, route);
    return projectRoute(route);
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
  get("/setup-operations/:id", async (request) =>
    projectSetupOperation(await service().readSetupOperation(setupReference(request, request.query?.providerId)))
  );
  post("/setup-operations/:id", async (request) => {
    const input = body(request);
    return projectSetupOperation(await service().runSetupOperation(setupReference(request, input.providerId), setupCommand(input)));
  });
  post("/setup-operations/:id/cancel", async (request) =>
    projectSetupOperation(await service().cancelSetupOperation(setupReference(request, body(request).providerId)))
  );
  post("/setup-operations/:id/handoff", async (request) => {
    const input = body(request);
    return service().setupHandoff(setupReference(request, input.providerId), setupCommand(input));
  });
  get("/host-capabilities", async () => service().capabilities());
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
      routes: state.routes.map(projectRoute),
      type: "snapshot",
    };
  });
  get("/state", async () => {
    const state = service().state();
    const operations = (await ctx.operations.list())
      .filter((record) => record.stage !== "settled")
      .map((record) => ({
        failureCode: record.failureCode,
        operationId: record.operationId,
        recovery: record.recovery ? { available: record.recovery.available, reason: record.recovery.reason } : null,
        stage: record.stage,
      }));
    return {
      evidenceSource: state.evidenceSource,
      lifecycle: state.lifecycle,
      operations,
      reasons: state.reasons,
      routes: state.routes.map(projectRoute),
      starting: state.starting,
    };
  });
  get("/drafts/:id", async (request) =>
    projectDraft(await service().reload(text(request.query?.providerId), text(request.params.id)))
  );
  post("/drafts", async (request) => {
    const input = body(request);
    return projectDraft(await service().begin(text(input.providerId), text(input.expectedRevision)));
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
  post("/drafts/:id/discard", async (request) => service().discard(text(request.params.id)));
  post("/drafts/:id/commit", async (request) =>
    projectConfiguration(await service().commit(text(request.params.id), text(body(request).expectedRevision)))
  );
  post("/drafts/:id/review", async (request) => {
    const review = await service().review(text(request.params.id), ctx.usage(text(body(request).usage)));
    return { candidate: projectCandidate(review.candidate), id: review.id, kind: "route" };
  });
  post("/operations", async (request) => {
    const input = body(request);
    const current = service();
    const reviewId = text(input.reviewId);
    const digest = text(input.consentFactsDigest);
    if (input.kind !== "route") {
      throw new ReachabilityError("consent_kind_mismatch");
    }
    await current.authorizeDisconnect(input.acknowledgeDisconnect === true);
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
    projectRoute(await service().check(text(request.params.id), generation(body(request).generation)))
  );
  post("/routes/:id/stop", async (request) => {
    const input = body(request);
    const current = service(),
      id = text(request.params.id),
      expected = generation(input.generation);
    const handle = current.routeReference(id, expected);
    await current.authorizeDisconnect(input.acknowledgeDisconnect === true);
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
    return projectRoute(
      await service().approveRuntime(
        text(request.params.id),
        generation(input.generation),
        text(input.consentFactsDigest)
      )
    );
  });
}

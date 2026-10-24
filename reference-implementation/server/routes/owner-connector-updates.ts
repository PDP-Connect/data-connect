// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ConnectorUpdateService } from "../connector-install/update-service.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

interface Request {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}
interface Response {
  json: (body: unknown) => unknown;
  status: (status: number) => Response;
}
type Handler = (request: Request, response: Response) => Promise<void>;
interface App {
  get: (path: string, ...handlers: RouteArg<Handler>[]) => App;
  post: (path: string, ...handlers: RouteArg<Handler>[]) => App;
}

export function mountOwnerConnectorUpdates(
  app: App,
  options: {
    service: ConnectorUpdateService;
    requireOwner: MiddlewareHandler;
    requireToken: MiddlewareHandler;
    pdppError: PdppErrorFn;
    handleError: (response: unknown, error: unknown) => void;
  }
): void {
  const guards = [options.requireToken, options.requireOwner] as const;
  const wrap =
    (handler: Handler): Handler =>
    async (request, response) => {
      try {
        await handler(request, response);
      } catch (error) {
        const known = error as { statusCode?: number; code?: string; message?: string };
        if (known.statusCode && known.code) {
          options.pdppError(response, known.statusCode, known.code, known.message ?? known.code);
        } else {
          options.handleError(response, error);
        }
      }
    };
  const root = "/v1/owner/connector-updates";
  app.post(
    `${root}/plans`,
    ...guards,
    wrap(async (_request, response) => {
      const created = await options.service.createPlan();
      response.status(202).json({ data: created, object: "connector_update_plan" });
    })
  );
  app.get(
    `${root}/plans/:id`,
    ...guards,
    wrap(async (request, response) => {
      const plan = await options.service.getPlan(request.params?.id ?? "");
      response.json({ data: plan, object: "connector_update_plan" });
    })
  );
  app.post(
    `${root}/plans/:id/consents`,
    ...guards,
    wrap(async (request, response) => {
      const { connector_id, target_digest, ...unknown } = request.body ?? {};
      if (typeof connector_id !== "string" || typeof target_digest !== "string" || Object.keys(unknown).length) {
        options.pdppError(response, 400, "invalid_request", "Expected connector_id and exact target_digest.");
        return;
      }
      const consent = await options.service.issueConsent({
        connector_id,
        plan_id: request.params?.id ?? "",
        target_digest,
      });
      response.status(201).json({ data: consent, object: "connector_update_consent" });
    })
  );
  app.post(
    `${root}/batches`,
    ...guards,
    wrap(async (request, response) => {
      const { plan_id, idempotency_key, selected_connector_ids, consent_token, ...unknown } = request.body ?? {};
      if (
        typeof plan_id !== "string" ||
        typeof idempotency_key !== "string" ||
        (selected_connector_ids !== undefined &&
          !(
            Array.isArray(selected_connector_ids) &&
            selected_connector_ids.every((id) => typeof id === "string" && id.trim())
          )) ||
        (consent_token !== undefined && typeof consent_token !== "string") ||
        Object.keys(unknown).length
      ) {
        options.pdppError(
          response,
          400,
          "invalid_request",
          "Expected plan_id, idempotency_key and optional selected_connector_ids or consent_token; automatic triggers are unavailable."
        );
        return;
      }
      const created = await options.service.createBatch({
        idempotency_key,
        plan_id,
        ...(consent_token === undefined ? {} : { consent_token }),
        ...(selected_connector_ids === undefined ? {} : { selected_connector_ids: selected_connector_ids as string[] }),
      });
      response.status(202).json({ data: created, object: "connector_update_batch" });
    })
  );
  app.get(
    `${root}/batches/:id`,
    ...guards,
    wrap(async (request, response) => {
      const batch = await options.service.getBatch(request.params?.id ?? "");
      response.json({ data: batch, object: "connector_update_batch" });
    })
  );
}

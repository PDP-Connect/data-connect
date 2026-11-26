// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReachabilityService } from "../reachability/service.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

interface Response {
  json(value: unknown): unknown;
  status(code: number): Response;
}
type Handler = (request: unknown, response: Response) => unknown;
interface App {
  get(path: string, ...args: RouteArg<Handler>[]): unknown;
  post(path: string, ...args: RouteArg<Handler>[]): unknown;
}
export interface MountOwnerRemoteAccessContext {
  requireCsrf: MiddlewareHandler;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  service: ReachabilityService | null;
}

// This facade never reads the mixed legacy credential file. An unknown/new
// provider is not representable in the old schema and must never look healthy.
export function mountOwnerRemoteAccess(app: App, ctx: MountOwnerRemoteAccessContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner];
  const conflict: Handler = (_request, response) =>
    response.status(409).json({
      error: {
        code: "reachability_v2_required",
        message: "Use the reachability settings to inspect or change this instance.",
      },
    });
  app.get("/v1/owner/remote-access/config", ...guarded, (_request: unknown, response: Response) => {
    const state = ctx.service?.state();
    if (
      !(state && state.lifecycle.confinement.known && state.lifecycle.confinement.value) ||
      state.starting ||
      state.routes.some((route) => route.cleanup.state !== "confirmed")
    ) {
      return conflict(_request, response);
    }
    return response.json({
      data: {
        console_port: null,
        fields: {
          PDPP_BIND_HOST: "127.0.0.1",
          PDPP_REFERENCE_ORIGIN: "",
          PDPP_TRUSTED_HOSTS: "",
          PDPP_TRUSTED_PROXIES: "",
        },
        posture: "off",
        provider: null,
      },
      object: "remote_access_config",
    });
  });
  for (const path of ["config", "console-port"]) {
    app.post(`/v1/owner/remote-access/${path}`, ...guarded, ctx.requireCsrf, conflict);
  }
  app.get("/v1/owner/remote-access/inspect", ...guarded, conflict);
  app.get("/v1/owner/remote-access/inspect/:providerId", ...guarded, conflict);
}

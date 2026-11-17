// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { GozarOptions as EmbeddingFactoryOptions } from "@tnunamak/gozar";

type EmbeddingApi = ReturnType<typeof import("@tnunamak/gozar").createGozar>;

import { ReachabilityError } from "./approvals.ts";
import { type HostPolicy, ReachabilityService } from "./service.ts";

// Actual controller-incarnation identity comes from the trusted supervisor.
// Do not call this with a cached app/factory boot ID after controller replacement.
export async function createReachabilityService(
  options: EmbeddingFactoryOptions,
  host: Omit<HostPolicy, "identity" | "hostCapabilities">
): Promise<ReachabilityService> {
  const { createGozar } = await import("@tnunamak/gozar");
  if (!(options.identity && options.secretBackend && options.hostCapabilities)) {
    throw new ReachabilityError("host_configuration_required");
  }
  const api = createGozar(options);
  const methods: (keyof EmbeddingApi)[] = [
    "listRoutes",
    "listProviders",
    "beginConfigurationDraft",
    "readConfigurationDraft",
    "commitConfigurationDraft",
    "discardConfigurationDraft",
    "clearConfigurationInput",
    "storeSecret",
    "discardSecret",
    "runSetupAction",
    "readSetupOperation",
    "cancelSetupOperation",
    "reviewRouteConsent",
    "approveRouteConsent",
    "catalogRoutes",
    "expose",
    "ensureRoute",
    "routeStatus",
    "closeRoute",
    "watchRoutes",
  ];
  if (methods.some((method) => typeof api[method] !== "function")) {
    throw new ReachabilityError("embedding_contract_unavailable");
  }
  return new ReachabilityService(api, {
    ...host,
    hostCapabilities: options.hostCapabilities,
    identity: options.identity,
  });
}

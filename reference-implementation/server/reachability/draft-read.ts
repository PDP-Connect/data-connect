// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { ConfigurationDraft as Draft } from "@tnunamak/gozar";

import { ReachabilityError } from "./approvals.ts";

// Single seam for the public draft read, including reload/restart.
// No catalog fallback, scope reconstruction or action reuse is permitted.
export async function readConfigurationDraft(
  api: {
    readConfigurationDraft?: (request: {
      home: string;
      owner?: string;
      providerId: string;
      draftId: string;
    }) => Promise<Draft>;
  },
  request: { home: string; owner?: string; providerId: string; draftId: string }
): Promise<Draft> {
  if (!api.readConfigurationDraft) {
    throw new ReachabilityError("draft_read_unavailable");
  }
  return api.readConfigurationDraft(request);
}

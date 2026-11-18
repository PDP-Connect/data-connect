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
  try {
    return await api.readConfigurationDraft(request);
  } catch (error) {
    // The read names no revision, so the library can only call a draft stale when it
    // does not hold it: a commit consumed it, a discard removed it, or it never existed.
    if (error && typeof error === "object" && "code" in error && error.code === "configuration_stale") {
      throw new ReachabilityError("draft_not_found");
    }
    throw error;
  }
}

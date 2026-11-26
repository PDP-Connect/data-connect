// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  ConfigurationDraft as Draft,
  Configuration as ProviderConfiguration,
  Action as SetupAction,
  SetupActionResult as SetupResult,
} from "@tnunamak/gozar";

import { ReachabilityError } from "./approvals.ts";
import { readConfigurationDraft } from "./draft-read.ts";

export function configurationFromSetup(result: SetupResult): ProviderConfiguration {
  const config = result.configuration;
  if (!config || config.revision !== result.configurationRevision || config.scopeId !== result.scopeId) {
    throw new ReachabilityError("setup_configuration_inconsistent");
  }
  return config;
}

// One host-owned cache per draft. A failed or pending mutation invalidates held
// approvals too: only a fresh public snapshot can offer the next action.
export class ConfigurationDraftSession {
  private current: Draft | null;
  constructor(draft: Draft | null) {
    this.current = draft;
  }
  get snapshot(): Draft {
    if (!this.current) {
      throw new ReachabilityError("draft_read_required");
    }
    return this.current;
  }
  action(actionId: string, expectedRevision: string): SetupAction {
    const config = this.snapshot.configuration;
    if (config.revision !== expectedRevision) {
      throw new ReachabilityError("configuration_stale");
    }
    const matches = config.actions.filter((action: SetupAction) => action.id === actionId);
    if (matches.length !== 1 || !matches[0]) {
      throw new ReachabilityError("setup_action_unavailable");
    }
    const action = matches[0];
    if (action.consent?.scope.kind !== "setup") {
      throw new ReachabilityError("setup_scope_mismatch");
    }
    if (
      action.consent.scope.draftId !== this.snapshot.draftId ||
      action.consent.scope.configurationRevision !== config.revision ||
      action.consent.scope.scopeId !== config.scopeId
    ) {
      throw new ReachabilityError("setup_scope_mismatch");
    }
    return action;
  }
  invalidate(): void {
    this.current = null;
  }
  acceptSetup(previous: Draft, result: SetupResult): void {
    this.current = null;
    const configuration = configurationFromSetup(result);
    if (configuration.scopeId !== previous.scopeId) {
      throw new ReachabilityError("setup_scope_mismatch");
    }
    this.current = { ...previous, configuration };
  }
  acceptClear(previous: Draft, configuration: ProviderConfiguration): void {
    this.current = null;
    if (configuration.scopeId !== previous.scopeId) {
      throw new ReachabilityError("setup_scope_mismatch");
    }
    this.current = { ...previous, configuration };
  }
  async reload(
    api: Parameters<typeof readConfigurationDraft>[0],
    request: Parameters<typeof readConfigurationDraft>[1]
  ): Promise<Draft> {
    this.current = null;
    const draft = await readConfigurationDraft(api, request);
    if (draft.draftId !== request.draftId || draft.scopeId !== draft.configuration.scopeId) {
      throw new ReachabilityError("draft_scope_mismatch");
    }
    this.current = draft;
    return draft;
  }
}

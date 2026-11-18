// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
  ConfigurationDraft as Draft,
  Handle,
  InputRequirement,
  Configuration as ProviderConfiguration,
  ProviderInventory,
  Query,
  RunSetupOperationRequest,
  SetupOperation,
  SetupOperationRef,
  RouteView as Route,
  Candidate as RouteCandidate,
} from "@tnunamak/gozar";
import type { HostSettingsBridge } from "./host-settings.ts";
import type { LifecycleEvent } from "./lifecycle.ts";
import { initialLifecycle, reduceLifecycle } from "./lifecycle.ts";
import { hostCapability } from "./presentation.ts";

type EmbeddingApi = ReturnType<typeof import("@tnunamak/gozar").createGozar>;
type RuntimeConsentReview = Awaited<ReturnType<typeof import("@tnunamak/gozar").reviewRouteConsent>>;

import { ReachabilityError, requireRouteApproval, requireSetupApproval } from "./approvals.ts";
import { ConfigurationDraftSession } from "./drafts.ts";
import type { OperationRecord } from "./operations.ts";

type SetupReference = Pick<SetupOperationRef, "operationId" | "providerId">;
type SetupCommand = Pick<RunSetupOperationRequest, "actionId" | "expectedConfigurationRevision" | "expectedSetupRevision" | "draftId" | "value"> & {
  approval?: unknown;
  secret?: string;
  acknowledgeDisconnect?: boolean;
};
type SavedDraft = { providerId: string; session: ConfigurationDraftSession };
type Review = { id: string; candidate: RouteCandidate; query: Query; draftId: string };
export type HostPolicy = {
  // Host-owned query: the browser cannot choose home, owner, target or authority.
  query: Omit<Query, "providerId" | "usage">;
  identity: import("@tnunamak/gozar").HostIdentity;
  hostCapabilities: import("@tnunamak/gozar").HostCapabilities;
  hostSettings?: HostSettingsBridge;
  currentTarget?: () => Promise<string>;
  evidenceSource?: "synthetic";
  prepare: (input: { usage: Query["usage"]; reach: string; transport: string }) => Promise<void>;
  acknowledgeDisconnect: (acknowledged: boolean) => Promise<void>;
};

// The host process owns this instance, its API and attached leases. HTTP handlers
// receive only this service; they never construct a factory or keep a lease.
export class ReachabilityService {
  private readonly api: EmbeddingApi;
  private readonly host: HostPolicy;
  private readonly drafts = new Map<string, SavedDraft>();
  private readonly reviews = new Map<string, Review>();
  private readonly routes = new Map<string, Route>();
  private readonly runtimeReviews = new Map<string, RuntimeConsentReview>();
  private readonly watchers = new Map<string, AbortController>();
  private readonly reasons = new Map<string, string>();
  private lifecycle = initialLifecycle();
  private transition(event: LifecycleEvent): void {
    const result = reduceLifecycle(this.lifecycle, event);
    if (!result.accepted) {
      throw new ReachabilityError(result.reason);
    }
    this.lifecycle = result.state;
  }
  private starting = false;
  private epoch = 0;

  constructor(api: EmbeddingApi, host: HostPolicy) {
    this.api = api;
    this.host = host;
  }
  private ref(providerId: string, draftId: string) {
    return { draftId, home: this.host.query.home, owner: this.host.query.owner, providerId };
  }
  private draft(id: string): SavedDraft {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ReachabilityError("draft_not_found");
    }
    return draft;
  }
  private route(id: string, generation: number): Route {
    const route = this.routes.get(id);
    if (!route || route.handle.generation !== generation) {
      throw new ReachabilityError("route_generation_mismatch");
    }
    return route;
  }
  state() {
    if (this.lifecycle.phase === "verified") {
      const route = this.lifecycle.handle ? this.routes.get(this.lifecycle.handle.id) : undefined;
      const until = route?.verification.validUntil;
      if (!until?.known || !Number.isFinite(Date.parse(until.value)) || Date.parse(until.value) <= Date.now()) {
        this.transition({ type: "proof-expired" });
      }
    }
    return {
      evidenceSource: this.host.evidenceSource ?? null,
      lifecycle: {
        handle: this.lifecycle.handle ? { id: this.lifecycle.handle.id, generation: this.lifecycle.handle.generation, kind: this.lifecycle.handle.kind } : null,
        cleanup: this.lifecycle.cleanup,
        confinement: this.lifecycle.confinement.known
          ? { known: true as const, value: this.lifecycle.confinement.value }
          : { known: false as const, reason: this.lifecycle.confinement.reason },
        evidence: this.lifecycle.evidence,
        phase: this.lifecycle.phase,
        reason: this.lifecycle.reason,
        stopRequested: this.lifecycle.stopTombstone,
      },
      reasons: Object.fromEntries(this.reasons),
      routes: [...this.routes.values()],
      starting: this.starting,
    };
  }
  capabilities() {
    const ids = new Set([
      "installer.execute",
      "privilege.elevate",
      "secrets.backend",
      "runtime.attached",
      "runtime.durable",
      ...Object.keys(this.host.hostCapabilities),
    ]);
    return Object.fromEntries(
      [...ids].map((id) => {
        const observation = hostCapability(this.host.hostCapabilities, id);
        return [
          id,
          observation.known ? { known: true, value: observation.value } : { known: false, reason: observation.reason },
        ];
      })
    );
  }
  async hostSettings() {
    return this.host.hostSettings
      ? { known: true as const, value: await this.host.hostSettings.read() }
      : { known: false as const, reason: "host-supervisor-unavailable" };
  }
  async applyHostSettings(input: Parameters<HostSettingsBridge["apply"]>[0], acknowledged: boolean) {
    if (!this.host.hostSettings) {
      throw new ReachabilityError("host_supervisor_unavailable");
    }
    await this.host.acknowledgeDisconnect(acknowledged);
    const before = await this.host.hostSettings.read();
    if (before.revision !== input.expectedRevision) {
      throw new ReachabilityError("configuration_stale");
    }
    this.reviews.clear();
    // Confining Off is useful even if owned resource cleanup remains uncertain.
    if (input.mode !== "off") {
      for (const route of this.routes.values()) {
        if (route.cleanup.state !== "confirmed") {
          const closed = await this.stop(route.handle.id, route.handle.generation, acknowledged);
          if (closed.cleanup.state !== "confirmed") {
            throw new ReachabilityError("cleanup_debt");
          }
        }
      }
    }
    const observed = await this.host.hostSettings.apply(input);
    this.observeHostConfinement(observed.confinement);
    if (input.mode === "off") {
      for (const route of this.routes.values()) {
        if (route.cleanup.state !== "confirmed") {
          await this.stop(route.handle.id, route.handle.generation, acknowledged);
        }
      }
    }
    if (observed.target.known) {
      this.host.query.target = observed.target.value;
    }
    return observed;
  }
  async inventory() {
    return this.api.listProviders({ home: this.host.query.home, owner: this.host.query.owner });
  }
  async begin(providerId: string, expectedConfigurationRevision: string): Promise<Draft> {
    const draft = await this.api.beginConfigurationDraft({
      expectedConfigurationRevision,
      home: this.host.query.home,
      owner: this.host.query.owner,
      providerId,
    });
    this.transition({ type: "choose" });
    this.drafts.set(draft.draftId, { providerId, session: new ConfigurationDraftSession(draft) });
    return draft;
  }
  async reload(providerId: string, draftId: string): Promise<Draft> {
    const session = new ConfigurationDraftSession(null);
    const draft = await session.reload(this.api, this.ref(providerId, draftId));
    this.drafts.set(draftId, { providerId, session });
    return draft;
  }
  // Picks up a draft the host already holds (for example after a restart) so the
  // service keeps one draft. It enters the draft phase like `begin` does.
  async resume(providerId: string, draftId: string): Promise<Draft> {
    const draft = await this.reload(providerId, draftId);
    this.transition({ type: "choose" });
    return draft;
  }
  async providerLabel(providerId: string): Promise<string> {
    const inventory = await this.inventory();
    return inventory.providers.find((item) => item.providerId === providerId)?.label ?? "Selected provider";
  }
  private setupReference(input: SetupReference): SetupOperationRef {
    return { ...input, home: this.host.query.home, owner: this.host.query.owner };
  }
  readSetupOperation(reference: SetupReference): Promise<SetupOperation> {
    return this.api.readSetupOperation(this.setupReference(reference));
  }
  cancelSetupOperation(reference: SetupReference): Promise<SetupOperation> {
    return this.api.cancelSetupOperation(this.setupReference(reference));
  }
  private currentSetupAction(view: SetupOperation, input: SetupCommand) {
    const action = view.nextAction;
    const scope = action?.consent?.scope;
    if (!action || view.revision !== input.expectedSetupRevision ||
        view.scope.configurationRevision !== input.expectedConfigurationRevision ||
        view.scope.draftId !== (input.draftId ?? null) || action.id !== input.actionId ||
        scope?.operation?.id !== view.operationId || scope.operation.revision !== view.revision ||
        scope.configurationRevision !== view.scope.configurationRevision || scope.draftId !== view.scope.draftId ||
        scope.registryId !== view.scope.registryId || scope.providerId !== view.scope.providerId || scope.scopeId !== view.scope.scopeId) {
      throw new ReachabilityError("setup_scope_mismatch");
    }
    return action;
  }
  async runSetupOperation(reference: SetupReference, input: SetupCommand): Promise<SetupOperation> {
    const { actionId, expectedConfigurationRevision, expectedSetupRevision, draftId, value, secret } = input;
    const request = {
      ...this.setupReference(reference), actionId, expectedConfigurationRevision, expectedSetupRevision,
      ...(draftId === undefined ? {} : { draftId }),
    };
    if (expectedSetupRevision === 0 || input.approval === undefined) {
      if (value !== undefined || secret !== undefined || input.approval !== undefined) {
        throw new ReachabilityError("invalid_input");
      }
      return this.api.runSetupAction(request);
    }

    const view = await this.api.readSetupOperation(request);
    const action = this.currentSetupAction(view, input);
    const approval = requireSetupApproval(action, input.approval);
    if (action.kind === "open-url" || action.kind === "instructions") {
      throw new ReachabilityError("setup_action_unavailable");
    }
    if ((secret !== undefined) !== (action.kind === "provide-secret") ||
        (value !== undefined) !== (action.kind === "provide-value")) {
      throw new ReachabilityError("invalid_input");
    }
    if (["stop-connector", "remove-resource", "revoke-credential", "disconnect"].includes(action.step.purpose)) {
      await this.host.acknowledgeDisconnect(input.acknowledgeDisconnect === true);
    }
    this.reviews.clear();
    if (draftId) this.drafts.get(draftId)?.session.invalidate();
    if (secret === undefined) {
      return this.api.runSetupAction({ ...request, approval, ...(value === undefined ? {} : { value }) });
    }
    if (!action.inputId || !secret) throw new ReachabilityError("secret_input_unavailable");
    const bytes = new TextEncoder().encode(secret);
    let handle: string;
    try {
      const stored = await this.api.storeSecret({ ...request, bytes, inputId: action.inputId, scopeId: view.scope.scopeId });
      if (stored.scopeId !== view.scope.scopeId || stored.configurationRevision !== expectedConfigurationRevision) {
        throw new ReachabilityError("secret_reference_inconsistent");
      }
      handle = stored.handle;
    } finally {
      bytes.fill(0);
    }
    try {
      return await this.api.runSetupAction({ ...request, approval, secretHandle: handle });
    } finally {
      // The SDK protects handles bound to a configuration or the current setup operation.
      await this.api.discardSecret({ home: request.home, handle }).catch(() => {});
    }
  }
  async setupHandoff(reference: SetupReference, input: SetupCommand): Promise<{ href: string }> {
    if (input.secret !== undefined || input.value !== undefined) throw new ReachabilityError("invalid_input");
    const request = this.setupReference(reference);
    const view = await this.api.readSetupOperation(request);
    const action = this.currentSetupAction(view, input);
    requireSetupApproval(action, input.approval);
    if (view.state !== "pending" || action.kind !== "open-url" || !action.step.browser) {
      throw new ReachabilityError("setup_action_unavailable");
    }
    const interactive = await this.api.readSetupOperation({ ...request, includeBrowserHandoff: true });
    const offered = interactive.nextAction;
    const url = offered?.href && URL.parse(offered.href);
    if (interactive.revision !== view.revision || interactive.state !== "pending" ||
        offered?.consent.consentFactsDigest !== action.consent.consentFactsDigest ||
        !url || url.protocol !== "https:" || url.username || url.password) {
      throw new ReachabilityError("setup_action_unavailable");
    }
    return { href: url.href };
  }
  async setup(
    id: string,
    input: { actionId: string; expectedRevision: string; approval: unknown; value?: string; secret?: string }
  ): Promise<ProviderConfiguration> {
    const saved = this.draft(id);
    const prior = saved.session.snapshot;
    const action = saved.session.action(input.actionId, input.expectedRevision);
    const approval = requireSetupApproval(action, input.approval);
    if (action.step) throw new ReachabilityError("setup_required");
    const ref = this.ref(saved.providerId, id);
    this.transition({ type: "setup" });
    saved.session.invalidate();
    // After a mutation starts, no previously issued review remains redeemable.
    this.reviews.clear();
    try {
      let secretHandle: string | undefined;
      if (input.secret !== undefined) {
        const requirement = prior.configuration.inputRequirements.find(
          (field: InputRequirement) => field.actionId === action.id && field.secret
        );
        if (!requirement || action.kind !== "provide-secret") {
          throw new ReachabilityError("secret_input_unavailable");
        }
        const bytes = new TextEncoder().encode(input.secret);
        try {
          const stored = await this.api.storeSecret({
            ...ref,
            bytes,
            expectedConfigurationRevision: input.expectedRevision,
            inputId: requirement.id,
            scopeId: prior.scopeId,
          });
          if (stored.scopeId !== prior.scopeId || stored.configurationRevision !== input.expectedRevision) {
            throw new ReachabilityError("secret_reference_inconsistent");
          }
          secretHandle = stored.handle;
        } finally {
          bytes.fill(0);
        }
      }
      const result = await this.api.runSetupAction({
        ...ref,
        actionId: action.id,
        approval,
        expectedConfigurationRevision: input.expectedRevision,
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(secretHandle === undefined ? {} : { secretHandle }),
      });
      saved.session.acceptSetup(prior, result);
      this.transition({ type: "setup-complete" });
      return saved.session.snapshot.configuration;
    } catch (error) {
      const failed = reduceLifecycle(this.lifecycle, { type: "setup-failed" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    }
  }
  async clear(
    id: string,
    input: { actionId: string; expectedRevision: string; approval: unknown }
  ): Promise<ProviderConfiguration> {
    const saved = this.draft(id);
    const prior = saved.session.snapshot;
    const action = saved.session.action(input.actionId, input.expectedRevision);
    if (!action.inputId) {
      throw new ReachabilityError("clear_input_unavailable");
    }
    const approval = requireSetupApproval(action, input.approval);
    saved.session.invalidate();
    this.reviews.clear();
    const configuration = await this.api.clearConfigurationInput({
      ...this.ref(saved.providerId, id),
      approval,
      expectedConfigurationRevision: input.expectedRevision,
      inputId: action.inputId,
    });
    saved.session.acceptClear(prior, configuration);
    return saved.session.snapshot.configuration;
  }
  async discard(id: string): Promise<{ discarded: boolean }> {
    const saved = this.draft(id);
    const result = await this.api.discardConfigurationDraft(this.ref(saved.providerId, id));
    // The library discards only draft-owned, unreferenced staged bytes.
    // Promoted/live bindings remain under its authorization checks.
    this.drafts.delete(id);
    this.reviews.clear();
    return result;
  }
  async commit(id: string, expectedRevision: string): Promise<ProviderConfiguration> {
    if (this.starting || [...this.routes.values()].some((route) => route.cleanup.state !== "confirmed")) {
      throw new ReachabilityError("configuration_in_use");
    }
    const saved = this.draft(id);
    if (saved.session.snapshot.configuration.revision !== expectedRevision) {
      throw new ReachabilityError("configuration_stale");
    }
    const config = await this.api.commitConfigurationDraft({
      ...this.ref(saved.providerId, id),
      expectedConfigurationRevision: expectedRevision,
    });
    this.reviews.clear();
    return config;
  }
  async review(id: string, usage: Query["usage"]): Promise<Review> {
    const saved = this.draft(id);
    // Host preparation observes the final listener/password/port before catalog.
    const inventory = await this.api.listProviders({ home: this.host.query.home, owner: this.host.query.owner });
    const variants = inventory.providers.filter((item: ProviderInventory) => item.providerId === saved.providerId);
    if (variants.length !== 1 || !variants[0]) {
      throw new ReachabilityError("ambiguous_selection");
    }
    const selected = variants[0];
    if (selected.availability[usage.kind]?.state !== "available") {
      throw new ReachabilityError("setup_required");
    }
    if (
      !(
        ["internet", "tailnet", "lan", "this-device"].includes(selected.reach) &&
        ["http", "https", "tcp", "tls"].includes(selected.transport)
      )
    ) {
      throw new ReachabilityError("unsupported");
    }
    await this.host.prepare({ reach: selected.reach, transport: selected.transport, usage });
    let query: Query = {
      ...this.host.query,
      intent: "create",
      target: await this.host.currentTarget?.() ?? this.host.query.target,
      providerId: saved.providerId,
      requirements: {
        ...this.host.query.requirements,
        reach: selected.reach as Query["requirements"]["reach"],
        transport: selected.transport === "http" ? "any" : (selected.transport as Query["requirements"]["transport"]),
      },
      usage,
    };
    const offer = async () => (await this.api.catalogRoutes(query)).candidates
      .find((item: RouteCandidate) => item.providerId === saved.providerId);
    let candidate = await offer();
    if (candidate?.ownership === "external-owned") {
      const { configuration } = candidate;
      const origins = configuration.inputRequirements
        .filter(field => field.kind === "https-origin" && !field.secret)
        .map(field => configuration.values[field.id])
        .filter(Boolean);
      const origin = query.origin ?? candidate.consent.scope.query.expectedOrigin ??
        (origins.length === 1 ? URL.parse(origins[0] ?? "")?.origin : undefined);
      if (!origin || usage.kind === "attached") throw new ReachabilityError("setup_required");
      query = { ...query, origin };
      candidate = await offer();
      if (candidate?.ownership !== "external-owned" ||
          candidate.consent.disclosures.ownership !== candidate.ownership ||
          candidate.consent.scope.query.expectedOrigin !== origin ||
          candidate.consent.scope.query.target !== query.target) {
        throw new ReachabilityError("candidate_stale");
      }
    }
    if (!(candidate && candidate.eligible && candidate.candidateToken)) {
      throw new ReachabilityError("setup_required");
    }
    const review = { candidate, draftId: id, id: randomUUID(), query };
    this.reviews.set(review.id, review);
    this.transition({ approvalIdentity: review.id, type: "review" });
    return review;
  }
  operationIntent(reviewId: string) {
    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new ReachabilityError("review_not_found");
    }
    return {
      bootId: this.host.identity.bootId,
      configurationRevision: review.candidate.configuration.revision,
      consentFactsDigest: review.candidate.consentFactsDigest,
      expectedOrigin: review.query.origin ?? null,
      instanceId: this.host.identity.instanceId,
      ownership: review.candidate.ownership,
      providerId: review.candidate.providerId,
      target: review.query.target,
      usage: review.query.usage,
    };
  }
  async reconcileKnownHandle(handle: Handle, stopTombstone: boolean): Promise<Route> {
    this.transition({ handle, type: "restore-intent" });
    if (stopTombstone) {
      this.transition({ type: "stop" });
      const route = await this.api.closeRoute({ handle, home: this.host.query.home, mode: "remove" });
      this.routes.set(handle.id, route);
      this.transition({ type: route.cleanup.state === "confirmed" ? "cleanup-confirmed" : "cleanup-unconfirmed" });
      return route;
    }
    try {
      const route = await this.api.routeStatus({ handle, home: this.host.query.home });
      this.routes.set(handle.id, route);
      this.transition({ observed: "present", type: "reconcile" });
      return this.check(handle.id, handle.generation);
    } catch (error) {
      const failed = reduceLifecycle(this.lifecycle, { observed: "failed", type: "reconcile" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    }
  }
  observeHostConfinement(confinement: import("@tnunamak/gozar").Observation<boolean>): void {
    this.transition({ confinement, type: "host-confinement" });
  }
  async observeOperationRecovery(record: OperationRecord): Promise<Route | null> {
    if (record.handle?.kind !== "external" && record.intent?.ownership !== "external-owned") return null;
    const { home, owner } = this.host.query;
    const { routes } = await this.api.listRoutes({ home, owner });
    const matches = routes.filter(route => record.handle
      ? route.handle.kind === record.handle.kind && route.handle.id === record.handle.id &&
        route.handle.generation === record.handle.generation
      : route.operationId === record.operationId);
    if (matches.length !== 1 || !matches[0] || !this.matchesExternalOperation(matches[0], record)) {
      throw new ReachabilityError("operation_recovery_unauthorized");
    }
    const route = matches[0];
    return route.state === "released" && route.cleanup.state === "confirmed" ? route : null;
  }
  private matchesExternalOperation(route: Route, record: OperationRecord): boolean {
    if (route.ownership !== "external-owned" || route.handle.kind !== "external") return false;
    // A Stop receipt already records the exact authorized handle. A start
    // receipt additionally binds recovery to the reviewed target and origin.
    if (record.kind === "stop") return record.handle?.kind === "external";
    const intent = record.intent;
    if (intent?.ownership !== "external-owned" || intent.instanceId !== this.host.identity.instanceId ||
        route.operationId !== record.operationId || !intent.expectedOrigin || route.origin !== intent.expectedOrigin) {
      return false;
    }
    // After removal Gozar forgets the target. Only the already-authorized
    // tombstone can consume that terminal observation, without closing again.
    if (record.stopTombstone && route.state === "released" && route.cleanup.state === "confirmed") return true;
    return route.hostConfiguration.target.known && route.hostConfiguration.target.value === intent.target;
  }
  async recoverOperation(
    record: OperationRecord,
    action: "check" | "stop",
    acknowledged: boolean,
    stopTombstone = false
  ): Promise<Route> {
    const { operationId } = record;
    if (stopTombstone || action === "stop") {
      ++this.epoch;
      if (!this.starting) this.transition({ operationId, type: "restore-intent" });
      this.transition({ type: "stop" });
    } else {
      if (this.starting) throw new ReachabilityError("operation_in_progress");
      this.transition({ operationId, type: "restore-intent" });
    }
    let listed: Awaited<ReturnType<EmbeddingApi["listRoutes"]>>;
    try {
      listed = await this.api.listRoutes({ home: this.host.query.home, owner: this.host.query.owner });
    } catch (error) {
      const failed = reduceLifecycle(this.lifecycle, { observed: "failed", type: "reconcile" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    }
    const matches = listed.routes.filter((route: Route) => route.operationId === operationId);
    if (matches.length !== 1 || !matches[0]) {
      const absent = reduceLifecycle(this.lifecycle, { observed: "absent", type: "reconcile" });
      if (absent.accepted) {
        this.lifecycle = absent.state;
      }
      throw new ReachabilityError("operation_not_found");
    }
    const route = matches[0];
    if (route.ownership !== "gozar-owned" && !this.matchesExternalOperation(route, record)) {
      throw new ReachabilityError("operation_recovery_unauthorized");
    }
    this.routes.set(route.handle.id, route);
    this.transition({ handle: route.handle, type: "recovered-handle" });
    if (stopTombstone || this.lifecycle.stopTombstone) {
      return this.stop(route.handle.id, route.handle.generation, acknowledged);
    }
    this.transition({ handle: route.handle, operationId, type: "restore-intent" });
    this.transition({ observed: "present", type: "reconcile" });
    return action === "stop"
      ? this.stop(route.handle.id, route.handle.generation, acknowledged)
      : this.check(route.handle.id, route.handle.generation);
  }
  // Every consent check apply makes before it has any effect, with no effect of
  // its own: nothing is written, started or deleted. The approve route runs it
  // before it answers 202, so a review that expired or changed since the owner
  // saw it is refused at once and the console can fetch a new one.
  private checkApplyNow(
    operationId: string,
    reviewId: string,
    input: { kind: unknown; consentFactsDigest: string }
  ): { review: Review; approval: ReturnType<typeof requireRouteApproval>; event: ReturnType<typeof reduceLifecycle> } {
    if (input.kind !== "route") {
      throw new ReachabilityError("consent_kind_mismatch");
    }
    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new ReachabilityError("review_not_found");
    }
    const approval = requireRouteApproval(review.candidate, {
      candidateToken: review.candidate.candidateToken,
      consentFactsDigest: input.consentFactsDigest,
      disclosureRevision: review.candidate.disclosure.revision,
      kind: input.kind,
    });
    if (this.starting || [...this.routes.values()].some((route) => route.cleanup.state !== "confirmed")) {
      throw new ReachabilityError("configuration_in_use");
    }
    const expiry = review.candidate.expiresAt ? Date.parse(review.candidate.expiresAt) : Number.NaN;
    const event = reduceLifecycle(this.lifecycle, {
      approvalExpiresAt: expiry,
      approvalIdentity: review.id,
      now: Date.now(),
      operationId,
      type: "apply",
    });
    if (!(event.accepted && event.effects.includes("start-route"))) {
      throw new ReachabilityError("consent_expired");
    }
    return { approval, event, review };
  }
  private async checkApply(
    operationId: string,
    reviewId: string,
    input: { kind: unknown; consentFactsDigest: string }
  ): Promise<ReturnType<ReachabilityService["checkApplyNow"]>> {
    const checked = this.checkApplyNow(operationId, reviewId, input);
    if (this.host.currentTarget && (await this.host.currentTarget()) !== checked.review.query.target) {
      throw new ReachabilityError("candidate_stale");
    }
    // A slow target read must not make the read-only precheck accept an
    // expired review or lifecycle state that changed while it was pending.
    return this.checkApplyNow(operationId, reviewId, input);
  }
  /** Refuses a stale or changed review before the approval is accepted. Changes nothing. */
  async precheckApply(reviewId: string, input: { kind: unknown; consentFactsDigest: string }): Promise<void> {
    await this.checkApply("precheck", reviewId, input);
  }
  async apply(
    operationId: string,
    reviewId: string,
    input: { kind: unknown; consentFactsDigest: string; acknowledgeDisconnect: boolean }
  ): Promise<Route> {
    let checked: Awaited<ReturnType<ReachabilityService["checkApply"]>>;
    try {
      await this.checkApply(operationId, reviewId, input);
      // Revalidate after the last asynchronous read. No await may separate this
      // check from installing the lifecycle and consuming the review below.
      checked = this.checkApplyNow(operationId, reviewId, input);
    } catch (error) {
      // A review the host can no longer approve is dropped, so it is not offered again.
      const code = error instanceof ReachabilityError ? error.code : null;
      if (code === "candidate_stale" || code === "consent_expired") this.reviews.delete(reviewId);
      throw error;
    }
    const { approval, event, review } = checked;
    this.lifecycle = event.state;
    const epoch = ++this.epoch;
    this.starting = true;
    this.reviews.delete(reviewId);
    try {
      await this.host.acknowledgeDisconnect(input.acknowledgeDisconnect);
      const { usage } = review.query;
      const route =
        usage.kind === "durable"
          ? await this.api.ensureRoute({ ...review.query, approval, intent: "create", operationId, usage })
          : await this.api.expose({
              ...review.query,
              approval,
              intent: "create",
              operationId,
              usage,
              wait: "verified",
            });
      this.routes.set(route.handle.id, route);
      if (epoch !== this.epoch) {
        await this.stop(route.handle.id, route.handle.generation, true);
        throw new ReachabilityError("operation_superseded");
      }
      this.transition({ handle: route.handle, type: "allocated" });
      if (route.verification.status === "verified" && route.published) {
        this.transition({ epoch: this.lifecycle.epoch, type: "proof-passed" });
      }
      this.watch(route.handle);
      return route;
    } catch (error) {
      const partial = (error as import("@tnunamak/gozar").GozarThrownError | null | undefined)?.route;
      if (partial) {
        this.routes.set(partial.handle.id, partial);
        const allocated = reduceLifecycle(this.lifecycle, { handle: partial.handle, type: "allocated" });
        if (allocated.accepted) {
          this.lifecycle = allocated.state;
        }
      }
      const failed = reduceLifecycle(this.lifecycle, { type: "start-failed" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }
  private watch(handle: Handle): void {
    const abort = new AbortController();
    this.watchers.get(handle.id)?.abort();
    this.watchers.set(handle.id, abort);
    void (async () => {
      try {
        for await (const event of this.api.watchRoutes({ handle, home: this.host.query.home, signal: abort.signal })) {
          if (
            !abort.signal.aborted &&
            event.route.handle.id === handle.id &&
            event.route.handle.generation === handle.generation
          ) {
            this.routes.set(handle.id, event.route);
            if (event.route.state === "lost") {
              this.transition({ type: "agent-exit" });
              await this.stop(handle.id, handle.generation, true);
            } else if (event.type === "consent_changed") {
              this.transition({ type: "approval-changed" });
            } else if (
              this.lifecycle.phase === "verified" &&
              (!event.route.published || event.route.verification.status !== "verified")
            ) {
              this.transition({ type: "proof-expired" });
            }
          }
        }
      } catch {
        if (!abort.signal.aborted) {
          this.reasons.set(handle.id, "route_observation_unavailable");
          if (this.lifecycle.phase === "verified") this.transition({ type: "proof-expired" });
        }
      }
    })();
  }
  async check(id: string, generation: number): Promise<Route> {
    const route = this.route(id, generation);
    this.transition({ type: "check" });
    const epoch = this.lifecycle.epoch;
    try {
      const current = await this.api.routeStatus({ handle: route.handle, home: this.host.query.home });
      if (epoch !== this.lifecycle.epoch || this.lifecycle.stopTombstone) {
        return this.route(id, generation);
      }
      this.routes.set(id, current);
      this.transition({
        epoch: this.lifecycle.epoch,
        type: current.verification.status === "verified" && current.published ? "proof-passed" : "proof-failed",
      });
      return current;
    } catch (error) {
      if ((error as { code?: string }).code === "proof_refresh_unsupported") {
        this.reasons.set(id, "proof_refresh_unsupported");
        this.transition({ type: "proof-refresh-unsupported" });
      } else {
        const failed = reduceLifecycle(this.lifecycle, { type: "proof-failed" });
        if (failed.accepted) {
          this.lifecycle = failed.state;
        }
      }
      throw error;
    }
  }
  routeReference(id: string, generation: number): Handle {
    return this.route(id, generation).handle;
  }
  async authorizeDisconnect(acknowledged: boolean): Promise<void> {
    await this.host.acknowledgeDisconnect(acknowledged);
  }
  async stop(id: string, generation: number, acknowledged: boolean): Promise<Route> {
    const route = this.route(id, generation);
    await this.host.acknowledgeDisconnect(acknowledged);
    if (route.cleanup.state === "confirmed") {
      const closed = await this.api.closeRoute({ home: this.host.query.home, handle: route.handle, mode: "remove" });
      this.routes.set(id, closed);
      return closed;
    }
    this.transition({ type: "stop" });
    ++this.epoch;
    this.reviews.clear();
    this.runtimeReviews.delete(id);
    this.watchers.get(id)?.abort();
    this.routes.set(id, { ...route, published: null });
    const closed = await this.api.closeRoute({ handle: route.handle, home: this.host.query.home, mode: "remove" });
    this.routes.set(id, closed);
    this.transition({ type: closed.cleanup.state === "confirmed" ? "cleanup-confirmed" : "cleanup-unconfirmed" });
    return closed;
  }
  async reviewRuntime(id: string, generation: number): Promise<RuntimeConsentReview> {
    const route = this.route(id, generation);
    try {
      const review = await this.api.reviewRouteConsent({ handle: route.handle, home: this.host.query.home });
      this.runtimeReviews.set(id, review);
      return review;
    } catch (error) {
      if ((error as { code?: string }).code === "proof_refresh_unsupported") {
        this.reasons.set(id, "proof_refresh_unsupported");
        this.transition({ type: "proof-refresh-unsupported" });
        this.routes.set(id, { ...route, actions: ["stop"], published: null });
      }
      throw error;
    }
  }
  async approveRuntime(id: string, generation: number, digest: string): Promise<Route> {
    const route = this.route(id, generation);
    const review = this.runtimeReviews.get(id);
    if (!review || review.consentFactsDigest !== digest) {
      throw new ReachabilityError("consent_changed");
    }
    this.runtimeReviews.delete(id);
    const current = await this.api.approveRouteConsent({
      approvalToken: review.approvalToken,
      consentFactsDigest: digest,
      handle: route.handle,
      home: this.host.query.home,
    });
    this.routes.set(id, current);
    return current;
  }
  closeObservers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.abort();
    }
    this.watchers.clear();
  }
}

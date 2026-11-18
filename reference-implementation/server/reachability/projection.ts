// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  ConsentDisclosures,
  ConfigurationDraft as Draft,
  Fact,
  Configuration as ProviderConfiguration,
  ProviderInventory,
  RouteView as Route,
  SetupOperation,
  Candidate as RouteCandidate,
  Action as SetupAction,
} from "@tnunamak/gozar";

type RuntimeConsentReview = Awaited<ReturnType<typeof import("@tnunamak/gozar").reviewRouteConsent>>;
type ProviderList = Awaited<ReturnType<typeof import("@tnunamak/gozar").listProviders>>;

function consentValue(value: ConsentDisclosures): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("action" in value) {
    return { action: projectAction(value.action) };
  }
  if (!(value.traffic && value.address && value.cost && value.protocols && value.disclosure)) {
    return null;
  }
  return {
    address: {
      conditions: value.address.conditions,
      ports: value.address.ports,
      scope: value.address.scope,
      stability: value.address.stability,
    },
    cost: value.cost.kind === "paid"
      ? { kind: value.cost.kind, summary: value.cost.summary, amount: value.cost.amount, currency: value.cost.currency, period: value.cost.period }
      : { kind: value.cost.kind, summary: value.cost.summary },
    disclosure: disclosure(value.disclosure),
    lifetimes: value.lifetimes,
    ownership: value.ownership,
    protocols: {
      oauthDcr: value.protocols.oauthDcr,
      sse: value.protocols.sse,
      streamableHttp: value.protocols.streamableHttp,
    },
    reach: value.reach,
    supervision: value.supervision,
    traffic: {
      evidenceRef: value.traffic.evidenceRef,
      metadataVisibleTo: value.traffic.metadataVisibleTo,
      providerCanReadPayload: value.traffic.providerCanReadPayload,
      readers: value.traffic.readers,
      tlsTermination: value.traffic.tlsTermination,
    },
    transport: value.transport,
  };
}

// Explicit allowlists at each response boundary. No private object is spread.
export function projectFact(fact: Fact) {
  return {
    affectsConsent: fact.affectsConsent,
    asOf: fact.asOf,
    group: fact.group,
    id: fact.id,
    known: fact.known,
    label: fact.label,
    reason: fact.reason,
    source: fact.source,
    value: fact.known ? fact.value : null,
  };
}
function disclosure(input: SetupAction["disclosure"]) {
  return {
    links: input.links.map((link) => ({ href: link.href, label: link.label, rel: link.rel })),
    revision: input.revision,
    text: input.text,
  };
}
export function projectAction(action: SetupAction) {
  const snapshot = action.consent;
  const scope = snapshot?.scope;
  return {
    artifact: action.artifact
      ? {
          architecture: action.artifact.architecture,
          platform: action.artifact.platform,
          sha256: action.artifact.sha256,
          url: action.artifact.url,
        }
      : undefined,
    consent:
      snapshot && scope?.kind === "setup"
        ? {
            consentFactsDigest: snapshot.consentFactsDigest,
            disclosures: snapshot.disclosures === undefined ? undefined : consentValue(snapshot.disclosures),
            facts: snapshot.facts?.map(projectFact),
            scope: {
              actionDigest: scope.actionDigest,
              actionId: scope.actionId,
              configurationRevision: scope.configurationRevision,
              disclosureRevision: scope.disclosureRevision,
              draftId: scope.draftId,
              kind: scope.kind,
              ...(scope.operation ? { operation: { id: scope.operation.id, revision: scope.operation.revision } } : {}),
              providerId: scope.providerId,
              registryId: scope.registryId,
              scopeId: scope.scopeId,
            },
          }
        : undefined,
    digest: action.digest,
    disclosure: disclosure(action.disclosure),
    effects: action.effects
      ? {
          networkOrigins: action.effects.networkOrigins,
          requiresPrivilege: action.effects.requiresPrivilege,
          restartRequired: action.effects.restartRequired,
          writes: action.effects.writes,
        }
      : undefined,
    help: action.help,
    href: action.step?.browser ? undefined : action.href,
    id: action.id,
    inputId: action.inputId,
    instructions: action.instructions,
    kind: action.kind,
    label: action.label,
    obtainUrl: action.obtainUrl,
    required: action.required,
    secretLabel: action.secretLabel,
    step: action.step ? {
      actor: action.step.actor,
      permission: { id: action.step.permission.id, label: action.step.permission.label },
      verification: action.step.verification,
      purpose: action.step.purpose,
      prerequisites: action.step.prerequisites,
      options: action.step.options?.map(({ value, label }) => ({ value, label })),
      browser: action.step.browser ? {
        expiresAt: action.step.browser.expiresAt, pollAfterMs: action.step.browser.pollAfterMs,
      } : undefined,
      resourceHandle: action.step.resourceHandle,
    } : undefined,
    valueFormat: action.valueFormat,
    valueLabel: action.valueLabel,
    valuePlaceholder: action.valuePlaceholder,
  };
}
function observation<T>(input: { known: true; value: T } | { known: false; reason: string }) {
  return input.known ? { known: true as const, value: input.value } : { known: false as const, reason: input.reason };
}
export function projectSetupOperation(operation: SetupOperation) {
  const { scope, evidence } = operation;
  return {
    operationId: operation.operationId,
    revision: operation.revision,
    state: operation.state,
    scope: {
      registryId: scope.registryId, scopeId: scope.scopeId, providerId: scope.providerId,
      configurationRevision: scope.configurationRevision, draftId: scope.draftId,
    },
    evidence: evidence.known ? { known: true as const, value: {
      stepId: evidence.value.stepId, source: evidence.value.source,
      observedAt: evidence.value.observedAt, summary: evidence.value.summary,
    } } : { known: false as const, reason: evidence.reason },
    nextAction: operation.nextAction ? projectAction(operation.nextAction) : null,
    resources: operation.resources.map((resource) => ({
      handle: resource.handle, kind: resource.kind, label: resource.label, ownership: resource.ownership,
      presence: observation(resource.presence), removal: resource.removal,
    })),
  };
}
export function projectConfiguration(config: ProviderConfiguration) {
  const allowed = new Set(config.inputRequirements.filter((field) => !field.secret).map((field) => field.id));
  return {
    actions: config.actions.map(projectAction),
    credentials: Object.fromEntries(
      Object.entries(config.credentials).map(([key, value]) => [key, observation(value)])
    ),
    inputRequirements: config.inputRequirements.map((field) => ({
      actionId: field.actionId,
      help: field.help,
      id: field.id,
      kind: field.kind,
      label: field.label,
      obtainUrl: field.obtainUrl,
      required: field.required,
      secret: field.secret,
      validation: field.validation,
    })),
    revision: config.revision,
    scopeId: config.scopeId,
    values: Object.fromEntries(Object.entries(config.values).filter(([key]) => allowed.has(key))),
  };
}
export function projectDraft(draft: Draft) {
  return {
    baseRevision: draft.baseRevision,
    configuration: projectConfiguration(draft.configuration),
    draftId: draft.draftId,
    scopeId: draft.scopeId,
  };
}
function routeScope(scope: import("@tnunamak/gozar").RouteConsentScope) {
  return {
    configurationRevision: scope.configurationRevision,
    handleGeneration: scope.handleGeneration,
    kind: scope.kind,
    providerId: scope.providerId,
    query: {
      expectedOrigin: scope.query.expectedOrigin,
      reach: scope.query.reach,
      target: scope.query.target,
      transport: scope.query.transport,
      usage:
        scope.query.usage.kind === "attached"
          ? { kind: "attached" as const }
          : scope.query.usage.kind === "session"
            ? { kind: "session" as const, lifetimeMs: scope.query.usage.lifetimeMs }
            : { kind: "durable" as const, routeId: scope.query.usage.routeId },
    },
    registryId: scope.registryId,
    reviewHandle: scope.reviewHandle,
    scopeId: scope.scopeId,
  };
}
export function projectCandidate(candidate: RouteCandidate) {
  return {
    configuration: projectConfiguration(candidate.configuration),
    consent: candidate.consent
      ? {
          consentFactsDigest: candidate.consent.consentFactsDigest,
          disclosures: consentValue(candidate.consent.disclosures),
          facts: candidate.consent.facts.map(projectFact),
          scope: candidate.consent.scope.kind === "route" ? routeScope(candidate.consent.scope) : null,
        }
      : null,
    consentFactsDigest: candidate.consentFactsDigest,
    disclosure: disclosure(candidate.disclosure),
    display: {
      description: candidate.display.description,
      label: candidate.display.label,
      needs: candidate.display.needs,
    },
    eligible: candidate.eligible,
    expiresAt: candidate.expiresAt,
    facts: candidate.facts.map(projectFact),
    ownership: candidate.ownership,
    providerId: candidate.providerId,
  };
}
export function projectInventory(list: ProviderList) {
  return {
    catalogRevision: list.catalogRevision,
    observedAt: list.observedAt,
    providers: list.providers.map((provider: ProviderInventory) => ({
      availability: Object.fromEntries(
        Object.entries(provider.availability as Record<string, { state: string; reason: string }>).map(
          ([usage, availability]) => [usage, { reason: availability.reason, state: availability.state }]
        )
      ),
      configuration: projectConfiguration(provider.configuration as ProviderConfiguration),
      facts: (provider.facts as Fact[]).map(projectFact),
      label: provider.label,
      prerequisites: (provider.prerequisites as import("@tnunamak/gozar").Prerequisite[]).map((item) => ({
        id: item.id,
        label: item.label,
        observedAt: item.observedAt,
        remedy: item.remedy ? projectAction(item.remedy as SetupAction) : null,
        state: item.state,
        version: observation(item.version),
      })),
      providerId: provider.providerId,
      reach: provider.reach,
      transport: provider.transport,
    })),
    schemaVersion: list.schemaVersion,
  };
}
export function projectRoute(route: Route) {
  const proof = route.verification;
  return {
    actions: route.actions,
    binding: {
      authority: route.binding.authority,
      remedy: route.binding.remedy ? projectAction(route.binding.remedy as SetupAction) : null,
      target: observation(route.binding.target),
    },
    cleanup: {
      nextAction: route.cleanup.nextAction ? projectAction(route.cleanup.nextAction) : null,
      state: route.cleanup.state,
    },
    expiresAt: observation(route.expiresAt),
    facts: route.facts.map(projectFact),
    handle: { generation: route.handle.generation, id: route.handle.id, kind: route.handle.kind },
    hostConfiguration: {
      target: observation(route.hostConfiguration.target),
      localPort: observation(route.hostConfiguration.localPort),
      bindTarget: observation(route.hostConfiguration.bindTarget),
      origin: observation(route.hostConfiguration.origin),
    },
    operationId: route.operationId,
    origin: route.origin,
    published: route.published,
    routeState: route.routeState,
    state: route.state,
    verification: {
      checkedAt: proof.checkedAt,
      checks: proof.checks,
      observedAt: proof.observedAt,
      results: proof.results.map((result) => ({ check: result.check, status: result.status })),
      status: proof.status,
      subject: proof.subject
        ? {
            bootId: proof.subject.bootId,
            handleGeneration: proof.subject.handleGeneration,
            instanceId: proof.subject.instanceId,
            origin: proof.subject.origin,
            target: proof.subject.target,
          }
        : null,
      validUntil: observation(proof.validUntil),
      vantage: proof.vantage,
    },
  };
}
export function projectRuntimeReview(review: RuntimeConsentReview) {
  // Approval token stays in the service; the browser approves the digest.
  return {
    consentFactsDigest: review.consentFactsDigest,
    disclosures: consentValue(review.disclosures),
    expiresAt: review.expiresAt,
    facts: review.facts.map(projectFact),
    kind: "route" as const,
    scope: review.scope.kind === "route" ? routeScope(review.scope) : null,
  };
}

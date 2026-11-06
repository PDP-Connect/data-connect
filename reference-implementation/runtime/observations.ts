// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// OBSERVATION intake, descriptor validation and failure diagnosis for the
// Collection Profile v0.2.0.
//
// Normative sources: data-connectors docs spec sections 3.8 (diagnostic
// descriptors), 5.10 (OBSERVATION facts, provenance, retirement, limits) and
// 5.11 (diagnosis and the recovery-hint gate). The wire grammar is the
// canonical JSON Schema `observation.schema.json` beside this file, a byte
// copy of data-connectors blob 8d9384d1f0827647e62e1914e8cac81d809034b3. The
// schema cannot express the checks below, so this module adds them: declared
// id references, final-in-states_seen, duplicate ids, the run limits and the
// diagnosis rules.
//
// The module returns data. It renders no text, retries nothing, prompts for no
// credential, and performs no provider or storage I/O.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import observationSchema from "./observation.schema.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ElementState = "matched" | "absent" | "hidden" | "disabled" | "ambiguous";

export interface DiagnosticDescriptors {
  readonly expectations: readonly {
    readonly id: string;
    readonly step: string;
  }[];
  readonly rules: readonly {
    readonly id: string;
    readonly kind: "auth";
    readonly step?: string;
  }[];
  readonly steps: readonly { readonly id: string }[];
}

interface FactEnvelope {
  readonly evidence_ref?: string;
  readonly id: string;
  readonly resolves?: readonly string[];
  readonly step?: string;
  readonly type: "OBSERVATION";
}

export interface ElementExpectationFact extends FactEnvelope {
  readonly attrs: {
    readonly expectation: string;
    readonly states_seen: readonly ElementState[];
    readonly final: ElementState;
    readonly fallback_used?: boolean;
  };
  readonly fact: "element_expectation";
  readonly step: string;
}

export interface WaitExpiredFact extends FactEnvelope {
  readonly attrs: { readonly awaited: string; readonly budget_ms: number };
  readonly fact: "wait_expired";
  readonly step: string;
}

export interface ProviderMessageFact extends FactEnvelope {
  readonly attrs: {
    readonly kind: "auth_failure" | "other";
    readonly rule?: string;
  };
  readonly fact: "provider_message";
}

export type ConnectorFact = ElementExpectationFact | WaitExpiredFact | ProviderMessageFact;

export type ObservedFact = ConnectorFact & { readonly retired: boolean };

/** Reasons a connector OBSERVATION is discarded. This is the closed set of Section 5.10.2. */
export type ObservationRejectReason =
  | "runtime_fact_type"
  | "undeclared_capability"
  | "invalid"
  | "duplicate_id"
  | "oversize"
  | "count_exceeded";

export type AcceptOutcome =
  | {
      readonly status: "accepted";
      readonly id: string;
      readonly retired: readonly string[];
    }
  | { readonly status: "rejected"; readonly reason: ObservationRejectReason };

/**
 * Runtime-authored defect aggregate. It carries no connector text. Protocol
 * violations aggregate by reason, so the record set is bounded by the closed
 * reason list (seven records at most), whatever a connector sends.
 */
export type RuntimeDefect =
  | {
      readonly id: string;
      readonly class: "protocol_violation";
      readonly reason: ObservationRejectReason;
      readonly count: number;
    }
  | {
      readonly id: string;
      readonly class: "hint_unsupported";
      readonly count: number;
    };

/** The portable recovery actions of Collection Profile Section 5.5. */
export type PortableRecoveryAction =
  | "retry_by_runtime"
  | "retry_on_connector_upgrade"
  | "refresh_credentials"
  | "manual_action_required"
  | "update_selector"
  | "upstream_unblock"
  | "not_retriable"
  | "unknown";

/** Where a connector hint came from. */
export type RecoveryHintOrigin = "skip_result" | "done_error";

/**
 * A connector hint the Section 5.11 gate did not authorize. It is shown only
 * as the connector's attributed suggestion. The record holds closed values
 * only: no free text, code, or retryable flag from the connector.
 */
export interface ConnectorSuggestion {
  readonly action: PortableRecoveryAction;
  readonly attribution: "connector";
  readonly origin: RecoveryHintOrigin;
}

export interface ObservationSnapshot {
  /** Present only when at least one hint was not authorized. */
  readonly connector_suggestions?: readonly ConnectorSuggestion[];
  readonly defects: readonly RuntimeDefect[];
  readonly facts: readonly ObservedFact[];
  readonly truncated: boolean;
}

export type DiagnosisCategory = "auth_rejected" | "expectation_mismatch" | "unknown";

export interface Diagnosis {
  readonly attribution: "connector" | "none";
  /** Ids of the in-scope facts that support the category, in record order. */
  readonly basis: readonly string[];
  readonly category: DiagnosisCategory;
  /** Other in-scope supporting facts, in record order. */
  readonly contributing: readonly string[];
}

export type HintGateOutcome =
  | { readonly result: "authorized" }
  | { readonly result: "blocked"; readonly reason: "truncated" }
  | { readonly result: "unsupported" };

export interface ObservationLimits {
  /** Serialized bytes per OBSERVATION. Must be at least 2048. */
  readonly maxFactBytes?: number;
  /** Accepted connector facts per run. Must be at least 64. */
  readonly maxFacts?: number;
  /** Connector OBSERVATION messages that reach validation per window. */
  readonly maxPerWindow?: number;
  readonly windowMs?: number;
}

export interface CreateObservationRunInput {
  readonly declared: boolean;
  readonly descriptors: DiagnosticDescriptors;
  readonly limits?: ObservationLimits;
  readonly now?: () => number;
}

export interface ObservationRun {
  /** Runtime-owned raw byte count, or canonical JSON size for in-memory callers. */
  accept: (value: unknown, serializedBytes?: number) => AcceptOutcome;
  /**
   * Intake for one raw wire line. The byte bound is the runtime's own UTF-8
   * count of that line, taken before any parse. Nothing the connector sends
   * is read as a size.
   */
  acceptLine: (line: string) => AcceptOutcome;
  diagnose: (basis?: readonly string[]) => Diagnosis;
  /**
   * Section 5.11 gate for one connector hint. `authorized` means the runtime
   * may act on the action. Any other result means the hint is shown only as
   * the connector's suggestion, and the caller must not act on it.
   */
  gateRecoveryHint: (action: string, origin: RecoveryHintOrigin) => HintGateOutcome;
  /**
   * True when the connector emitted this id earlier in the run, whether the
   * fact was accepted or rejected. The ledger is bounded by the fact limit.
   */
  hasEmittedId: (id: string) => boolean;
  snapshot: () => ObservationSnapshot;
}

/** Syntax of an OBSERVATION id (schema `observationId`). */
export function isObservationIdSyntax(value: unknown): value is string {
  return validateObservationId(value) === true;
}

export type ObservationContractErrorCode =
  | "descriptor_schema"
  | "descriptor_duplicate_id"
  | "descriptor_undeclared_step"
  | "limits_invalid";

/** Bounded error. The message names a code, never the rejected input. */
export class ObservationContractError extends Error {
  readonly code: ObservationContractErrorCode;

  constructor(code: ObservationContractErrorCode) {
    super(`observation contract rejected: ${code}`);
    this.name = "ObservationContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Section 5.10.4 minimums. A runtime must accept at least this much. */
export const PROFILE_MINIMUM_FACTS = 64;
export const PROFILE_MINIMUM_FACT_BYTES = 2048;

export const DEFAULT_LIMITS: Required<ObservationLimits> = Object.freeze({
  maxFactBytes: 2048,
  maxFacts: 256,
  maxPerWindow: 256,
  windowMs: 1000,
});

const RUNTIME_FACT_TYPES: ReadonlySet<unknown> = new Set(["credential_submission", "rule_match", "connector_defect"]);

const CATEGORY_ORDER = ["auth_rejected", "expectation_mismatch"] as const;

/** The closed Section 5.5 vocabulary. Suggestions are bounded by it: 8 actions times 2 origins. */
const PORTABLE_RECOVERY_ACTIONS: ReadonlySet<string> = new Set<string>([
  "retry_by_runtime",
  "retry_on_connector_upgrade",
  "refresh_credentials",
  "manual_action_required",
  "update_selector",
  "upstream_unblock",
  "not_retriable",
  "unknown",
]);

// Hints the Section 5.11 gate holds in this version. Every other hint, portable
// or not, is unsupported.
const HINTS_THAT_HOLD: ReadonlySet<string> = new Set(["not_retriable", "unknown"]);

const HINT_UNSUPPORTED_ID = "runtime:connector_defect:hint_unsupported";
const PROTOCOL_VIOLATION_ID_PREFIX = "runtime:connector_defect:protocol_violation:";

// ---------------------------------------------------------------------------
// Canonical schema, compiled once
// ---------------------------------------------------------------------------

interface DescriptorsWire {
  readonly expectations?: readonly {
    readonly id: string;
    readonly step: string;
  }[];
  readonly rules?: readonly {
    readonly id: string;
    readonly kind: "auth";
    readonly step?: string;
  }[];
  readonly steps?: readonly { readonly id: string }[];
}

const ajv = new Ajv2020({ allErrors: false, strict: true });
ajv.addSchema(observationSchema);

const SCHEMA_ID = observationSchema.$id;

// The schema file is a build input. A missing definition is a packaging bug, so it fails at load.
function requireValidator<T>(validator: ValidateFunction<T> | undefined, name: string): ValidateFunction<T> {
  if (validator === undefined) {
    throw new Error(`observation schema definition is missing: ${name}`);
  }
  return validator;
}

const validateMessage = requireValidator(ajv.getSchema<ConnectorFact>(SCHEMA_ID), "observation");
const validateDescriptorsWire = requireValidator(
  ajv.getSchema<DescriptorsWire>(`${SCHEMA_ID}#/$defs/diagnosticDescriptors`),
  "diagnosticDescriptors"
);
const validateObservationId = requireValidator(
  ajv.getSchema<string>(`${SCHEMA_ID}#/$defs/observationId`),
  "observationId"
);

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * Validates the manifest `diagnostic_descriptors` member. An absent member (undefined)
 * normalizes to empty arrays. Throws ObservationContractError otherwise.
 */
export function validateDiagnosticDescriptors(value: unknown): DiagnosticDescriptors {
  if (value === undefined) {
    return { expectations: [], rules: [], steps: [] };
  }
  if (!validateDescriptorsWire(value)) {
    throw new ObservationContractError("descriptor_schema");
  }
  const steps = value.steps ?? [];
  const expectations = value.expectations ?? [];
  const rules = value.rules ?? [];

  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      throw new ObservationContractError("descriptor_duplicate_id");
    }
    stepIds.add(step.id);
  }
  const expectationIds = new Set<string>();
  for (const expectation of expectations) {
    if (expectationIds.has(expectation.id)) {
      throw new ObservationContractError("descriptor_duplicate_id");
    }
    expectationIds.add(expectation.id);
    if (!stepIds.has(expectation.step)) {
      throw new ObservationContractError("descriptor_undeclared_step");
    }
  }
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) {
      throw new ObservationContractError("descriptor_duplicate_id");
    }
    ruleIds.add(rule.id);
  }

  return {
    expectations: expectations.map((expectation) => ({
      id: expectation.id,
      step: expectation.step,
    })),
    rules: rules.map((rule) =>
      rule.step === undefined ? { id: rule.id, kind: rule.kind } : { id: rule.id, kind: rule.kind, step: rule.step }
    ),
    steps: steps.map((step) => ({ id: step.id })),
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

function resolveLimits(input: ObservationLimits | undefined): Required<ObservationLimits> {
  const limits: Required<ObservationLimits> = {
    ...DEFAULT_LIMITS,
    ...definedOnly(input),
  };
  const integers = [limits.maxFacts, limits.maxFactBytes, limits.maxPerWindow, limits.windowMs];
  if (integers.some((n) => !Number.isSafeInteger(n) || n < 1)) {
    throw new ObservationContractError("limits_invalid");
  }
  if (limits.maxFacts < PROFILE_MINIMUM_FACTS || limits.maxFactBytes < PROFILE_MINIMUM_FACT_BYTES) {
    throw new ObservationContractError("limits_invalid");
  }
  return limits;
}

function definedOnly(input: ObservationLimits | undefined): Partial<ObservationLimits> {
  const out: { -readonly [K in keyof ObservationLimits]?: number } = {};
  if (input?.maxFacts !== undefined) {
    out.maxFacts = input.maxFacts;
  }
  if (input?.maxFactBytes !== undefined) {
    out.maxFactBytes = input.maxFactBytes;
  }
  if (input?.maxPerWindow !== undefined) {
    out.maxPerWindow = input.maxPerWindow;
  }
  if (input?.windowMs !== undefined) {
    out.windowMs = input.windowMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface StoredFact {
  readonly fact: ConnectorFact;
  retired: boolean;
}

interface DeclaredScope {
  readonly expectationStep: ReadonlyMap<string, string>;
  readonly rules: ReadonlySet<string>;
  readonly steps: ReadonlySet<string>;
}

/** Creates the state of one run's OBSERVATION intake and diagnosis. */
export function createObservationRun(input: CreateObservationRunInput): ObservationRun {
  const limits = resolveLimits(input.limits);
  const now = input.now ?? Date.now;
  const scope: DeclaredScope = {
    expectationStep: new Map(input.descriptors.expectations.map((expectation) => [expectation.id, expectation.step])),
    rules: new Set(input.descriptors.rules.map((rule) => rule.id)),
    steps: new Set(input.descriptors.steps.map((step) => step.id)),
  };

  const facts: StoredFact[] = [];
  const factsById = new Map<string, StoredFact>();
  const observedIds = new Set<string>();
  const defects = new Map<string, RuntimeDefect>();
  // Keyed by origin and action. The key space is closed (2 origins x 8
  // actions), so the record is bounded without a cap.
  const suggestions = new Map<string, ConnectorSuggestion>();
  let truncated = false;
  let windowStart: number | undefined;
  let windowCount = 0;

  function recordProtocolViolation(reason: ObservationRejectReason): void {
    const id = `${PROTOCOL_VIOLATION_ID_PREFIX}${reason}`;
    const previous = defects.get(id);
    const count = previous?.class === "protocol_violation" ? previous.count + 1 : 1;
    defects.set(id, { class: "protocol_violation", count, id, reason });
  }

  function recordHintUnsupported(): void {
    const previous = defects.get(HINT_UNSUPPORTED_ID);
    const count = previous?.class === "hint_unsupported" ? previous.count + 1 : 1;
    defects.set(HINT_UNSUPPORTED_ID, {
      class: "hint_unsupported",
      count,
      id: HINT_UNSUPPORTED_ID,
    });
  }

  function reject(reason: ObservationRejectReason, limitHit: boolean): AcceptOutcome {
    recordProtocolViolation(reason);
    if (limitHit) {
      truncated = true;
    }
    return { reason, status: "rejected" };
  }

  // Fixed window on the injected clock. A clock that moves backwards starts a new window.
  function takeRateSlot(at: number): boolean {
    if (windowStart === undefined || at < windowStart || at - windowStart >= limits.windowMs) {
      windowStart = at;
      windowCount = 0;
    }
    if (windowCount >= limits.maxPerWindow) {
      return false;
    }
    windowCount += 1;
    return true;
  }

  function acceptLine(line: string): AcceptOutcome {
    if (!input.declared) {
      return reject("undeclared_capability", false);
    }
    const bytes = Buffer.byteLength(line, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return bytes > limits.maxFactBytes ? reject("oversize", true) : reject("invalid", false);
    }
    return accept(value, bytes);
  }

  function accept(value: unknown, serializedBytes?: number): AcceptOutcome {
    if (!input.declared) {
      return reject("undeclared_capability", false);
    }
    const bytes = serializedBytes ?? measureBytes(value);
    if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes < 0) {
      return reject("invalid", false);
    }
    // Even a discarded fact has emitted its id (Sections 5.8 and 5.10.2).
    const duplicate = rememberEmittedId(value);
    if (duplicate) {
      return duplicate;
    }
    if (bytes > limits.maxFactBytes) {
      return reject("oversize", true);
    }
    return admitParsed(value);
  }

  function hasEmittedId(id: string): boolean {
    return observedIds.has(id);
  }

  function rememberEmittedId(value: unknown): AcceptOutcome | null {
    // An invalid fact still used its id. Bound this ledger independently
    // so a stream of malformed messages cannot consume unbounded memory.
    if (typeof value === "object" && value !== null && "id" in value && validateObservationId(value.id)) {
      if (observedIds.has(value.id)) {
        return reject("duplicate_id", false);
      }
      if (observedIds.size >= limits.maxFacts) {
        return reject("count_exceeded", true);
      }
      observedIds.add(value.id);
    }
    return null;
  }

  function admitParsed(value: unknown): AcceptOutcome {
    if (!takeRateSlot(now())) {
      return reject("count_exceeded", true);
    }
    if (facts.length >= limits.maxFacts) {
      return reject("count_exceeded", true);
    }

    if (isRuntimeFactType(value)) {
      return reject("runtime_fact_type", false);
    }
    if (!validateMessage(value)) {
      return reject("invalid", false);
    }
    const fact = cloneFrozen(value);
    if (fact === undefined) {
      return reject("invalid", false);
    }
    if (fact.fact === "element_expectation" && !fact.attrs.states_seen.includes(fact.attrs.final)) {
      return reject("invalid", false);
    }
    // Retirement applies only to earlier accepted connector facts. Unknown ids are a no-op.
    const retired: string[] = [];
    for (const id of fact.resolves ?? []) {
      const target = factsById.get(id);
      if (target !== undefined && !target.retired) {
        target.retired = true;
        retired.push(id);
      }
    }

    const stored: StoredFact = { fact, retired: false };
    facts.push(stored);
    factsById.set(fact.id, stored);
    return { id: fact.id, retired, status: "accepted" };
  }

  function snapshot(): ObservationSnapshot {
    const connectorSuggestions = [...suggestions.values()];
    return Object.freeze({
      defects: [...defects.values()].map((defect) => Object.freeze({ ...defect })),
      facts: facts.map((stored) => Object.freeze({ ...stored.fact, retired: stored.retired })),
      truncated,
      ...(connectorSuggestions.length > 0
        ? {
            connector_suggestions: Object.freeze(connectorSuggestions.map((s) => Object.freeze({ ...s }))),
          }
        : {}),
    });
  }

  function diagnose(basis: readonly string[] = []): Diagnosis {
    const cited = new Set(basis);
    const findings: { readonly id: string; readonly category: Category }[] = [];
    for (const stored of facts) {
      if (stored.retired || !cited.has(stored.fact.id)) {
        continue;
      }
      const category = findingOf(stored.fact, scope);
      if (category !== undefined) {
        findings.push({ category, id: stored.fact.id });
      }
    }
    for (const category of CATEGORY_ORDER) {
      const supporting = findings.filter((finding) => finding.category === category).map((finding) => finding.id);
      if (supporting.length === 0) {
        continue;
      }
      return {
        attribution: "connector",
        basis: supporting,
        category,
        contributing: findings.filter((finding) => finding.category !== category).map((finding) => finding.id),
      };
    }
    return {
      attribution: "none",
      basis: [],
      category: "unknown",
      contributing: [],
    };
  }

  function recordSuggestion(action: string, origin: RecoveryHintOrigin): void {
    if (!isPortableAction(action)) {
      return;
    }
    const key = `${origin}:${action}`;
    if (!suggestions.has(key)) {
      suggestions.set(key, { action, attribution: "connector", origin });
    }
  }

  function gateRecoveryHint(action: string, origin: RecoveryHintOrigin): HintGateOutcome {
    if (!HINTS_THAT_HOLD.has(action)) {
      recordSuggestion(action, origin);
      if (input.declared) {
        recordHintUnsupported();
      }
      return { result: "unsupported" };
    }
    if (truncated) {
      recordSuggestion(action, origin);
      if (input.declared) {
        recordHintUnsupported();
      }
      return { reason: "truncated", result: "blocked" };
    }
    return { result: "authorized" };
  }

  return {
    accept,
    acceptLine,
    diagnose,
    gateRecoveryHint,
    hasEmittedId,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Category = (typeof CATEGORY_ORDER)[number];

/** The diagnosis category a fact supports, or undefined when it supports nothing in this scope. */
function findingOf(fact: ConnectorFact, scope: DeclaredScope): Category | undefined {
  switch (fact.fact) {
    case "provider_message": {
      if (fact.attrs.kind !== "auth_failure") {
        return undefined;
      }
      if (fact.step !== undefined && !scope.steps.has(fact.step)) {
        return undefined;
      }
      if (fact.attrs.rule !== undefined && !scope.rules.has(fact.attrs.rule)) {
        return undefined;
      }
      return "auth_rejected";
    }
    case "element_expectation": {
      if (fact.attrs.final === "matched") {
        return undefined;
      }
      if (!scope.steps.has(fact.step)) {
        return undefined;
      }
      return scope.expectationStep.get(fact.attrs.expectation) === fact.step ? "expectation_mismatch" : undefined;
    }
    case "wait_expired":
      return undefined;
  }
}

function isPortableAction(value: string): value is PortableRecoveryAction {
  return PORTABLE_RECOVERY_ACTIONS.has(value);
}

function isRuntimeFactType(value: unknown): boolean {
  return typeof value === "object" && value !== null && "fact" in value && RUNTIME_FACT_TYPES.has(value.fact);
}

function measureBytes(value: unknown): number | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return typeof json === "string" ? Buffer.byteLength(json, "utf8") : undefined;
}

/** Copies a validated message so no caller reference is retained, then freezes the copy. */
function cloneFrozen(value: ConnectorFact): ConnectorFact | undefined {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

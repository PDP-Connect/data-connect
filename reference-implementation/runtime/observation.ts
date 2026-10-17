// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile 0.2.0 Sections 3.8 and 5.10. Schemas follow
// data-connectors 9e70c433 packages/polyfill-connectors/src/observation.ts.
// This first slice records connector facts and protocol defects only. Runtime
// credential submissions require a separate, runtime-owned attempt ledger.
import { z } from "zod";

export const OBSERVATION_CAPABILITY = "OBSERVATION";

/**
 * Per-run limits. The runtime discards everything past the limits and marks
 * the run record truncated.
 * Evidence from a truncated record never authorizes a recovery action.
 */
export const OBSERVATION_LIMITS = Object.freeze({
  maxLineBytes: 2048,
  maxPerRun: 64,
  maxResolves: 64,
  maxStatesSeen: 5,
});

export const ELEMENT_STATES = ["matched", "absent", "hidden", "disabled", "ambiguous"] as const;

export const PROVIDER_MESSAGE_KINDS = ["auth_failure", "other"] as const;

/** Fact types a connector may put in an `OBSERVATION`. */
export const CONNECTOR_FACT_TYPES = ["element_expectation", "wait_expired", "provider_message"] as const;

/** Fact types only the runtime records. A connector that sends one commits a
 *  protocol violation; the runtime discards the fact. */
export const RUNTIME_FACT_TYPES = ["credential_submission", "rule_match", "connector_defect"] as const;

export const RULE_KINDS = ["auth"] as const;
/** Closed set: no connector string ever reaches a runtime record. */
export const PROTOCOL_VIOLATION_REASONS = [
  "undeclared_capability",
  "runtime_fact_type",
  "invalid",
  "duplicate_id",
  "oversize",
  "count_exceeded",
] as const;
export type ProtocolViolationReason = (typeof PROTOCOL_VIOLATION_REASONS)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────

/** Step, expectation and rule ids: the connector's declared descriptors. */
export const DESCRIPTOR_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OBSERVATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Runtime-local handles or relative artifact paths, never arbitrary URI
 * schemes or inline payloads. References are inert; this store reads no file. */
const EVIDENCE_REF_RE = /^(?:(?:trace|page|screenshot|artifact):)?[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const descriptorId = z.string().regex(DESCRIPTOR_ID_RE);
const observationId = z.string().regex(OBSERVATION_ID_RE);
const evidenceRef = z.string().max(256).regex(EVIDENCE_REF_RE);

const elementExpectationAttrs = z
  .strictObject({
    expectation: descriptorId,
    fallback_used: z.boolean().optional(),
    final: z.enum(ELEMENT_STATES),
    states_seen: z.array(z.enum(ELEMENT_STATES)).min(1).max(OBSERVATION_LIMITS.maxStatesSeen),
  })
  .refine(
    (attrs) => attrs.states_seen.includes(attrs.final) && new Set(attrs.states_seen).size === attrs.states_seen.length,
    {
      message: "final must be one of states_seen",
    }
  );

const waitExpiredAttrs = z.strictObject({
  awaited: descriptorId,
  budget_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const providerMessageAttrs = z.strictObject({
  kind: z.enum(PROVIDER_MESSAGE_KINDS),
  rule: descriptorId.optional(),
});

const messageBase = {
  evidence_ref: evidenceRef.optional(),
  id: observationId,
  resolves: z.array(observationId).min(1).max(OBSERVATION_LIMITS.maxResolves).optional(),
  type: z.literal("OBSERVATION"),
};

/** One connector `OBSERVATION` message as it appears on standard output. */
export const observationMessageSchema = z.discriminatedUnion("fact", [
  z.strictObject({
    ...messageBase,
    attrs: elementExpectationAttrs,
    fact: z.literal("element_expectation"),
    step: descriptorId,
  }),
  z.strictObject({
    ...messageBase,
    attrs: waitExpiredAttrs,
    fact: z.literal("wait_expired"),
    step: descriptorId,
  }),
  z.strictObject({
    ...messageBase,
    attrs: providerMessageAttrs,
    fact: z.literal("provider_message"),
    step: descriptorId.optional(),
  }),
]);
export type ObservationMessage = z.infer<typeof observationMessageSchema>;

export const diagnosticDescriptorsSchema = z
  .strictObject({
    expectations: z
      .array(z.strictObject({ id: descriptorId, step: descriptorId }))
      .max(256)
      .optional(),
    rules: z
      .array(
        z.strictObject({
          id: descriptorId,
          kind: z.enum(RULE_KINDS),
          step: descriptorId.optional(),
        })
      )
      .max(64)
      .optional(),
    steps: z
      .array(z.strictObject({ id: descriptorId }))
      .max(64)
      .optional(),
  })
  .superRefine((value, context) => {
    for (const entries of [value.steps, value.expectations, value.rules]) {
      if (entries && new Set(entries.map((entry) => entry.id)).size !== entries.length) {
        context.addIssue({ code: "custom", message: "descriptor ids must be unique" });
      }
    }
    const steps = new Set(value.steps?.map((entry) => entry.id));
    if (
      value.expectations?.some((entry) => !steps.has(entry.step)) ||
      value.rules?.some((entry) => entry.step !== undefined && !steps.has(entry.step))
    ) {
      context.addIssue({ code: "custom", message: "descriptor step must be declared" });
    }
  });
export type DiagnosticDescriptors = z.infer<typeof diagnosticDescriptorsSchema>;

type WithProvenance<Message> = Message extends unknown ? Omit<Message, "type"> & { source: "connector" } : never;
export type ConnectorRunRecordFact = WithProvenance<ObservationMessage>;
export interface ConnectorDefect {
  attrs: { class: "protocol_violation"; reason: ProtocolViolationReason; count: number };
  fact: "connector_defect";
  id: string;
  source: "runtime";
}
export interface ObservationDone {
  error: { basis?: readonly string[] } | null;
  status: string;
}
export interface ObservationRunRecord {
  diagnostic_descriptors?: DiagnosticDescriptors;
  done?: ObservationDone | null;
  facts: (ConnectorRunRecordFact | ConnectorDefect)[];
  process_exit?: { code: number | null };
  protocol_capabilities: string[];
  truncated: boolean;
}

/** Run-local store: bounded facts and one aggregate defect per reason. Raw
 * connector text is never copied into a runtime record. Defect ids occupy a
 * separate provenance namespace; connector resolves/basis cannot cite them. */
export function createObservationRunRecord(manifest: Record<string, unknown>) {
  const capabilities = Array.isArray(manifest.protocol_capabilities)
    ? manifest.protocol_capabilities.filter((value): value is string => typeof value === "string").slice(0, 16)
    : [];
  const declared = capabilities.includes(OBSERVATION_CAPABILITY);
  const descriptors = diagnosticDescriptorsSchema.safeParse(manifest.diagnostic_descriptors);
  const facts: ConnectorRunRecordFact[] = [];
  const ids = new Set<string>();
  const violations = new Map<ProtocolViolationReason, number>();
  let truncated = false;
  const discard = (reason: ProtocolViolationReason) => {
    violations.set(reason, Math.min(Number.MAX_SAFE_INTEGER, (violations.get(reason) ?? 0) + 1));
    if (reason === "count_exceeded" || reason === "oversize") {
      truncated = true;
    }
    return false;
  };
  return {
    accept(raw: unknown, lineBytes: number): boolean {
      if (!declared) {
        return discard("undeclared_capability");
      }
      if (lineBytes > OBSERVATION_LIMITS.maxLineBytes) {
        return discard("oversize");
      }
      if (raw && typeof raw === "object" && RUNTIME_FACT_TYPES.includes(Reflect.get(raw, "fact"))) {
        return discard("runtime_fact_type");
      }
      const parsed = observationMessageSchema.safeParse(raw);
      if (!parsed.success) {
        return discard("invalid");
      }
      const message = parsed.data;
      if (ids.has(message.id)) {
        return discard("duplicate_id");
      }
      if (message.resolves?.some((id) => !ids.has(id))) {
        return discard("invalid");
      }
      if (facts.length >= OBSERVATION_LIMITS.maxPerRun) {
        return discard("count_exceeded");
      }
      ids.add(message.id);
      const { type: _type, ...fact } = message;
      facts.push({ ...fact, source: "connector" });
      return true;
    },
    declared,
    hasConnectorId: (id: string) => ids.has(id),
    snapshot(): ObservationRunRecord {
      const defects: ConnectorDefect[] = [...violations].map(([reason, count], index) => ({
        attrs: { class: "protocol_violation", count, reason },
        fact: "connector_defect",
        id: `r${index + 1}`,
        source: "runtime",
      }));
      return {
        protocol_capabilities: capabilities,
        ...(descriptors.success ? { diagnostic_descriptors: descriptors.data } : {}),
        facts: [...facts, ...defects],
        truncated,
      };
    },
  };
}

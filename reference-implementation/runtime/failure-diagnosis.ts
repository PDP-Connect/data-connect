// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile 0.2.0 Section 5.11. This slice has no runtime-performed
// credential submissions: every supported cause is the connector's account.
// Recompute from the persisted run record; never infer from text or hints.
import type { ConnectorRunRecordFact, ObservationDone, ObservationRunRecord } from "./observation.ts";

type CauseCategory = "auth_rejected" | "expectation_mismatch";
interface Finding {
  attribution: "connector";
  basis: string[];
  category: CauseCategory;
}

function supportedCategory(fact: ConnectorRunRecordFact, record: ObservationRunRecord): CauseCategory | null {
  const descriptors = record.diagnostic_descriptors;
  if (fact.step && !descriptors?.steps?.some((step) => step.id === fact.step)) {
    return null;
  }
  if (fact.fact === "provider_message") {
    if (fact.attrs.rule && !descriptors?.rules?.some((rule) => rule.id === fact.attrs.rule && rule.kind === "auth")) {
      return null;
    }
    return fact.attrs.kind === "auth_failure" ? "auth_rejected" : null;
  }
  if (
    fact.fact === "element_expectation" &&
    fact.attrs.final !== "matched" &&
    descriptors?.expectations?.some(
      (expectation) => expectation.id === fact.attrs.expectation && expectation.step === fact.step
    )
  ) {
    return "expectation_mismatch";
  }
  return null;
}

export function diagnoseObservationFailure(
  record: ObservationRunRecord,
  done: ObservationDone | null = record.done ?? null
) {
  const retired = new Set<string>();
  for (const fact of record.facts) {
    if (fact.source === "connector") {
      for (const id of fact.resolves ?? []) {
        retired.add(id);
      }
    }
  }
  const basis = new Set(done?.error?.basis ?? []);
  const findings: Finding[] = [];
  for (const category of ["auth_rejected", "expectation_mismatch"] as const) {
    const ids = record.facts
      .filter(
        (fact) =>
          fact.source === "connector" &&
          !retired.has(fact.id) &&
          basis.has(fact.id) &&
          supportedCategory(fact, record) === category
      )
      .map((fact) => fact.id);
    if (ids.length) {
      findings.push({ attribution: "connector", basis: ids, category });
    }
  }
  return {
    cause: findings[0] ?? { attribution: "none", basis: [], category: "unknown" },
    classifier: "fd-classifier@0.2.0",
    contributing: findings.slice(1),
    facts: record.facts.map((fact) => ({
      id: fact.id,
      in_scope: fact.source === "connector" && !retired.has(fact.id) && basis.has(fact.id),
      retired: fact.source === "connector" && retired.has(fact.id),
      source: fact.source,
    })),
    terminal_event: done?.status === "failed" ? "failed_done" : "process_exit",
    truncated: record.truncated,
  };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Due-dose evaluation against a simplified Dominican Republic PAI childhood
// schedule (the same schedule the synthetic registry data is generated from,
// ../../baseline/lib/dataset.ts). Log only: the service sends nothing.

import { SCHEDULE } from "../../baseline/lib/dataset.ts";
import { DAY_MS } from "./clock.ts";

export interface RecordDose {
  date: string;
  dose_number: number;
  vaccine: string;
}

export interface ImmunizationRecord {
  birth_date: string;
  child_id: string;
  doses: RecordDose[];
}

export interface DueDose {
  due_date: string;
  dose_number: number;
  /** "overdue": due date passed; "due": due within the look-ahead window. */
  status: "due" | "overdue";
  vaccine: string;
}

/**
 * Returns the earliest schedule step not yet recorded whose due date is on or
 * before `now + lookAheadDays`, or null. Doses within one vaccine series are
 * sequential: dose N is only considered once doses 1..N-1 are recorded.
 */
export function evaluateDueDose(record: ImmunizationRecord, now: number, lookAheadDays = 7): DueDose | null {
  const birthMs = Date.parse(`${record.birth_date}T00:00:00Z`);
  if (!Number.isFinite(birthMs)) {
    return null;
  }
  const given = new Set(record.doses.map((d) => `${d.vaccine}#${d.dose_number}`));
  const horizon = now + lookAheadDays * DAY_MS;
  let best: DueDose | null = null;
  for (const step of SCHEDULE) {
    if (given.has(`${step.vaccine}#${step.dose_number}`)) {
      continue;
    }
    const priorMissing = SCHEDULE.some(
      (s) => s.vaccine === step.vaccine && s.dose_number < step.dose_number && !given.has(`${s.vaccine}#${s.dose_number}`)
    );
    if (priorMissing) {
      continue;
    }
    const dueMs = birthMs + step.age_days * DAY_MS;
    if (dueMs > horizon) {
      continue;
    }
    if (!best || dueMs < Date.parse(`${best.due_date}T00:00:00Z`)) {
      best = {
        due_date: new Date(dueMs).toISOString().slice(0, 10),
        dose_number: step.dose_number,
        status: dueMs < now ? "overdue" : "due",
        vaccine: step.vaccine,
      };
    }
  }
  return best;
}

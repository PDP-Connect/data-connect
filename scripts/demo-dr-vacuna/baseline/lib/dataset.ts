// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic synthetic childhood immunization records for the DR pilot
// load test. Every child is generated from (SEED, index) alone, so any
// process can regenerate child N without reading the others.

export const SEED = 20_261_014;
export const CENTRE_COUNT = 1400;
/** Records are "as of" this date; birth dates fall in the five years before. */
export const REFERENCE_DATE = "2026-10-01";
const BIRTH_WINDOW_DAYS = 5 * 365;
const DAY_MS = 86_400_000;
const REFERENCE_MS = Date.parse(`${REFERENCE_DATE}T00:00:00Z`);

/**
 * Simplified Programa Ampliado de Inmunización (PAI) schedule for the
 * Dominican Republic: vaccine, dose number within that vaccine, age in days.
 * Pentavalente = DPT + HepB + Hib; SRP = MMR; DPT entries are the 18-month
 * and 4-year boosters; Polio doses 4-5 are the boosters.
 */
export const SCHEDULE: readonly { age_days: number; dose_number: number; vaccine: string }[] = [
  { age_days: 0, dose_number: 1, vaccine: "BCG" },
  { age_days: 0, dose_number: 1, vaccine: "HepB" },
  { age_days: 60, dose_number: 1, vaccine: "Pentavalente" },
  { age_days: 60, dose_number: 1, vaccine: "Polio" },
  { age_days: 60, dose_number: 1, vaccine: "Rotavirus" },
  { age_days: 60, dose_number: 1, vaccine: "Neumococo" },
  { age_days: 120, dose_number: 2, vaccine: "Pentavalente" },
  { age_days: 120, dose_number: 2, vaccine: "Polio" },
  { age_days: 120, dose_number: 2, vaccine: "Rotavirus" },
  { age_days: 120, dose_number: 2, vaccine: "Neumococo" },
  { age_days: 180, dose_number: 3, vaccine: "Pentavalente" },
  { age_days: 180, dose_number: 3, vaccine: "Polio" },
  { age_days: 365, dose_number: 1, vaccine: "SRP" },
  { age_days: 365, dose_number: 3, vaccine: "Neumococo" },
  { age_days: 540, dose_number: 2, vaccine: "SRP" },
  { age_days: 540, dose_number: 1, vaccine: "DPT" },
  { age_days: 540, dose_number: 4, vaccine: "Polio" },
  { age_days: 1460, dose_number: 2, vaccine: "DPT" },
  { age_days: 1460, dose_number: 5, vaccine: "Polio" },
];

export interface Dose {
  centre_code: string;
  date: string;
  dose_number: number;
  vaccine: string;
}

export interface ChildRecord {
  birth_date: string;
  child_id: string;
  doses: Dose[];
  next_dose_due: { due_date: string; dose_number: number; vaccine: string } | null;
  updated_at: string;
}

/** mulberry32: small, fast, deterministic 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function childRng(index: number): () => number {
  // Mix the index into the seed so neighbouring children are uncorrelated.
  return mulberry32(Math.imul(SEED ^ index, 0x9e_37_79_b1) ^ (index >>> 16));
}

export function childId(index: number): string {
  return `DR-${String(index).padStart(7, "0")}`;
}

export function centreCode(n: number): string {
  return `CV-${String(n).padStart(4, "0")}`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Probability a due dose was given, by age at which it is due. */
function coverageFor(ageDays: number): number {
  if (ageDays === 0) {
    return 0.97;
  }
  if (ageDays <= 180) {
    return 0.92;
  }
  if (ageDays <= 540) {
    return 0.86;
  }
  return 0.78;
}

/** Generate child `index` (1-based). Pure function of (SEED, index). */
export function generateChild(index: number): ChildRecord {
  const rng = childRng(index);
  const birthMs = REFERENCE_MS - Math.floor(rng() * BIRTH_WINDOW_DAYS) * DAY_MS;
  const homeCentre = 1 + Math.floor(rng() * CENTRE_COUNT);
  const haltedSeries = new Set<string>();
  const doses: Dose[] = [];
  let nextDue: ChildRecord["next_dose_due"] = null;

  for (const step of SCHEDULE) {
    const dueMs = birthMs + step.age_days * DAY_MS;
    const given = !haltedSeries.has(step.vaccine) && rng() < coverageFor(step.age_days);
    // Delay after the due date: mostly days, sometimes weeks.
    const lagDays = Math.floor(-Math.log(1 - rng() * 0.999) * 12);
    const givenMs = dueMs + lagDays * DAY_MS;
    if (given && givenMs <= REFERENCE_MS) {
      const centre = rng() < 0.85 ? homeCentre : 1 + Math.floor(rng() * CENTRE_COUNT);
      doses.push({
        centre_code: centreCode(centre),
        date: isoDate(givenMs),
        dose_number: step.dose_number,
        vaccine: step.vaccine,
      });
      continue;
    }
    if (!given && dueMs <= REFERENCE_MS) {
      // A missed dose stops the series for this child until caught up.
      haltedSeries.add(step.vaccine);
    }
    if (nextDue === null || dueMs < Date.parse(`${nextDue.due_date}T00:00:00Z`)) {
      nextDue = { due_date: isoDate(dueMs), dose_number: step.dose_number, vaccine: step.vaccine };
    }
  }

  const lastDoseDate = doses.reduce((latest, d) => (d.date > latest ? d.date : latest), isoDate(birthMs));
  return {
    birth_date: isoDate(birthMs),
    child_id: childId(index),
    doses,
    next_dose_due: nextDue,
    updated_at: `${lastDoseDate}T00:00:00Z`,
  };
}

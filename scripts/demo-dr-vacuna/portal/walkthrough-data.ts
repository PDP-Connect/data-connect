// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixed, fictitious dataset for the guided walkthrough of the "Vacuna al día"
// pilot: 10 adults, 15 children, one guardianship per (adult, child). Every
// account signs in with the same demo password (WALKTHROUGH_PASSWORD).
// TEST-CREDENTIALS.md lists the same accounts; keep the two in step.
//
// Vaccination records are a pure function of this file: doses follow the
// simplified PAI schedule (../baseline/lib/dataset.ts) up to REFERENCE_DATE,
// minus the doses listed in `missing`.

import { SCHEDULE } from "../baseline/lib/dataset.ts";

/** Shared demo password for every walkthrough account. Not a real credential. */
export const WALKTHROUGH_PASSWORD = "VacunaAlDia2026";

/** Records are "as of" this date. */
export const REFERENCE_DATE = "2026-10-14";

export interface WalkthroughAdult {
  cedula: string;
  /** What this account demonstrates (ES / EN), for TEST-CREDENTIALS.md. */
  demonstrates: readonly [string, string];
  family_name: string;
  given_name: string;
}

export interface WalkthroughChild {
  birth_date: string;
  child_id: string;
  family_name: string;
  given_name: string;
  /** Schedule doses not given, as "Vaccine#dose". */
  missing?: readonly string[];
}

export interface WalkthroughGuardianship {
  capacity: "parent" | "legal_guardian";
  cedula: string;
  child_id: string;
  status: "active" | "suspended";
}

export const ADULTS: readonly WalkthroughAdult[] = [
  {
    cedula: "00100000011",
    demonstrates: ["Madre con una sola hija", "Mother with one child"],
    family_name: "Rodríguez",
    given_name: "María",
  },
  {
    cedula: "00100000022",
    demonstrates: ["Madre con dos hijos (elige a cuál conectar)", "Mother with two children (picks which one)"],
    family_name: "Pérez",
    given_name: "Carmen",
  },
  {
    cedula: "00100000033",
    demonstrates: ["Padre que comparte un hijo con Rosa", "Father who shares a child with Rosa"],
    family_name: "Martínez",
    given_name: "Juan",
  },
  {
    cedula: "00100000044",
    demonstrates: [
      "Madre que comparte un hijo con Juan: ve y puede retirar lo que él aprobó",
      "Mother who shares a child with Juan: sees and can withdraw what he approved",
    ],
    family_name: "Martínez",
    given_name: "Rosa",
  },
  {
    cedula: "00100000055",
    demonstrates: ["Tutor legal (no es el padre) de dos hermanos", "Legal guardian (not a parent) of two siblings"],
    family_name: "Jiménez",
    given_name: "Ramón",
  },
  {
    cedula: "00100000066",
    demonstrates: [
      "El Registro Civil lo rechaza: su autoridad sobre Camila está suspendida",
      "The civil registry refuses him: his authority over Camila is suspended",
    ],
    family_name: "Gómez",
    given_name: "Pedro",
  },
  {
    cedula: "00100000077",
    demonstrates: [
      "Hijo de 17 años: la autorización vence en su cumpleaños 18",
      "17-year-old son: the authorization ends on his 18th birthday",
    ],
    family_name: "Fernández",
    given_name: "Altagracia",
  },
  {
    cedula: "00100000088",
    demonstrates: ["Madre de tres, incluido un recién nacido", "Mother of three, including a newborn"],
    family_name: "Castillo",
    given_name: "Yolanda",
  },
  {
    cedula: "00100000099",
    demonstrates: ["Padre de los mismos tres niños que Yolanda", "Father of the same three children as Yolanda"],
    family_name: "Castillo",
    given_name: "Francisco",
  },
  {
    cedula: "00100000100",
    demonstrates: ["Madre con dos hijos pequeños", "Mother with two young children"],
    family_name: "Santos",
    given_name: "Elena",
  },
];

export const CHILDREN: readonly WalkthroughChild[] = [
  { birth_date: "2026-06-20", child_id: "DR-9100001", family_name: "Rodríguez", given_name: "Sofía" },
  { birth_date: "2022-11-02", child_id: "DR-9100002", family_name: "Pérez", given_name: "Luis" },
  {
    birth_date: "2026-02-10",
    child_id: "DR-9100003",
    family_name: "Pérez",
    given_name: "Ana",
    missing: ["Pentavalente#3", "Polio#3"],
  },
  { birth_date: "2025-09-30", child_id: "DR-9100004", family_name: "Martínez", given_name: "Diego" },
  { birth_date: "2023-04-15", child_id: "DR-9100005", family_name: "Cruz", given_name: "Valentina" },
  { birth_date: "2021-07-08", child_id: "DR-9100006", family_name: "Cruz", given_name: "Tomás" },
  { birth_date: "2024-01-20", child_id: "DR-9100007", family_name: "Gómez", given_name: "Camila" },
  { birth_date: "2008-11-20", child_id: "DR-9100008", family_name: "Fernández", given_name: "Miguel" },
  { birth_date: "2014-03-03", child_id: "DR-9100009", family_name: "Fernández", given_name: "Paula" },
  { birth_date: "2021-10-25", child_id: "DR-9100010", family_name: "Castillo", given_name: "Gabriel" },
  { birth_date: "2023-08-08", child_id: "DR-9100011", family_name: "Castillo", given_name: "Isabella" },
  { birth_date: "2026-09-10", child_id: "DR-9100012", family_name: "Castillo", given_name: "Samuel" },
  { birth_date: "2024-12-01", child_id: "DR-9100013", family_name: "Santos", given_name: "Lucía" },
  { birth_date: "2026-04-05", child_id: "DR-9100014", family_name: "Santos", given_name: "Mateo" },
  {
    birth_date: "2025-03-18",
    child_id: "DR-9100015",
    family_name: "Santos",
    given_name: "Daniel",
    missing: ["SRP#1"],
  },
];

const parent = (cedula: string, child_id: string): WalkthroughGuardianship => ({
  capacity: "parent",
  cedula,
  child_id,
  status: "active",
});

export const GUARDIANSHIPS: readonly WalkthroughGuardianship[] = [
  parent("00100000011", "DR-9100001"),
  parent("00100000022", "DR-9100002"),
  parent("00100000022", "DR-9100003"),
  parent("00100000033", "DR-9100004"),
  parent("00100000044", "DR-9100004"),
  { capacity: "legal_guardian", cedula: "00100000055", child_id: "DR-9100005", status: "active" },
  { capacity: "legal_guardian", cedula: "00100000055", child_id: "DR-9100006", status: "active" },
  { capacity: "parent", cedula: "00100000066", child_id: "DR-9100007", status: "suspended" },
  parent("00100000077", "DR-9100008"),
  parent("00100000077", "DR-9100009"),
  parent("00100000088", "DR-9100010"),
  parent("00100000088", "DR-9100011"),
  parent("00100000088", "DR-9100012"),
  parent("00100000099", "DR-9100010"),
  parent("00100000099", "DR-9100011"),
  parent("00100000099", "DR-9100012"),
  parent("00100000100", "DR-9100013"),
  parent("00100000100", "DR-9100014"),
  parent("00100000100", "DR-9100015"),
];

const DAY_MS = 86_400_000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The child's immunization record as the register holds it on REFERENCE_DATE. */
export function walkthroughRecord(child: WalkthroughChild) {
  const birthMs = Date.parse(`${child.birth_date}T00:00:00Z`);
  const referenceMs = Date.parse(`${REFERENCE_DATE}T00:00:00Z`);
  const missing = new Set(child.missing ?? []);
  const halted = new Set<string>();
  const doses: Array<{ centre_code: string; date: string; dose_number: number; vaccine: string }> = [];
  let next = null as { due_date: string; dose_number: number; vaccine: string } | null;
  SCHEDULE.forEach((step, i) => {
    const dueMs = birthMs + step.age_days * DAY_MS;
    const key = `${step.vaccine}#${step.dose_number}`;
    // A few days' delay, varied but deterministic.
    const givenMs = dueMs + ((i * 3 + child.child_id.length) % 9) * DAY_MS;
    if (!(halted.has(step.vaccine) || missing.has(key)) && givenMs <= referenceMs) {
      doses.push({ centre_code: "CV-0101", date: isoDate(givenMs), dose_number: step.dose_number, vaccine: step.vaccine });
      return;
    }
    halted.add(step.vaccine);
    if (!next || dueMs < Date.parse(`${next.due_date}T00:00:00Z`)) {
      next = { due_date: isoDate(dueMs), dose_number: step.dose_number, vaccine: step.vaccine };
    }
  });
  const updated = doses.reduce((latest, d) => (d.date > latest ? d.date : latest), child.birth_date);
  return {
    birth_date: child.birth_date,
    child_id: child.child_id,
    doses,
    next_dose_due: next,
    updated_at: `${updated}T00:00:00Z`,
  };
}

/** "00100000011" -> "001-0000001-1" */
export function formatCedula(cedula: string): string {
  return `${cedula.slice(0, 3)}-${cedula.slice(3, 10)}-${cedula.slice(10)}`;
}

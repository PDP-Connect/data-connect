// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic synthetic families for the civil-registry stub: parents with
// cédulas, children (DR-0000001..), and parent/legal-guardian relationships.
// Pure function of (SEED, child total): every run produces the same registry.
//
// Children are taken in order and grouped into families of 1-3 siblings
// (50% / 27% / 23%, mean 1.73). 14.7% of families have two parents and 3%
// have a single legal guardian instead of a parent, so 980,200 children give
// about 650,000 adults.

import { generateChild } from "../../baseline/lib/dataset.ts";

export const FAMILY_SEED = 20_261_015;

const GIVEN_F = [
  "María",
  "Ana",
  "Rosa",
  "Carmen",
  "Yolanda",
  "Altagracia",
  "Juana",
  "Luz",
  "Mercedes",
  "Francisca",
  "Yanet",
  "Daniela",
  "Paola",
  "Esther",
  "Ramona",
  "Wendy",
  "Katherine",
  "Yokasta",
  "Teresa",
  "Margarita",
];
const GIVEN_M = [
  "José",
  "Juan",
  "Luis",
  "Carlos",
  "Pedro",
  "Manuel",
  "Rafael",
  "Francisco",
  "Ramón",
  "Miguel",
  "Julio",
  "Ángel",
  "Félix",
  "Wilson",
  "Héctor",
  "Andrés",
  "Domingo",
  "Víctor",
  "Freddy",
  "Santo",
];
const GIVEN_CHILD = [
  "Sofía",
  "Isabella",
  "Valentina",
  "Camila",
  "Emma",
  "Mía",
  "Luciana",
  "Victoria",
  "Génesis",
  "Ashley",
  "Santiago",
  "Mateo",
  "Liam",
  "Sebastián",
  "Dylan",
  "Thiago",
  "Gael",
  "Samuel",
  "Jayden",
  "Emmanuel",
];
const FAMILY = [
  "Rodríguez",
  "Pérez",
  "Martínez",
  "García",
  "Santos",
  "Reyes",
  "Ramírez",
  "Díaz",
  "Hernández",
  "Gómez",
  "Jiménez",
  "Peña",
  "Rosario",
  "De la Cruz",
  "Castillo",
  "Núñez",
  "Batista",
  "Féliz",
  "Mejía",
  "Cruz",
  "Vásquez",
  "Tavárez",
  "Polanco",
  "Almonte",
  "Guzmán",
];

export interface Parent {
  cedula: string;
  family_name: string;
  given_name: string;
  index: number;
}

export interface Child {
  birth_date: string;
  child_id: string;
  family_name: string;
  given_name: string;
  index: number;
}

export interface Guardianship {
  capacity: "legal_guardian" | "parent";
  child_id: string;
  parent_cedula: string;
}

export interface Family {
  children: Child[];
  guardianships: Guardianship[];
  index: number;
  parents: Parent[];
}

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

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)] as T;
}

/** Luhn check digit, as used by the Dominican cédula. */
function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) {
      d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Synthetic cédula: 3-digit office + 7-digit serial (= parent index) + check digit. */
export function cedulaFor(parentIndex: number, office: number): string {
  const body = `${String(office).padStart(3, "0")}${String(parentIndex).padStart(7, "0")}`;
  return `${body}${luhnDigit(body)}`;
}

/** Iterate every family in order. Pure and restartable. */
export function* generateFamilies(childTotal: number): Generator<Family> {
  const rng = mulberry32(FAMILY_SEED);
  let nextChild = 1;
  let nextParent = 1;
  let familyIndex = 0;
  while (nextChild <= childTotal) {
    familyIndex += 1;
    const r = rng();
    const size = Math.min(r < 0.5 ? 1 : r < 0.77 ? 2 : 3, childTotal - nextChild + 1);
    const familyName = pick(rng, FAMILY);
    const office = 1 + Math.floor(rng() * 32);
    const layout = rng();
    const roles: Array<"legal_guardian" | "parent"> =
      layout < 0.03 ? ["legal_guardian"] : layout < 0.03 + 0.147 ? ["parent", "parent"] : ["parent"];
    const parents: Parent[] = roles.map((_, i) => {
      const index = nextParent++;
      return {
        cedula: cedulaFor(index, office),
        family_name: i === 0 ? familyName : pick(rng, FAMILY),
        given_name: i === 0 ? pick(rng, GIVEN_F) : pick(rng, GIVEN_M),
        index,
      };
    });
    const children: Child[] = [];
    for (let k = 0; k < size; k++) {
      const index = nextChild++;
      const record = generateChild(index);
      children.push({
        birth_date: record.birth_date,
        child_id: record.child_id,
        family_name: familyName,
        given_name: pick(rng, GIVEN_CHILD),
        index,
      });
    }
    const guardianships: Guardianship[] = [];
    for (const child of children) {
      parents.forEach((parent, i) => {
        guardianships.push({
          capacity: roles[i] as Guardianship["capacity"],
          child_id: child.child_id,
          parent_cedula: parent.cedula,
        });
      });
    }
    yield { children, guardianships, index: familyIndex, parents };
  }
}

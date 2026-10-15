// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Civil-registry stub tables. Dependency-free so the seed script can import it.

export const REGISTRY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pilot_rc_parents (
    cedula      TEXT PRIMARY KEY,
    given_name  TEXT NOT NULL,
    family_name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pilot_rc_children (
    child_id    TEXT PRIMARY KEY,
    given_name  TEXT NOT NULL,
    family_name TEXT NOT NULL,
    birth_date  DATE NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pilot_rc_guardianships (
    parent_cedula TEXT NOT NULL,
    child_id      TEXT NOT NULL,
    capacity      TEXT NOT NULL CHECK (capacity IN ('parent', 'legal_guardian')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    PRIMARY KEY (parent_cedula, child_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pilot_rc_guardianships_child ON pilot_rc_guardianships (child_id);
  CREATE TABLE IF NOT EXISTS pilot_rc_refusal_set (
    seq             INTEGER PRIMARY KEY,
    parent_cedula   TEXT NOT NULL,
    child_id        TEXT NOT NULL,
    expected_reason TEXT NOT NULL
  );
`;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic "national immunization registry" source for the DR pilot load
// test. One record per child; the record key is child_id so a grant can name
// exactly one record through `resources`.

export const CONNECTOR_KEY = "dr-vacuna-registry";
// The registered connector_id must equal connector_key; grants name the
// source by its registry URL.
export const CONNECTOR_ID = CONNECTOR_KEY;
export const SOURCE_ID = `https://registry.pdpp.dev/connectors/${CONNECTOR_KEY}`;
export const STREAM = "child_immunizations";

export const VACUNA_MANIFEST = {
  capabilities: { human_interaction: [], public_listing: { tier: "development" } },
  connector_id: CONNECTOR_ID,
  connector_key: CONNECTOR_KEY,
  display_name: "Registro Nacional de Vacunación (synthetic)",
  manifest_uri: SOURCE_ID,
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: false } } },
  version: "1.0.0",
  streams: [
    {
      consent_time_field: "updated_at",
      coverage_strategy: "full_inventory",
      cursor_field: "updated_at",
      description: "Childhood immunization record, one per child",
      freshness_strategy: "manual_as_of",
      incremental: true,
      name: STREAM,
      primary_key: ["child_id"],
      schema: {
        properties: {
          birth_date: { format: "date", type: "string" },
          child_id: { type: "string" },
          doses: {
            items: {
              properties: {
                centre_code: { type: "string" },
                date: { format: "date", type: "string" },
                dose_number: { type: "integer" },
                vaccine: { type: "string" },
              },
              required: ["vaccine", "dose_number", "date", "centre_code"],
              type: "object",
            },
            type: "array",
          },
          next_dose_due: {
            properties: {
              due_date: { format: "date", type: "string" },
              dose_number: { type: "integer" },
              vaccine: { type: "string" },
            },
            type: ["object", "null"],
          },
          updated_at: { format: "date-time", type: "string" },
        },
        required: ["child_id", "birth_date", "doses"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
      views: [
        {
          fields: ["child_id", "birth_date", "doses", "next_dose_due", "updated_at"],
          id: "reminders",
          label: "Immunization history and next dose",
        },
      ],
    },
  ],
};

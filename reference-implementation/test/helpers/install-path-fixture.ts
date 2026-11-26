// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fixture connector and release profile for the install-path journey.
 *
 * One connector protocol serves two consumers: the local-device journeys run it
 * as a source file, and the install-path journey packages it as an OCI artifact
 * with `test/helpers/build-install-path-releases.ts`. Both must behave the same, so
 * the protocol body lives here once.
 */

export const INSTALL_PATH_CONNECTOR_KEY = "claude-code";
const INSTALL_PATH_CONNECTOR_ID = `https://registry.pdpp.dev/connectors/${INSTALL_PATH_CONNECTOR_KEY}`;
/** The local collector's id for this connector. A collection-profile pin is keyed by this. */
export const INSTALL_PATH_COLLECTOR_ID = "claude_code";
export const INSTALL_PATH_REPOSITORY = `pdp-connect/connector/${INSTALL_PATH_CONNECTOR_KEY}`;
export const INSTALL_PATH_VERSION = "0.1.0";

/**
 * The collection profile both releases carry. The two releases differ only in
 * their code layer, so this manifest is byte-identical across them: a
 * republished version with new bytes is the case the artifact digest, not the
 * version, has to catch.
 */
export const INSTALL_PATH_PROFILE = {
  connector_id: INSTALL_PATH_CONNECTOR_ID,
  connector_key: INSTALL_PATH_CONNECTOR_KEY,
  display_name: "Claude Code (install-path journey fixture)",
  protocol_capabilities: ["RUN_COVERAGE_V1"],
  protocol_version: "0.2.0",
  streams: [
    { coverage_stores: ["projects"], name: "sessions", primary_key: ["id"] },
    { coverage_stores: ["derived_messages"], name: "messages", primary_key: ["id"] },
  ],
  version: INSTALL_PATH_VERSION,
};

/**
 * The connector's source. `build` names the release it was built as, and the
 * connector reports it in the observation file, so a test can tell which bytes
 * ran. The body has no template interpolation, so it sits here as a plain
 * string.
 */
export function fixtureConnectorSource(build: string): string {
  return `const BUILD = ${JSON.stringify(build)};\n${CONNECTOR_BODY}`;
}

const CONNECTOR_BODY = `import { writeFileSync } from "node:fs";

const [mode, observePath, tag] = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const start = JSON.parse(input.split("\\n")[0]);
  writeFileSync(observePath, JSON.stringify({ ...start, build: BUILD }));
  const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  const emittedAt = "2026-10-22T12:00:00.000Z";
  const record = (stream, id) => emit({ data: { id }, emitted_at: emittedAt, key: id, stream, type: "RECORD" });
  const coverage = {
    collection_scope: start.collection_scope,
    streams: [
      { scoped: true, stores: [{ status: "collected", store: "projects" }], stream: "sessions" },
      { scoped: true, stores: [{ status: "collected", store: "derived_messages" }], stream: "messages" },
    ],
    version: 1,
  };
  if (mode === "empty") {
    emit({ records_emitted: 0, status: "succeeded", type: "DONE" });
    return;
  }
  if (mode === "crash") {
    // The child dies mid-scan, before STATE or DONE.
    record("sessions", "s-crash");
    process.exit(3);
  }
  if (mode === "state") {
    // A successful run that commits STATE and makes no coverage claim.
    record("sessions", "s-1");
    emit({ cursor: { cursor: tag + "-sessions" }, stream: "sessions", type: "STATE" });
    emit({ records_emitted: 1, status: "succeeded", type: "DONE" });
    return;
  }
  if (mode === "reject") {
    // A stream the connector manifest does not declare: the server refuses the batch.
    record("sessions", "s-1");
    record("undeclared_stream", "u-1");
    emit({ cursor: { cursor: tag + "-sessions" }, stream: "sessions", type: "STATE" });
    emit({ coverage, records_emitted: 2, status: "succeeded", type: "DONE" });
    return;
  }
  record("sessions", "s-1");
  record("sessions", "s-2");
  record("messages", "m-1");
  emit({ cursor: { cursor: tag + "-sessions" }, stream: "sessions", type: "STATE" });
  emit({ cursor: { cursor: tag + "-messages" }, stream: "messages", type: "STATE" });
  if (mode === "skip") {
    emit({ message: "one message could not be read", reason: "source_unreadable", stream: "messages", type: "SKIP_RESULT" });
  }
  emit({ coverage, records_emitted: 3, status: "succeeded", type: "DONE" });
});
`;

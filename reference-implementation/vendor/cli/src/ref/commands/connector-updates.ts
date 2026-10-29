// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { parseArgs, requirePositional } from "../args.ts";
import { buildAuthHeaders } from "../auth.ts";
import { PdppUsageError } from "../errors.ts";
import { fetchJson, resolveReferenceUrl } from "../fetch.ts";
import { resolveFormat, writeData, writeEnvelopeWarnings } from "../output.ts";
import type { CommandIo } from "./call.ts";

function connectorIds(flags: Record<string, string | boolean>): string[] | undefined {
  const raw = flags["connector-id"];
  if (raw === undefined) {
    return undefined;
  }
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => String(value).split(","));
  const ids = values.map((value) => value.trim()).filter(Boolean);
  if (!ids.length) {
    throw new PdppUsageError("Provide at least one connector id with --connector-id.");
  }
  return [...new Set(ids)];
}

export async function runRefConnectorUpdates(
  argv: string[],
  io: CommandIo = {},
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<number> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const out = io.stdout || process.stdout;
  let path: string;
  let method = "GET";
  let body: string | undefined;

  if (subcommand === "plan") {
    path = "/v1/owner/connector-updates/plans";
    method = "POST";
  } else if (subcommand === "review") {
    const planId = requirePositional(positionals, 0, "plan-id");
    const ids = connectorIds(flags);
    const targetDigest = flags["target-digest"];
    if (ids?.length !== 1 || typeof targetDigest !== "string" || !targetDigest.trim()) {
      throw new PdppUsageError("Review requires one --connector-id and --target-digest from the plan.");
    }
    path = `/v1/owner/connector-updates/plans/${encodeURIComponent(planId)}/consents`;
    method = "POST";
    body = JSON.stringify({ connector_id: ids[0], target_digest: targetDigest });
  } else if (subcommand === "apply") {
    const planId = requirePositional(positionals, 0, "plan-id");
    const idempotencyKey =
      typeof flags["idempotency-key"] === "string" ? String(flags["idempotency-key"]).trim() : randomUUID();
    if (!idempotencyKey) {
      throw new PdppUsageError("Provide a non-empty --idempotency-key value.");
    }
    const payload: Record<string, unknown> = { idempotency_key: idempotencyKey, plan_id: planId };
    const ids = connectorIds(flags);
    if (ids) {
      payload.selected_connector_ids = ids;
    }
    if (flags["consent-token"] !== undefined) {
      if (typeof flags["consent-token"] !== "string" || !flags["consent-token"].trim() || ids?.length !== 1) {
        throw new PdppUsageError("--consent-token requires exactly one --connector-id.");
      }
      payload.consent_token = flags["consent-token"];
    }
    path = "/v1/owner/connector-updates/batches";
    method = "POST";
    body = JSON.stringify(payload);
    if (flags["idempotency-key"] === undefined) {
      (io.stderr || process.stderr).write(`Idempotency key: ${idempotencyKey}\n`);
    }
  } else if (subcommand === "status") {
    const planId = flags["plan-id"];
    const batchId = flags["batch-id"];
    if ((typeof planId === "string") === (typeof batchId === "string")) {
      throw new PdppUsageError("Choose exactly one of --plan-id <id> or --batch-id <id>.");
    }
    path =
      typeof planId === "string"
        ? `/v1/owner/connector-updates/plans/${encodeURIComponent(planId)}`
        : `/v1/owner/connector-updates/batches/${encodeURIComponent(String(batchId))}`;
  } else {
    throw new PdppUsageError(
      "Usage: pdpp ref connectors updates <plan|review <plan-id>|apply <plan-id>|status --plan-id <id>|--batch-id <id>>"
    );
  }

  const asUrl = resolveReferenceUrl(flags);
  const headers = await buildAuthHeaders({ flags, io, mode: "bearer", referenceUrl: asUrl });
  const format = resolveFormat(flags, "json", "json");
  const requestHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  const init: RequestInit = { headers: requestHeaders, method, redirect: "manual" };
  if (body !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    init.body = body;
  }
  const { body: response } = await fetchJson(`${asUrl}${path}`, init, fetchImpl);
  writeData(response, format, out);
  writeEnvelopeWarnings(response, io.stderr || process.stderr);
  return 0;
}

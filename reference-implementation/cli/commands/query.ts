// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from "../lib/args.ts";
import { appendQuery, resolveClientToken, resolveRsUrl } from "../lib/common.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { attachReferenceQueryMetadata, bearer, bodyDataArray, fetchJson } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

export async function runQuery(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const instanceId = resolveInstanceId(flags, rest);
  const rsUrl = resolveRsUrl(flags);
  const token = resolveClientToken(flags);
  if (!token) {
    throw new PdppUsageError("Missing client token. Use --token or PDPP_CLIENT_TOKEN.");
  }

  if (subcommand === "streams") {
    const url = appendQuery(`${rsUrl}/v1/streams`, { instance_id: instanceId });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    const format = resolveFormat(flags, "table", "json");
    writeData(format === "json" ? attachReferenceQueryMetadata(body, headers) : bodyDataArray(body), format);
    return;
  }

  if (subcommand === "records") {
    const stream = requirePositional(positionals, 0, "stream");
    const url = appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records`, {
      changes_since: flags["changes-since"],
      cursor: flags.cursor,
      fields: flags.fields,
      limit: flags.limit,
      view: flags.view,
      instance_id: instanceId,
    });
    const { body, headers } = await fetchJson(url, { headers: bearer(token) });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
    return;
  }

  if (subcommand === "get") {
    const stream = requirePositional(positionals, 0, "stream");
    const recordId = requirePositional(positionals, 1, "record-id");
    const { body, headers } = await fetchJson(
      appendQuery(`${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}`, {
        instance_id: instanceId,
      }),
      { headers: bearer(token) }
    );
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
    return;
  }

  throw new PdppUsageError("Usage: pdpp query <streams|records|get> ... [--rs-url <url>] [--token <token>]");
}

function resolveInstanceId(flags: Record<string, string | true>, argv: string[]): string | undefined {
  const values: unknown[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      break;
    }
    if (arg === undefined || !arg.startsWith("--instance-id")) {
      continue;
    }
    if (arg.startsWith("--instance-id=")) {
      values.push(arg.slice("--instance-id=".length));
    } else if (arg === "--instance-id") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.push(next);
        index += 1;
      } else {
        values.push(true);
      }
    }
  }
  if (!values.length && Object.hasOwn(flags, "instance-id")) {
    values.push(flags["instance-id"]);
  }
  const ids = values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new PdppUsageError("--instance-id requires a non-empty string handle.");
    }
    return value;
  });
  if (ids.some((value) => value !== ids[0])) {
    throw new PdppUsageError("Use only one value for --instance-id.");
  }
  return ids[0];
}

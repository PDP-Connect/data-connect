// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppUsageError } from "./errors.ts";

export type ParsedFlags = Record<string, string | boolean>;

export interface ParsedArgs {
  flags: ParsedFlags;
  positionals: string[];
}

export interface ParseArgsOptions {
  // Flags that never take a value: a bare occurrence is `true`, and only a
  // literal `true`/`false` after it is consumed, so a following positional is
  // never swallowed.
  booleanFlags?: readonly string[];
}

export function parseArgs(argv: string[], options: ParseArgsOptions = {}): ParsedArgs {
  const flags: ParsedFlags = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const separator = arg.indexOf("=", 2);
    const rawKey = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const inlineValue = separator === -1 ? undefined : arg.slice(separator + 1);
    if (!rawKey) {
      throw new PdppUsageError("Invalid empty flag");
    }

    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (options.booleanFlags?.includes(rawKey)) {
      const explicit = next === "true" || next === "false";
      flags[rawKey] = explicit ? next : true;
      i += explicit ? 1 : 0;
      continue;
    }
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      i += 1;
      continue;
    }

    flags[rawKey] = true;
  }

  return { flags, positionals };
}

export function requirePositional(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) {
    throw new PdppUsageError(`Missing required argument: ${name}`);
  }
  return value;
}

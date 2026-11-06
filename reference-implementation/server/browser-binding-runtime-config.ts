// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type BindingControlTarget, validateControlTarget } from "../runtime/binding-control.ts";
import { findDuplicateJsonKeys } from "../runtime/connector-binding-grammar.mjs";

const MAX_CONFIG_BYTES = 16_384;
const MAX_CREDENTIAL_FILE_BYTES = 1_026;
const FILE_LINE_ENDING = /\r?\n$/u;
export class BrowserBindingRuntimeConfigurationError extends Error {
  constructor() {
    super("Browser binding runtime configuration is invalid");
    this.name = "BrowserBindingRuntimeConfigurationError";
  }
}
export interface BrowserBindingRuntimeConfig {
  readonly version: 1;
  readonly policyIdentity: string;
  readonly approvalMaxAgeMs: number;
  readonly allocator: BindingControlTarget;
  readonly authorizer: BindingControlTarget;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrowserBindingRuntimeConfigurationError();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new BrowserBindingRuntimeConfigurationError();
  }
}
async function readBoundedFile(path: unknown, maxBytes: number): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new BrowserBindingRuntimeConfigurationError();
  }
  // Read-only nonblocking open prevents a configured FIFO from hanging startup.
  // The descriptor keeps the size check and the read on the same file.
  const file = await open(path, constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      throw new BrowserBindingRuntimeConfigurationError();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = file.createReadStream({ autoClose: false, end: maxBytes, highWaterMark: maxBytes + 1, start: 0 });
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        throw new BrowserBindingRuntimeConfigurationError();
      }
      chunks.push(bytes);
    }
    if (size < 1) {
      throw new BrowserBindingRuntimeConfigurationError();
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    await file.close();
  }
}
async function target(value: unknown): Promise<BindingControlTarget> {
  const item = object(value);
  exactKeys(item, ["url", "credentialFile", "timeoutMs"]);
  if (
    typeof item.url !== "string" ||
    typeof item.credentialFile !== "string" ||
    !isAbsolute(item.credentialFile) ||
    !Number.isSafeInteger(item.timeoutMs) ||
    Number(item.timeoutMs) < 1 ||
    Number(item.timeoutMs) > 30_000
  ) {
    throw new BrowserBindingRuntimeConfigurationError();
  }
  const text = await readBoundedFile(item.credentialFile, MAX_CREDENTIAL_FILE_BYTES);
  const credential = text.replace(FILE_LINE_ENDING, "");
  const result = { credential, timeoutMs: Number(item.timeoutMs), url: item.url };
  try {
    validateControlTarget(result);
  } catch {
    throw new BrowserBindingRuntimeConfigurationError();
  }
  return Object.freeze(result);
}
export async function readBrowserBindingRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<BrowserBindingRuntimeConfig | null> {
  const configured = env.PDPP_BROWSER_BINDING_CONFIG_FILE;
  if (configured === undefined) return null;
  try {
    const text = await readBoundedFile(configured, MAX_CONFIG_BYTES);
    if (findDuplicateJsonKeys(text).length > 0) throw new BrowserBindingRuntimeConfigurationError();
    const parsed = object(JSON.parse(text));
    exactKeys(parsed, ["version", "policyIdentity", "approvalMaxAgeMs", "allocator", "authorizer"]);
    const now = Date.now();
    if (
      parsed.version !== 1 ||
      typeof parsed.policyIdentity !== "string" ||
      !parsed.policyIdentity.trim() ||
      parsed.policyIdentity !== parsed.policyIdentity.trim() ||
      !Number.isSafeInteger(parsed.approvalMaxAgeMs) ||
      Number(parsed.approvalMaxAgeMs) <= 0 ||
      !Number.isSafeInteger(now + Number(parsed.approvalMaxAgeMs)) ||
      !Number.isFinite(new Date(now + Number(parsed.approvalMaxAgeMs)).getTime())
    ) {
      throw new BrowserBindingRuntimeConfigurationError();
    }
    const allocator = await target(parsed.allocator);
    const authorizer = await target(parsed.authorizer);
    if (allocator.credential === authorizer.credential) throw new BrowserBindingRuntimeConfigurationError();
    return Object.freeze({
      version: 1,
      policyIdentity: parsed.policyIdentity,
      approvalMaxAgeMs: Number(parsed.approvalMaxAgeMs),
      allocator,
      authorizer,
    });
  } catch {
    throw new BrowserBindingRuntimeConfigurationError();
  }
}

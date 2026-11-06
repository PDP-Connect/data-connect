// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const BINDING_JSON_MAX_BYTES = 1024 * 1024;
export class BindingJsonError extends Error {
  readonly code: "record_invalid" | "record_oversize";
  constructor(code: "record_invalid" | "record_oversize") {
    super(code);
    this.code = code;
  }
}
function invalid(): never {
  throw new BindingJsonError("record_invalid");
}

/** Accept data properties only; accessors must never execute while making the snapshot. */
function dataEntries(value: object): [string, unknown][] {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalid();
  }
  return Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (!(descriptor.enumerable && Object.hasOwn(descriptor, "value"))) {
      invalid();
    }
    return [key, descriptor.value];
  });
}

function jsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Strict bounded JSON, sorted object keys; no JSONB order dependency or silent data loss. */
export function canonicalBindingJson(value: unknown): string {
  let nodes = 0;
  let totalValueBytes = 0;
  const ancestors = new Set<object>();
  function bounded(result: string, countValue = false): string {
    const size = Buffer.byteLength(result);
    if (countValue) {
      totalValueBytes += size;
    }
    if (size > BINDING_JSON_MAX_BYTES || totalValueBytes > BINDING_JSON_MAX_BYTES) {
      throw new BindingJsonError("record_oversize");
    }
    return result;
  }
  function collection(entry: object, depth: number): string {
    if (Array.isArray(entry)) {
      // Arrays have one non-enumerable length property. Reject holes, extra keys and accessors.
      const { length: _length, ...descriptors } = Object.getOwnPropertyDescriptors(entry);
      if (Object.keys(descriptors).length !== entry.length) {
        invalid();
      }
      const items = Array.from({ length: entry.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!(descriptor?.enumerable && Object.hasOwn(descriptor, "value"))) {
          invalid();
        }
        return visit(descriptor.value, depth + 1);
      });
      return `[${items.join(",")}]`;
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) {
      invalid();
    }
    return `{${dataEntries(entry)
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([key, item]) => `${bounded(JSON.stringify(key), true)}:${visit(item, depth + 1)}`)
      .join(",")}}`;
  }
  function visit(entry: unknown, depth: number): string {
    nodes += 1;
    if (depth > 64 || nodes > 100_000) {
      invalid();
    }
    if (jsonPrimitive(entry)) {
      return bounded(JSON.stringify(entry), true);
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      ancestors.has(entry) ||
      Object.getOwnPropertySymbols(entry).length > 0
    ) {
      invalid();
    }
    ancestors.add(entry);
    const result = collection(entry, depth);
    ancestors.delete(entry);
    return bounded(result);
  }
  return visit(value, 0);
}

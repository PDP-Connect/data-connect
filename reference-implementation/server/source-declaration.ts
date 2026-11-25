// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import {
  type SourceDeclaration,
  SourceDeclarationSchema,
  validateSourceDeclarationSemantics,
} from "@pdpp/reference-contract/public/source";

interface SchemaError {
  instancePath?: string;
  message?: string;
}

interface SchemaValidator {
  errors?: SchemaError[] | null;
  (value: unknown): boolean;
}

interface AjvInstance {
  compile: (schema: object) => SchemaValidator;
  errors?: SchemaError[] | null;
  validateSchema: (schema: object) => boolean;
}

type JsonObject = Record<string, unknown>;

const requireFromContract = createRequire(import.meta.resolve("@pdpp/reference-contract"));
const Ajv2020 = requireFromContract("ajv/dist/2020.js") as new (options?: JsonObject) => AjvInstance;
const addFormats = requireFromContract("ajv-formats") as (ajv: AjvInstance) => void;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSourceDeclarationSchema = ajv.compile(SourceDeclarationSchema);

export class InvalidSourceDeclarationError extends Error {
  readonly code = "source.declaration_invalid";
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function validationMessage(): string {
  const structural = (validateSourceDeclarationSchema.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`
  );
  return structural.join("; ");
}

function assertJsonPointerTarget(reference: string, resource: unknown, path: string): void {
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    throw new InvalidSourceDeclarationError(`${path} must be a valid local fragment reference`);
  }
  // Empty fragments and named anchors keep their existing behaviour.
  if (!fragment.startsWith("/")) {
    return;
  }
  let target = resource;
  for (const token of fragment.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      /~(?![01])/u.test(token) ||
      !target || typeof target !== "object" ||
      (Array.isArray(target) && !/^(0|[1-9][0-9]*)$/u.test(key)) ||
      !Object.hasOwn(target, key)
    ) {
      throw new InvalidSourceDeclarationError(`${path} must point to an existing local schema`);
    }
    target = (target as JsonObject)[key];
  }
  if (typeof target !== "boolean" && (!target || typeof target !== "object" || Array.isArray(target))) {
    throw new InvalidSourceDeclarationError(`${path} must point to an existing local schema`);
  }
}

// JSON Schema 2020-12 applicators (plus the draft-07 spellings Ajv still
// accepts), by the shape of their value. Every other keyword holds data or an
// annotation (`examples`, `default`, `const`, `enum`, ...), so a "$ref" inside
// it is a literal value, not a reference.
const SCHEMA_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = new Set(["$defs", "definitions", "dependencies", "dependentSchemas", "patternProperties", "properties"]);

/** Check the local JSON Pointer references of an embedded schema without resolving remote schemas. */
export function assertLocalSchemaReferences(schema: unknown, path: string): void {
  function visitSchema(value: unknown, at: string, resource: unknown): void {
    if (!(value && typeof value === "object" && !Array.isArray(value))) {
      return;
    }
    const object = value as JsonObject;
    const currentResource = typeof object.$id === "string" ? object : resource;
    for (const [key, child] of Object.entries(object)) {
      const childPath = `${at}/${key}`;
      if (key === "$ref" || key === "$dynamicRef") {
        if (typeof child !== "string" || !child.startsWith("#")) {
          throw new InvalidSourceDeclarationError(`${childPath} must be a local fragment reference`);
        }
        assertJsonPointerTarget(child, currentResource, childPath);
      } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(child)) {
        for (const [index, member] of child.entries()) {
          visitSchema(member, `${childPath}/${index}`, currentResource);
        }
      } else if (SCHEMA_KEYWORDS.has(key)) {
        visitSchema(child, childPath, currentResource);
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
        for (const [name, member] of Object.entries(child as JsonObject)) {
          visitSchema(member, `${childPath}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`, currentResource);
        }
      }
    }
  }
  visitSchema(schema, path, schema);
}

function requireEmbeddedStreamSchemas(declaration: SourceDeclaration): void {
  for (const [index, stream] of declaration.streams.entries()) {
    if (!ajv.validateSchema(stream.schema)) {
      const details = (ajv.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message || "is invalid"}`)
        .join("; ");
      throw new InvalidSourceDeclarationError(
        `Invalid SourceDeclaration stream schema at /streams/${index}/schema: ${details}`
      );
    }
    assertLocalSchemaReferences(stream.schema, `/streams/${index}/schema`);
  }
}

/** Parse an untrusted value through the common connector/native Core boundary. */
export function requireSourceDeclaration(value: unknown): SourceDeclaration {
  const candidate = cloneJson(value);
  if (!validateSourceDeclarationSchema(candidate)) {
    throw new InvalidSourceDeclarationError(`Invalid SourceDeclaration: ${validationMessage()}`);
  }
  const declaration = candidate as SourceDeclaration;
  requireEmbeddedStreamSchemas(declaration);
  const semantic = validateSourceDeclarationSemantics(declaration);
  if (!semantic.ok) {
    const details = semantic.failures.map((failure) => `${failure.path}: ${failure.code}`).join("; ");
    throw new InvalidSourceDeclarationError(`Invalid SourceDeclaration semantics: ${details}`);
  }
  return declaration;
}

/** Validate and retain one detached immutable SourceDeclaration value. */
export function snapshotSourceDeclaration(value: unknown): SourceDeclaration {
  return deepFreezeJson(requireSourceDeclaration(value));
}

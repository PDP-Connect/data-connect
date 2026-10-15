// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  captureExistingClientContract,
  capturePackageResourceSession,
  readContract,
} from "./helpers/mcp-existing-client-session.ts"

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/mcp-existing-client-contract.json"
)

type JsonObject = Record<string, unknown>
type ToolContract = { properties: Record<string, string>; required: string[] }

function object(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {}
}

function fail(message: string): never {
  assert.fail(message)
}

function compareType(
  baseType: string,
  candidateType: string,
  context: string
): void {
  const baseTypes = new Set(baseType.split("|").sort())
  const candidateTypes = new Set(candidateType.split("|").sort())
  for (const type of baseTypes) {
    assert(
      candidateTypes.has(type),
      `${context}: input type narrowed from ${baseType} to ${candidateType}`
    )
  }
}

function assertOutputCompatibility(
  base: unknown,
  candidate: unknown,
  context: string
): void {
  const baseObject = object(base)
  const candidateObject = object(candidate)
  const compareShape = (
    baseShape: unknown,
    candidateShape: unknown,
    path: string
  ): void => {
    const expected = object(baseShape)
    const actual = object(candidateShape)
    if (expected.type === "object") {
      assert.equal(actual.type, "object", `${context}: ${path} changed type`)
      const expectedProps = object(expected.properties)
      const actualProps = object(actual.properties)
      for (const [key, shape] of Object.entries(expectedProps)) {
        assert(
          Object.hasOwn(actualProps, key),
          `${context}: output key '${path}.${key}' disappeared`
        )
        compareShape(shape, actualProps[key], `${path}.${key}`)
      }
      return
    }
    if (expected.type === "array") {
      assert.equal(actual.type, "array", `${context}: ${path} changed type`)
      const actualElements = Array.isArray(actual.elements)
        ? actual.elements
        : []
      for (const baseElement of Array.isArray(expected.elements)
        ? expected.elements
        : []) {
        assert(
          actualElements.some(candidateElement =>
            shapeCompatible(baseElement, candidateElement)
          ),
          `${context}: ${path} array element shape disappeared`
        )
      }
      return
    }
    assert.equal(
      candidateShape,
      baseShape,
      `${context}: output key '${path}' changed type`
    )
  }
  const shapeCompatible = (
    baseShape: unknown,
    candidateShape: unknown
  ): boolean => {
    try {
      compareShape(baseShape, candidateShape, "array element")
      return true
    } catch {
      return false
    }
  }
  compareShape(baseObject.resultShape, candidateObject.resultShape, "result")
  compareShape(
    baseObject.structuredShape,
    candidateObject.structuredShape,
    "structuredContent"
  )
  assert.equal(
    candidateObject.contentTextMode,
    baseObject.contentTextMode,
    `${context}: model-visible content text behavior changed`
  )
  const baseContent = baseObject.content
  const candidateContent = candidateObject.content
  if (Array.isArray(baseContent)) {
    assert(
      Array.isArray(candidateContent),
      `${context}: output key 'content' changed type`
    )
    const candidateParts = candidateContent.map(part =>
      stableJson(object(part).types)
    )
    for (const part of baseContent) {
      assert(
        candidateParts.includes(stableJson(object(part).types)),
        `${context}: content segment shape changed`
      )
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

function compareClient(base: JsonObject, candidate: JsonObject): void {
  const baseSession = object(base.session)
  const candidateSession = object(candidate.session)
  const baseTools = baseSession.toolNames as string[]
  const candidateTools = candidateSession.toolNames as string[]
  for (const toolName of baseTools) {
    assert(
      candidateTools.includes(toolName),
      `client token: tool '${toolName}' was removed or renamed`
    )
  }

  const baseSchemas = object(base.toolSchemas) as Record<string, ToolContract>
  const candidateSchemas = object(candidate.toolSchemas) as Record<
    string,
    ToolContract
  >
  compareToolInputs(baseSchemas, candidateSchemas, "client token", false)
  const baseOutputs = object(base.outputs)
  const candidateOutputs = object(candidate.outputs)
  for (const [toolName, baseOutput] of Object.entries(baseOutputs)) {
    assertOutputCompatibility(
      baseOutput,
      candidateOutputs[toolName],
      `client token '${toolName}'`
    )
  }
  compareDiscovery(baseSession, candidateSession, "client token")
  compareLegacyAliases(baseSession, candidateSession, "client token")
  assert.equal(
    stableJson(candidateSession.resourceDiscovery),
    stableJson(baseSession.resourceDiscovery),
    "client token: resources/list and resources/templates/list changed from base"
  )
}

function compareToolInputs(
  baseSchemas: Record<string, ToolContract>,
  candidateSchemas: Record<string, ToolContract>,
  context: string,
  allowGrantId: boolean
): void {
  for (const [toolName, baseSchema] of Object.entries(baseSchemas)) {
    const candidateSchema = candidateSchemas[toolName]
    assert(
      candidateSchema,
      `${context}: tool '${toolName}' was removed or renamed`
    )
    for (const required of baseSchema.required) {
      assert(
        candidateSchema.required.includes(required),
        `${context}: tool '${toolName}' no longer requires base-required input '${required}'`
      )
    }
    for (const required of candidateSchema.required) {
      assert(
        baseSchema.required.includes(required) ||
          (allowGrantId && required === "grant_id"),
        `${context}: tool '${toolName}' added required input '${required}'`
      )
    }
    for (const [property, baseType] of Object.entries(baseSchema.properties)) {
      const candidateType: string | undefined =
        candidateSchema.properties[property]
      assert(
        candidateType,
        `${context}: tool '${toolName}' removed input property '${property}'`
      )
      compareType(
        baseType,
        candidateType,
        `${context}: tool '${toolName}' property '${property}'`
      )
    }
  }
}

function comparePackage(base: JsonObject, candidate: JsonObject): void {
  const baseSession = object(base.session)
  const candidateSession = object(candidate.session)
  const candidateNames = candidateSession.toolNames as string[]
  const candidateSchemas = object(candidate.toolSchemas) as Record<
    string,
    ToolContract
  >
  const dataTools = Object.keys(candidateSchemas).filter(
    name => name !== "list_package_children"
  )
  const requiresGrantId = dataTools.some(name =>
    candidateSchemas[name]?.required.includes("grant_id")
  )

  if (!requiresGrantId) {
    compareClient(base, candidate)
    assert.equal(
      stableJson(candidateSession.resourceDiscovery),
      stableJson(baseSession.resourceDiscovery),
      "package token: base resource discovery changed"
    )
    return
  }
  if (!candidateNames.includes("list_package_children")) {
    fail("package tokens require grant_id but no discovery tool is offered")
  }
  for (const name of dataTools) {
    assert(
      candidateSchemas[name]?.required.includes("grant_id"),
      `package token: tool '${name}' must declare required input 'grant_id'`
    )
  }
  const baseSchemas = object(base.toolSchemas) as Record<string, ToolContract>
  compareToolInputs(baseSchemas, candidateSchemas, "package token", true)
  const discovered = candidate.discoveryGrantIds as string[]
  assert(
    discovered.length >= 2,
    "package token: list_package_children did not provide two valid child grant ids"
  )
  for (const key of ["fetchId", "searchedFetchId"]) {
    assert.equal(
      typeof candidateSession[key],
      "string",
      `package token: ${key} is not a usable fetch handle`
    )
  }
  const baseOutputs = object(base.outputs)
  const candidateOutputs = object(candidate.outputs)
  for (const [toolName, baseOutput] of Object.entries(baseOutputs)) {
    if (toolName === "list_package_children") continue
    assertOutputCompatibility(
      baseOutput,
      candidateOutputs[toolName],
      `package token '${toolName}'`
    )
  }
  compareDiscovery(baseSession, candidateSession, "package token")
  compareLegacyAliases(baseSession, candidateSession, "package token")
  comparePackageResources(baseSession, candidateSession, "package token")
}

function comparePackageResources(
  baseSession: JsonObject,
  candidateSession: JsonObject,
  context: string
): void {
  const discovery = object(candidateSession.resourceDiscovery)
  const templates = Array.isArray(discovery.resourceTemplates)
    ? (discovery.resourceTemplates as JsonObject[])
    : []
  for (const name of ["pdpp-record", "pdpp-field-window"]) {
    const template = templates.find(item => item.name === name)
    assert(template, `${context}: resources/templates/list removed '${name}'`)
    assert(
      typeof template.uriTemplate === "string" &&
        template.uriTemplate.includes("{grant_id}/{handle}"),
      `${context}: '${name}' does not advertise the grant_id resource URI form`
    )
  }
  assert(
    templates.every(
      template =>
        typeof template.uriTemplate === "string" &&
        template.uriTemplate.includes("{grant_id}/")
    ),
    `${context}: package resource discovery advertises a legacy or unscoped URI form`
  )
  const resources = Array.isArray(discovery.resources)
    ? (discovery.resources as JsonObject[])
    : []
  const grantIds = Array.isArray(candidateSession.discoveryGrantIds)
    ? (candidateSession.discoveryGrantIds as string[])
    : []
  assert(
    resources.every(resource => {
      const uri = resource.uri
      return (
        typeof uri === "string" &&
        grantIds.some(id => uri.includes(`/${encodeURIComponent(id)}/`))
      )
    }),
    `${context}: resources/list advertises a package URI without explicit child selection`
  )

  const storedIds = object(baseSession.storedIds)
  const oldUris = [
    ...new Set([
      ...((storedIds.recordUris as string[] | undefined) ?? []),
      ...((storedIds.fieldWindowUris as string[] | undefined) ?? []),
    ]),
  ]
  assert(
    oldUris.length > 0,
    `${context}: base captured no stored resource URIs`
  )
  const reads = Array.isArray(candidateSession.resourceReads)
    ? (candidateSession.resourceReads as JsonObject[])
    : []
  const readsByUri = new Map(reads.map(read => [String(read.uri), read]))
  for (const uri of oldUris) {
    const read = readsByUri.get(uri)
    assert(read, `${context}: old stored resource URI was not replayed: ${uri}`)
    if (read.ambiguous === true) {
      assert.equal(
        read.errorCode,
        "ambiguous_legacy_resource_uri",
        `${context}: old URI refusal was not reported as genuine ambiguity`
      )
      continue
    }
    const contents = Array.isArray(read.contents)
      ? (read.contents as JsonObject[])
      : []
    assert(
      contents.some(
        part => typeof part.text === "string" && part.text.trim().length > 0
      ),
      `${context}: old stored resource URI returned no content: ${uri}`
    )
  }
  const oldUriSet = new Set(oldUris)
  const newReads = reads.filter(read => !oldUriSet.has(String(read.uri)))
  assert(
    newReads.some(read => String(read.uri).startsWith("pdpp://record/")) &&
      newReads.some(read =>
        String(read.uri).startsWith("pdpp://field-window/")
      ),
    `${context}: candidate templates did not produce working new record and field-window URIs`
  )
}

function compareLegacyAliases(
  baseSession: JsonObject,
  candidateSession: JsonObject,
  context: string
): void {
  assert.equal(
    candidateSession.fetchId,
    candidateSession.searchedFetchId,
    `${context}: search result id was not usable by fetch`
  )
  assert.equal(
    typeof candidateSession.fetchMetadataConnectionId,
    "string",
    `${context}: fetch stopped emitting connection_id metadata`
  )
  assert.equal(
    typeof candidateSession.queryRecordConnectionId,
    "string",
    `${context}: query_records stopped emitting connection_id`
  )
  assert.deepEqual(
    candidateSession.observedConnectionIds,
    baseSession.observedConnectionIds,
    `${context}: observed connection_id aliases changed`
  )
  assert.deepEqual(
    object(candidateSession.storedIds).connectionIds,
    object(baseSession.storedIds).connectionIds,
    `${context}: stored connection_id aliases changed`
  )
  const baseSearchKeys = baseSession.searchResultKeys as string[]
  const candidateSearchKeys = candidateSession.searchResultKeys as string[]
  for (const key of baseSearchKeys)
    assert(
      candidateSearchKeys.includes(key),
      `${context}: search result output key '${key}' disappeared`
    )
}

function compareDiscovery(
  baseSession: JsonObject,
  candidateSession: JsonObject,
  context: string
): void {
  const baseInit = object(baseSession.initialize)
  const candidateInit = object(candidateSession.initialize)
  assert.equal(
    candidateInit.protocolVersion,
    baseInit.protocolVersion,
    `${context}: initialize protocolVersion changed`
  )
  assert.equal(
    candidateInit.olderProtocolVersion,
    baseInit.olderProtocolVersion,
    `${context}: older requested protocol version negotiation changed`
  )
  assert.equal(
    candidateInit.instructionsPresent,
    true,
    `${context}: initialize instructions are missing`
  )
  const compareShape = (
    baseShape: unknown,
    candidateShape: unknown,
    path: string
  ): void => {
    if (typeof baseShape === "string") {
      assert.equal(
        candidateShape,
        baseShape,
        `${context}: ${path} changed type`
      )
      return
    }
    const expected = object(baseShape)
    const actual = object(candidateShape)
    assert.equal(actual.type, expected.type, `${context}: ${path} changed type`)
    if (expected.type === "object") {
      const actualProperties = object(actual.properties)
      for (const [key, child] of Object.entries(object(expected.properties))) {
        assert(
          Object.hasOwn(actualProperties, key),
          `${context}: ${path}.${key} disappeared`
        )
        compareShape(child, actualProperties[key], `${path}.${key}`)
      }
    }
    if (expected.type === "array") {
      const baseElements = Array.isArray(expected.elements)
        ? expected.elements
        : []
      const candidateElements = Array.isArray(actual.elements)
        ? actual.elements
        : []
      for (const [index, child] of baseElements.entries()) {
        assert(
          candidateElements.some((candidateChild: unknown) => {
            try {
              compareShape(child, candidateChild, `${path}[]`)
              return true
            } catch {
              return false
            }
          }),
          `${context}: ${path} array element shape disappeared at ${index}`
        )
      }
    }
  }
  compareShape(
    baseSession.capabilities,
    candidateSession.capabilities,
    "initialize capabilities"
  )
  for (const key of ["resourcesList", "resourceTemplatesList"]) {
    compareShape(baseSession[key], candidateSession[key], key)
  }
  const baseAnnotations = object(baseSession.annotations)
  const candidateAnnotations = object(candidateSession.annotations)
  for (const [tool, annotations] of Object.entries(baseAnnotations)) {
    const actual = object(candidateAnnotations[tool])
    assert(
      candidateAnnotations[tool],
      `${context}: tool '${tool}' annotations disappeared`
    )
    for (const [key, value] of Object.entries(object(annotations))) {
      assert.equal(
        actual[key],
        value,
        `${context}: tool '${tool}' annotation '${key}' changed`
      )
    }
  }
}

test("hosted /mcp preserves the existing client-token contract", async () => {
  const base = readContract(FIXTURE)
  const candidate = await captureExistingClientContract("client")
  compareClient(object(base.client), object(candidate.client))
})

test("hosted /mcp package tokens remain implicit or offer child discovery", async () => {
  const base = readContract(FIXTURE)
  const basePackageIds = object(object(base.package).session).storedIds
  const candidate = await captureExistingClientContract(
    "package",
    object(basePackageIds)
  )
  comparePackage(object(base.package), object(candidate.package))
})

test("hosted package resource URIs preserve stored handles and advertise selected forms", async () => {
  const base = readContract(FIXTURE)
  const baseSession = object(object(base.package).session)
  const resourceSession = await capturePackageResourceSession(
    object(baseSession.storedIds)
  )
  const candidateSession = object(resourceSession)
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  const discovery = object(candidateSession.resourceDiscovery)
  const templates = Array.isArray(discovery.resourceTemplates)
    ? (discovery.resourceTemplates as JsonObject[])
    : []
  const reads = Array.isArray(candidateSession.resourceReads)
    ? (candidateSession.resourceReads as JsonObject[])
    : []
  const storedIds = object(baseSession.storedIds)
  const oldUris = [
    ...new Set([
      ...((storedIds.recordUris as string[] | undefined) ?? []),
      ...((storedIds.fieldWindowUris as string[] | undefined) ?? []),
    ]),
  ]
  assert(oldUris.length > 0, "base package session captured no resource URIs")

  if (revision === "3282ac2f5e4687419bf391c2294d2118dd63fd7c") {
    assert.equal(
      stableJson(discovery),
      stableJson(baseSession.resourceDiscovery),
      "base package resource discovery differs from its golden snapshot"
    )
  } else {
    assert(
      !Array.isArray(discovery.errors) || discovery.errors.length === 0,
      `package resources: resources/list or resources/templates/list is unavailable: ${JSON.stringify(discovery.errors)}`
    )
    for (const name of ["pdpp-record", "pdpp-field-window"]) {
      const template = templates.find(item => item.name === name)
      assert(
        template,
        `package resources: resources/templates/list removed '${name}'`
      )
      assert(
        typeof template.uriTemplate === "string" &&
          template.uriTemplate.includes("{grant_id}/{handle}"),
        `package resources: '${name}' does not advertise the grant_id URI form`
      )
    }
    assert(
      templates.every(
        item =>
          typeof item.uriTemplate === "string" &&
          item.uriTemplate.includes("{grant_id}/")
      ),
      "package resources: resources/templates/list advertises a legacy or unscoped URI"
    )
  }

  const readsByUri = new Map(reads.map(read => [String(read.uri), read]))
  const ambiguous = new Set(
    (candidateSession.ambiguousLegacyUris as string[] | undefined) ?? []
  )
  for (const uri of oldUris) {
    const read = readsByUri.get(uri)
    assert(read, `package resources: old stored URI was not replayed: ${uri}`)
    if (ambiguous.has(uri)) {
      assert.equal(
        read.errorCode,
        "ambiguous_legacy_resource_uri",
        `package resources: refused old URI without genuine ambiguity: ${uri}`
      )
      continue
    }
    const content = Array.isArray(read.contents)
      ? (read.contents as JsonObject[])
      : []
    assert(
      !read.error &&
        read.isError !== true &&
        content.some(
          part => typeof part.text === "string" && part.text.trim().length > 0
        ),
      `package resources: old stored URI failed with 401/404 or no content: ${uri}; ${JSON.stringify(read.error ?? read.errorCode)}`
    )
  }
  if (revision !== "3282ac2f5e4687419bf391c2294d2118dd63fd7c") {
    const newReads = reads.filter(read => !oldUris.includes(String(read.uri)))
    assert(
      newReads.some(read => String(read.uri).startsWith("pdpp://record/")) &&
        newReads.some(read =>
          String(read.uri).startsWith("pdpp://field-window/")
        ),
      "package resources: candidate-advertised record and field-window URIs did not resolve"
    )
  }
})

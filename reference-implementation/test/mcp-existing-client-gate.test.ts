// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
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

function compareClient(base: JsonObject, candidate: JsonObject, compareResources = true): void {
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
  if (compareResources) assert.equal(
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
    compareClient(base, candidate, false)
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
  // The dedicated resource session below checks old and selected URI forms.
}

function comparePackageResources(
  baseSession: JsonObject,
  candidateSession: JsonObject,
  context: string
): void {
  const discovery = object(candidateSession.resourceDiscovery)
  const baseDiscovery = object(baseSession.resourceDiscovery)
  const templates = (discovery.resourceTemplates ?? []) as JsonObject[]
  const baseTemplates = (baseDiscovery.resourceTemplates ?? []) as JsonObject[]
  assert(!Array.isArray(discovery.errors) || !discovery.errors.length,
    `${context}: resource discovery is unavailable`)
  assert(baseTemplates.length > 0, `${context}: base captured no resource templates`)
  for (const baseTemplate of baseTemplates) {
    const template = templates.find(item => item.name === baseTemplate.name)
    assert(template, `${context}: resources/templates/list removed '${baseTemplate.name}'`)
    assert(typeof template.uriTemplate === "string", `${context}: invalid resource template`)
    assert(template.uriTemplate === baseTemplate.uriTemplate ||
      (template.uriTemplate.includes("{grant_id}") && template.uriTemplate.includes("{handle}")),
      `${context}: resource template neither preserves base nor advertises child selection`)
  }
  const selected = templates.some(item => String(item.uriTemplate).includes("{grant_id}"))
  if (!selected) assert.deepEqual(discovery, baseDiscovery,
    `${context}: unchanged resource forms must preserve base discovery`)
  const ids = object(baseSession.storedIds)
  const oldUris = [...new Set([
    ...((ids.recordUris ?? []) as string[]),
    ...((ids.fieldWindowUris ?? []) as string[]),
  ])]
  assert(oldUris.length > 0, `${context}: base captured no stored resource URIs`)
  const reads = (candidateSession.resourceReads ?? []) as JsonObject[]
  const byUri = new Map(reads.map(read => [String(read.uri), read]))
  const baseReads = new Map(((baseSession.resourceReads ?? []) as JsonObject[])
    .map(read => [String(read.uri), read]))
  const ambiguous = new Set((candidateSession.ambiguousLegacyUris ?? []) as string[])
  const contents = (read: JsonObject): JsonObject[] =>
    ((read.contents ?? []) as JsonObject[]).map(part => ({ mimeType: part.mimeType, text: part.text }))
  const successful = (read: JsonObject | undefined, uri: string): JsonObject => {
    assert(read, `${context}: stored URI was not replayed: ${uri}`)
    assert(!read.error && read.isError !== true && read.ambiguous !== true &&
      contents(read).some(part => typeof part.text === "string" && part.text.trim()),
      `${context}: resources/read failed or returned no content: ${uri}`)
    return read
  }
  for (const uri of oldUris) {
    const base = successful(baseReads.get(uri), uri)
    const read = byUri.get(uri)
    assert(read, `${context}: old stored URI was not replayed: ${uri}`)
    if (selected && ambiguous.has(uri) && (read.isError === true || read.error || read.ambiguous)) {
      assert.equal(read.errorCode, "ambiguous_legacy_resource_uri",
        `${context}: old URI refusal must identify genuine multi-child ambiguity: ${uri}`)
      continue
    }
    assert.deepEqual(contents(successful(read, uri)), contents(base),
      `${context}: stored URI content changed: ${uri}`)
  }
  if (!selected) return
  const selectedReads = (candidateSession.selectedResourceReads ?? []) as JsonObject[]
  const grantIds = (candidateSession.discoveryGrantIds ?? []) as string[]
  assert(grantIds.length > 0, `${context}: selected forms need child discovery`)
  for (const resource of (discovery.resources ?? []) as JsonObject[]) {
    assert(typeof resource.uri === "string" &&
      grantIds.some(id => String(resource.uri).includes(`/${encodeURIComponent(id)}/`)),
      `${context}: advertised resource lacks discovered child selection`)
    successful(byUri.get(String(resource.uri)), String(resource.uri))
  }
  for (const uri of oldUris) {
    assert(selectedReads.some(read => read.oldUri === uri),
      `${context}: advertised selected form was not exercised for ${uri}`)
  }
  for (const selection of selectedReads) {
    assert(grantIds.includes(String(selection.grantId)), `${context}: undiscovered child`)
    const read = successful(byUri.get(String(selection.uri)), String(selection.uri))
    const base = successful(baseReads.get(String(selection.oldUri)), String(selection.oldUri))
    assert.deepEqual(contents(read), contents(base), `${context}: selected child returned different content`)
  }
  const wrongChildUris = (candidateSession.wrongChildUris ?? []) as string[]
  assert(wrongChildUris.length > 0, `${context}: wrong-child resource probes were not exercised`)
  for (const uri of wrongChildUris) {
    const read = byUri.get(uri)
    assert(read && (read.error || read.isError === true) && !contents(read).length,
      `${context}: resource resolved for the wrong child: ${uri}`)
  }
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
  comparePackageResources(baseSession, resourceSession, "package resources")
})

// Synthetic observations exercise the comparator independently of a live server.
test("package resource gate rejects removed discovery, reads and changed stored content", () => {
  const uri = "fixture://record/old-handle"
  const base: JsonObject = {
    storedIds: { recordUris: [uri] },
    resourceDiscovery: { resources: [], resourceTemplates: [
      { name: "record", uriTemplate: "fixture://record/{handle}" },
    ] },
    resourceReads: [{ uri, contents: [{ mimeType: "text/plain", text: "original" }] }],
  }
  comparePackageResources(base, structuredClone(base), "unchanged base")
  const removedTemplates = structuredClone(base)
  object(removedTemplates.resourceDiscovery).resourceTemplates = []
  assert.throws(() => comparePackageResources(base, removedTemplates, "B1 templates"), /removed/)
  const removedReads = structuredClone(base)
  removedReads.resourceReads = [{ uri, error: { code: -32601 } }]
  assert.throws(() => comparePackageResources(base, removedReads, "B1 reads"), /resources\/read failed/)
  const brokenUri = structuredClone(base)
  brokenUri.resourceReads = [{ uri, contents: [{ mimeType: "text/plain", text: "wrong record" }] }]
  assert.throws(() => comparePackageResources(base, brokenUri, "broken URI"), /content changed/)

  const selected = structuredClone(base)
  object(selected.resourceDiscovery).resourceTemplates = [
    { name: "record", uriTemplate: "fixture://record/{grant_id}/{handle}" },
  ]
  selected.discoveryGrantIds = ["child-a", "child-b"]
  selected.selectedResourceReads = [{ uri: "fixture://record/child-a/old-handle", oldUri: uri, grantId: "child-a" }]
  selected.wrongChildUris = ["fixture://record/child-b/old-handle"]
  selected.resourceReads = [
    ...(base.resourceReads as JsonObject[]),
    { uri: "fixture://record/child-a/old-handle", contents: [{ mimeType: "text/plain", text: "original" }] },
    { uri: "fixture://record/child-b/old-handle", isError: true, contents: [] },
  ]
  comparePackageResources(base, selected, "selected forms")
  const brokenSelected = structuredClone(selected)
  ;(brokenSelected.resourceReads as JsonObject[])[1].isError = true
  assert.throws(() => comparePackageResources(base, brokenSelected, "broken selected read"), /resources\/read failed/)
  const ambiguous = structuredClone(selected)
  ambiguous.ambiguousLegacyUris = [uri]
  ;(ambiguous.resourceReads as JsonObject[])[0] = {
    uri, isError: true, errorCode: "ambiguous_legacy_resource_uri", contents: [],
  }
  comparePackageResources(base, ambiguous, "genuine ambiguity")
  ambiguous.ambiguousLegacyUris = []
  assert.throws(() => comparePackageResources(base, ambiguous, "false ambiguity"), /resources\/read failed/)
})

test("local MCP resource selection requires the canonical advertised host", async () => {
  const { selectResourceURL } = await import("@modelcontextprotocol/sdk/client/auth.js")
  const metadata = { resource: "http://localhost:43210/mcp" }
  assert.equal((await selectResourceURL(new URL(metadata.resource), {}, metadata))?.href, metadata.resource)
  await assert.rejects(async () => selectResourceURL(new URL("http://127.0.0.1:43210/mcp"), {}, metadata))
})

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export const PDPP_DATA_ACCESS_TYPE = "https://pdpp.org/data-access"

const DETAIL_FIELDS = new Set([
  "type",
  "source",
  "access_mode",
  "purpose_code",
  "purpose_description",
  "retention",
  "streams",
])
const STREAM_FIELDS = new Set([
  "name",
  "fields",
  "view",
  "resources",
  "time_range",
])
const GITHUB_STREAM_SCOPES = {
  user: "github.profile",
  repositories: "github.repositories",
  starred: "github.starred",
}

export const LOCAL_TIMELINE_CLIENT_ID = "dataconnect.timeline"

/**
 * The built-in Timeline is a first-party PDPP client, not a bypass around
 * authorization. Its request is deliberately derived from the installed,
 * verified profile rather than accepting a broader set of terms from the UI.
 */
export function createLocalTimelineAuthorizationRequest(manifest) {
  const streams = (manifest?.streams ?? [])
    .filter(stream => typeof stream?.name === "string" && stream.name)
    .map(stream => ({ name: stream.name }))
  if (!streams.length) {
    throw invalid(
      "The installed GitHub profile has no Timeline-compatible streams"
    )
  }
  return {
    // These are first-party consent labels, not Session Relay's legacy GitHub
    // scopes. The grant itself remains bound to the verified manifest below.
    scopes: streams.map(stream => `pdpp.local.github.${stream.name}`),
    authorizationDetails: [
      {
        type: PDPP_DATA_ACCESS_TYPE,
        source: { kind: "connector", id: "github" },
        access_mode: "continuous",
        purpose_code: "https://dataconnect.app/purposes/timeline",
        purpose_description:
          "Show your connected records in DataConnect's local Timeline.",
        streams,
      },
    ],
  }
}

function invalid(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

function object(value, allowed, message) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(message)
  const unsupported = Object.keys(value).filter(key => !allowed.has(key))
  if (unsupported.length)
    throw invalid(`${message}; unsupported fields: ${unsupported.join(", ")}`)
}

function string(value, message) {
  if (typeof value !== "string" || !value.trim()) throw invalid(message)
  return value.trim()
}

function absoluteUri(value) {
  try {
    return typeof value === "string" && new URL(value).protocol.length > 1
  } catch {
    return false
  }
}

function normalizeRetention(value) {
  object(value, new Set(["max_duration", "on_expiry"]), "Invalid retention")
  if (
    typeof value.max_duration !== "string" ||
    !/^P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/.test(
      value.max_duration
    )
  ) {
    throw invalid("retention.max_duration must be an ISO 8601 duration")
  }
  if (!["delete", "anonymize"].includes(value.on_expiry)) {
    throw invalid('retention.on_expiry must be "delete" or "anonymize"')
  }
  return { max_duration: value.max_duration, on_expiry: value.on_expiry }
}

function normalizeTimeRange(value, streamName) {
  object(
    value,
    new Set(["since", "until"]),
    `Invalid time_range for '${streamName}'`
  )
  const range = {}
  for (const key of ["since", "until"]) {
    if (value[key] === undefined) continue
    if (
      typeof value[key] !== "string" ||
      Number.isNaN(Date.parse(value[key]))
    ) {
      throw invalid(
        `time_range.${key} for '${streamName}' must be an ISO timestamp`
      )
    }
    range[key] = new Date(value[key]).toISOString()
  }
  if (!range.since && !range.until)
    throw invalid(`time_range for '${streamName}' cannot be empty`)
  if (range.since && range.until && range.since > range.until) {
    throw invalid(
      `time_range.since must not be after time_range.until for '${streamName}'`
    )
  }
  return range
}

function sameScopeSet(requested, actual) {
  return (
    requested.length === actual.length &&
    [...requested]
      .sort()
      .every((scope, index) => scope === [...actual].sort()[index])
  )
}

function normalizeSelectedFields(stream, selected) {
  const required = Array.isArray(stream.schema?.required)
    ? stream.schema.required
    : []
  const fields = [...new Set([...required, ...selected])]
  const allowed = new Set(Object.keys(stream.schema?.properties ?? {}))
  const unknown = fields.filter(field => !allowed.has(field))
  if (unknown.length) {
    throw invalid(
      `Unknown fields on stream '${stream.name}': ${unknown.join(", ")}`
    )
  }
  return fields
}

/**
 * Validate and normalize the single GitHub RFC 9396 detail against the
 * currently hash-verified installed manifest. The stream-to-scope check binds
 * this additional authorization to the legacy Session Relay authorization.
 */
export function validateAuthorizationDetails({
  authorizationDetails,
  manifest,
  scopes,
  scopeForStream,
  sourceIds = [manifest?.connector_key, manifest?.connector_id],
  localTimeline = false,
}) {
  if (
    !Array.isArray(authorizationDetails) ||
    authorizationDetails.length !== 1
  ) {
    throw invalid(
      "This UAT adapter accepts exactly one authorization_details entry"
    )
  }
  if (
    !Array.isArray(scopes) ||
    !scopes.every(scope => typeof scope === "string" && scope)
  ) {
    throw invalid("scopes are required")
  }
  const detail = authorizationDetails[0]
  object(detail, DETAIL_FIELDS, "Invalid authorization_details entry")
  if (detail.type !== PDPP_DATA_ACCESS_TYPE)
    throw invalid("Unsupported authorization_details type")
  if (
    !detail.source ||
    detail.source.kind !== "connector" ||
    !sourceIds.includes(detail.source.id) ||
    Object.keys(detail.source).length !== 2
  ) {
    throw invalid("source must identify the selected connector")
  }
  const canonicalSourceId = string(
    manifest.connector_key,
    "manifest.connector_key is required"
  )
  if (!["single_use", "continuous"].includes(detail.access_mode)) {
    throw invalid('access_mode must be "single_use" or "continuous"')
  }
  if (!absoluteUri(detail.purpose_code))
    throw invalid("purpose_code must be a syntactically valid absolute URI")
  if (
    detail.purpose_description !== undefined &&
    typeof detail.purpose_description !== "string"
  ) {
    throw invalid("purpose_description must be a string")
  }
  if (!Array.isArray(detail.streams) || !detail.streams.length)
    throw invalid("streams must be a non-empty array")

  const seen = new Set()
  const normalizedStreams = detail.streams.map(request => {
    object(request, STREAM_FIELDS, "Invalid stream selection")
    const name = string(request.name, "stream.name is required")
    if (seen.has(name)) throw invalid(`Duplicate stream '${name}'`)
    seen.add(name)
    const stream = manifest.streams.find(candidate => candidate?.name === name)
    if (!stream) throw invalid(`Unknown stream '${name}'`)
    if (request.fields !== undefined && request.view !== undefined) {
      throw invalid(`Stream '${name}' view and fields are mutually exclusive`)
    }
    const normalized = { name }
    if (request.view !== undefined) {
      const view = stream.views?.find(
        candidate => candidate?.id === request.view
      )
      if (!view || !Array.isArray(view.fields))
        throw invalid(`Unknown view '${request.view}' on stream '${name}'`)
      normalized.view = view.id
      normalized.fields = normalizeSelectedFields(stream, view.fields)
    }
    if (request.fields !== undefined) {
      if (
        !stream.selection?.fields ||
        !Array.isArray(request.fields) ||
        !request.fields.length
      ) {
        throw invalid(`Stream '${name}' does not support this field selection`)
      }
      const fields = request.fields.map(field =>
        string(field, `Invalid field on '${name}'`)
      )
      normalized.fields = normalizeSelectedFields(stream, fields)
    }
    if (request.resources !== undefined) {
      if (
        !stream.selection?.resources ||
        !Array.isArray(request.resources) ||
        !request.resources.length
      ) {
        throw invalid(
          `Stream '${name}' does not support this resource selection`
        )
      }
      normalized.resources = [
        ...new Set(
          request.resources.map(resource =>
            string(resource, `Invalid resource on '${name}'`)
          )
        ),
      ]
    }
    if (request.time_range !== undefined) {
      if (!stream.consent_time_field)
        throw invalid(`Stream '${name}' does not support time_range`)
      normalized.time_range = normalizeTimeRange(request.time_range, name)
    }
    return normalized
  })

  const requestedScopes = normalizedStreams.map(stream => {
    if (localTimeline) return `pdpp.local.github.${stream.name}`
    return scopeForStream?.(stream.name)
  })
  if (
    requestedScopes.some(scope => !scope) ||
    !sameScopeSet(requestedScopes, scopes)
  ) {
    throw invalid(
      "Authorization details do not exactly match the claimed session scopes"
    )
  }
  return {
    type: PDPP_DATA_ACCESS_TYPE,
    source: { kind: "connector", id: canonicalSourceId },
    access_mode: detail.access_mode,
    purpose_code: detail.purpose_code,
    purpose_description: detail.purpose_description,
    retention:
      detail.retention === undefined
        ? undefined
        : normalizeRetention(detail.retention),
    streams: normalizedStreams,
  }
}

/** GitHub policy is retained as the legacy Session Relay compatibility adapter. */
export function validateGithubAuthorizationDetails(options) {
  return validateAuthorizationDetails({
    ...options,
    sourceIds: ["github", "https://registry.pdpp.org/connectors/github"],
    scopeForStream: stream => GITHUB_STREAM_SCOPES[stream],
  })
}

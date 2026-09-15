// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  listActivePdppConnectorIds,
  loadInstalledManifest,
} from "./installed-manifest.js"

const CANONICAL_DOMAINS = ["org", "dev"]
const GITHUB_STREAM_SCOPES = {
  user: "github.profile",
  repositories: "github.repositories",
  starred: "github.starred",
}
const CHATGPT_STREAMS = new Set([
  "conversations",
  "messages",
  "memories",
  "custom_gpts",
  "custom_instructions",
  "shared_conversations",
])

function isCanonicalIdentity(connectorKey, connectorId) {
  return CANONICAL_DOMAINS.some(
    domain =>
      connectorId ===
      `https://registry.pdpp.${domain}/connectors/${connectorKey}`
  )
}

export function pdppServingScope({
  connectorKey,
  connectorId,
  manual,
  stream,
}) {
  if (manual) return `pdpp.manual.${connectorKey}.${stream}`
  if (isCanonicalIdentity(connectorKey, connectorId)) {
    if (connectorKey === "github" && GITHUB_STREAM_SCOPES[stream]) {
      return GITHUB_STREAM_SCOPES[stream]
    }
    if (connectorKey === "chatgpt" && CHATGPT_STREAMS.has(stream)) {
      return `chatgpt.${stream}`
    }
  }
  return `pdpp.${connectorKey}.${stream}`
}

export function createPdppServingProfile({ connectorId, installed }) {
  const manifest = installed.manifest
  const connectorKey = manifest.connector_key
  const connector = Object.freeze({
    key: connectorKey,
    id: manifest.connector_id,
  })
  const manual = manifest.setup?.modality === "manual_or_upload"
  const declaredTimeline = manifest.enableLocalTimeline
  const enableLocalTimeline =
    typeof declaredTimeline === "boolean"
      ? declaredTimeline
      : connectorKey === "github"

  return Object.freeze({
    connectorId,
    connector,
    streams: manifest.streams,
    scopeForStream: stream =>
      pdppServingScope({
        connectorKey,
        connectorId: manifest.connector_id,
        manual,
        stream,
      }),
    enableLocalTimeline,
    installed,
  })
}

export function servingProfileSnapshot(profile) {
  return {
    connectorId: profile.connectorId,
    connector: profile.connector,
    streams: profile.streams.map(stream => ({
      name: stream.name,
      scope: profile.scopeForStream(stream.name),
    })),
    enableLocalTimeline: profile.enableLocalTimeline,
  }
}

export function loadInstalledPdppServingProfiles({
  activeManifestPath,
  send = () => {},
} = {}) {
  let connectorIds
  try {
    connectorIds = listActivePdppConnectorIds({ activeManifestPath })
  } catch (error) {
    send({
      type: "log",
      message: `[pdpp] routes unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return []
  }

  return connectorIds.flatMap(connectorId => {
    try {
      const installed = loadInstalledManifest({
        activeManifestPath,
        connectorId,
        connectorLabel: `${connectorId} connector`,
      })
      return [createPdppServingProfile({ connectorId, installed })]
    } catch (error) {
      send({
        type: "log",
        message: `[pdpp] skipped installed profile ${connectorId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      return []
    }
  })
}

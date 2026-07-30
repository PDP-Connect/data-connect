import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { RecordsRepositoryError } from "./grant-scoped-records-repository.js"

async function visitJsonFiles(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await visitJsonFiles(path, files)
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path)
  }
}

/**
 * Return lossless GitHub export candidates newest first. The repository validates
 * their record envelopes transactionally before one is accepted for serving.
 */
export async function findGithubSnapshotCandidates({
  exportRoot,
  manifest,
  manifestDigest,
  connectionId,
}) {
  if (!exportRoot) return []
  const files = []
  try {
    await visitJsonFiles(exportRoot, files)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
  const candidates = []
  for (const path of files) {
    try {
      const exportFile = JSON.parse(await readFile(path, "utf8"))
      const content = exportFile?.content
      const recordsByStream = content?.["pdpp.recordsByStream"]
      if (
        content?.platform !== "github" ||
        content?.version !== manifest.version ||
        !hasVerifiedSnapshotProvenance({
          provenance: content?.["pdpp.provenance"],
          manifest,
          manifestDigest,
          connectionId,
        }) ||
        !isPlainObject(recordsByStream)
      )
        continue
      const timestamp = exportTimestamp(exportFile, content, await stat(path))
      candidates.push({
        path,
        recordsByStream,
        snapshot: content?.["pdpp.snapshot"],
        timestamp,
      })
    } catch {
      // Incomplete and unrelated exports must never become serving inputs.
    }
  }
  return candidates.sort((left, right) => right.timestamp - left.timestamp)
}

/**
 * Import the newest candidate that passes the durable repository's complete
 * record validation. `importSnapshot` is one SQLite transaction, so a rejected
 * candidate cannot leave partial collection state behind.
 */
export async function importLatestGithubSnapshot({
  exportRoot,
  manifest,
  manifestDigest,
  repository,
  connectionId,
}) {
  const candidates = await findGithubSnapshotCandidates({
    exportRoot,
    manifest,
    manifestDigest,
    connectionId,
  })
  for (const candidate of candidates) {
    try {
      repository.importSnapshot({
        connectionId,
        recordsByStream: candidate.recordsByStream,
        snapshot: candidate.snapshot,
      })
      return candidate
    } catch (error) {
      if (!(error instanceof RecordsRepositoryError)) throw error
    }
  }
  return null
}

/**
 * The export is a local hand-off, not an authority in its own right. It may
 * only serve the specific installed artifact and connection that produced it.
 */
function hasVerifiedSnapshotProvenance({
  provenance,
  manifest,
  manifestDigest,
  connectionId,
}) {
  return (
    isPlainObject(provenance) &&
    provenance.connector_key === manifest.connector_key &&
    provenance.connector_id === manifest.connector_id &&
    provenance.manifest_version === manifest.version &&
    provenance.manifest_sha256 === manifestDigest &&
    typeof provenance.run_id === "string" &&
    provenance.run_id.length > 0 &&
    provenance.connection_id === connectionId
  )
}

function exportTimestamp(exportFile, content, metadata) {
  for (const value of [
    exportFile?.timestamp,
    content?.exportedAt,
    content?.timestamp,
  ]) {
    const timestamp =
      typeof value === "string" ? Date.parse(value) : Number(value)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return metadata.mtimeMs
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

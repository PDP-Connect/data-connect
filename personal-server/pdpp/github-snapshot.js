import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import { RecordsRepositoryError } from "./grant-scoped-records-repository.js"

const DEFAULT_FILE_OPERATIONS = { readdir, readFile, stat }

async function visitJsonFiles(
  directory,
  files,
  directories,
  fileOperations
) {
  directories.set(
    directory,
    directoryGeneration(await fileOperations.stat(directory))
  )
  for (const entry of await fileOperations.readdir(directory, {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      await visitJsonFiles(path, files, directories, fileOperations)
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
  fileCache = new Map(),
  directoryCache = new Map(),
  authoritativePath = null,
  fileOperations = DEFAULT_FILE_OPERATIONS,
}) {
  if (!exportRoot) return []
  if (
    directoryCache.size > 0 &&
    !(await exportTreeChanged({
      directoryCache,
      fileCache,
      authoritativePath,
      fileOperations,
    }))
  ) {
    return cachedMatchingCandidates(fileCache)
  }
  const files = []
  const directories = new Map()
  try {
    await visitJsonFiles(exportRoot, files, directories, fileOperations)
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw error
  }
  directoryCache.clear()
  for (const [path, generation] of directories) {
    directoryCache.set(path, generation)
  }
  const present = new Set(files)
  for (const path of fileCache.keys()) {
    if (!present.has(path)) fileCache.delete(path)
  }
  const candidates = []
  for (const path of files) {
    try {
      const metadata = await fileOperations.stat(path)
      const generation = fileGeneration(path, metadata)
      const cached = fileCache.get(path)
      if (cached?.generation === generation) {
        if (cached.matches) {
          candidates.push({ path, generation, timestamp: cached.timestamp })
        }
        continue
      }
      const result = await readGithubSnapshotCandidate({
        path,
        generation,
        metadata,
        manifest,
        manifestDigest,
        connectionId,
        fileOperations,
      })
      if (result.status === "changed") continue
      if (result.status === "ignored") {
        fileCache.set(path, { generation, matches: false })
        continue
      }
      fileCache.set(path, {
        generation,
        matches: true,
        timestamp: result.candidate.timestamp,
      })
      candidates.push(result.candidate)
    } catch {
      // Incomplete and unrelated exports must never become serving inputs.
      fileCache.delete(path)
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
  snapshotCache = {
    files: new Map(),
    directories: new Map(),
    importedGeneration: null,
    importedPath: null,
    rejectedGenerations: new Set(),
  },
  fileOperations = DEFAULT_FILE_OPERATIONS,
}) {
  const candidates = await findGithubSnapshotCandidates({
    exportRoot,
    manifest,
    manifestDigest,
    connectionId,
    fileCache: snapshotCache.files,
    directoryCache: snapshotCache.directories,
    authoritativePath: snapshotCache.importedPath,
    fileOperations,
  })
  for (const candidate of candidates) {
    if (snapshotCache.importedGeneration === candidate.generation) {
      return candidate
    }
    if (snapshotCache.rejectedGenerations.has(candidate.generation)) continue
    const loaded =
      candidate.recordsByStream === undefined
        ? await loadCachedCandidate({
            candidate,
            manifest,
            manifestDigest,
            connectionId,
            fileOperations,
          })
        : candidate
    if (loaded === null) {
      snapshotCache.files.delete(candidate.path)
      continue
    }
    try {
      repository.importSnapshot({
        connectionId,
        recordsByStream: loaded.recordsByStream,
        snapshot: loaded.snapshot,
      })
      snapshotCache.importedGeneration = loaded.generation
      snapshotCache.importedPath = loaded.path
      return loaded
    } catch (error) {
      if (!(error instanceof RecordsRepositoryError)) throw error
      snapshotCache.rejectedGenerations.add(loaded.generation)
    }
  }
  return null
}

async function exportTreeChanged({
  directoryCache,
  fileCache,
  authoritativePath,
  fileOperations,
}) {
  try {
    for (const [path, generation] of directoryCache) {
      const current = directoryGeneration(await fileOperations.stat(path))
      if (current !== generation) return true
    }
    if (authoritativePath !== null) {
      const cached = fileCache.get(authoritativePath)
      if (!cached) return true
      const current = fileGeneration(
        authoritativePath,
        await fileOperations.stat(authoritativePath)
      )
      if (current !== cached.generation) return true
    }
    return false
  } catch {
    return true
  }
}

function cachedMatchingCandidates(fileCache) {
  return [...fileCache.entries()]
    .filter(([, cached]) => cached.matches)
    .map(([path, cached]) => ({
      path,
      generation: cached.generation,
      timestamp: cached.timestamp,
    }))
    .sort((left, right) => right.timestamp - left.timestamp)
}

async function loadCachedCandidate({
  candidate,
  manifest,
  manifestDigest,
  connectionId,
  fileOperations,
}) {
  try {
    const metadata = await fileOperations.stat(candidate.path)
    if (fileGeneration(candidate.path, metadata) !== candidate.generation) {
      return null
    }
    const result = await readGithubSnapshotCandidate({
      path: candidate.path,
      generation: candidate.generation,
      metadata,
      manifest,
      manifestDigest,
      connectionId,
      fileOperations,
    })
    return result.status === "matching" ? result.candidate : null
  } catch {
    return null
  }
}

async function readGithubSnapshotCandidate({
  path,
  generation,
  metadata,
  manifest,
  manifestDigest,
  connectionId,
  fileOperations,
}) {
  const contents = await fileOperations.readFile(path, "utf8")
  const afterRead = await fileOperations.stat(path)
  if (fileGeneration(path, afterRead) !== generation) {
    return { status: "changed" }
  }
  let exportFile
  try {
    exportFile = JSON.parse(contents)
  } catch {
    return { status: "ignored" }
  }
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
  ) {
    return { status: "ignored" }
  }
  return {
    status: "matching",
    candidate: {
      path,
      generation,
      recordsByStream,
      snapshot: content?.["pdpp.snapshot"],
      timestamp: exportTimestamp(exportFile, content, metadata),
    },
  }
}

function fileGeneration(path, metadata) {
  return `${path}\0${metadata.mtimeMs}:${metadata.size}`
}

function directoryGeneration(metadata) {
  return `${metadata.mtimeMs}:${metadata.size}`
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

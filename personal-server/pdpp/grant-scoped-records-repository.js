import Database from "better-sqlite3"

export const GITHUB_STREAMS = Object.freeze({
  user: {
    requiredFields: ["id", "login"],
    cursorField: "updated_at",
    consentTimeField: "created_at",
    fields: [
      "id",
      "login",
      "name",
      "email",
      "bio",
      "company",
      "location",
      "blog",
      "twitter_username",
      "created_at",
      "updated_at",
      "avatar_url",
    ],
  },
  repositories: {
    requiredFields: ["id", "full_name"],
    cursorField: "pushed_at",
    consentTimeField: "created_at",
    fields: [
      "id",
      "name",
      "full_name",
      "owner_login",
      "description",
      "private",
      "fork",
      "archived",
      "disabled",
      "default_branch",
      "language",
      "topics",
      "stargazers_count",
      "forks_count",
      "open_issues_count",
      "watchers_count",
      "size_kb",
      "license_key",
      "html_url",
      "homepage",
      "created_at",
      "updated_at",
      "pushed_at",
    ],
  },
  starred: {
    requiredFields: ["id", "full_name"],
    cursorField: "starred_at",
    consentTimeField: "starred_at",
    fields: [
      "id",
      "full_name",
      "description",
      "language",
      "stargazers_count",
      "html_url",
      "starred_at",
    ],
  },
})

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

/** An incremental cursor predates the change history that remains on disk. */
export class CursorExpiredError extends Error {
  constructor() {
    super("The changes_since cursor has expired; perform a complete re-sync")
    this.name = "CursorExpiredError"
    this.code = "cursor_expired"
  }
}

/** A caller supplied an invalid record, identity, or opaque cursor. */
export class RecordsRepositoryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "RecordsRepositoryError"
    this.code = code
  }
}

/**
 * Durable current-state and change-log storage for the restricted GitHub UAT.
 *
 * A connection ID is storage provenance, not grant identity: the same collected
 * record can be disclosed through multiple grants without duplicating state.
 * Grant constraints are deliberately a read-time input to keep collection
 * state and disclosure policy independent.
 */
export class GrantScopedRecordsRepository {
  #db
  #now
  #historyLimit
  #onMutationStep

  constructor({
    databasePath,
    now = () => new Date().toISOString(),
    changeHistoryLimit = null,
    onMutationStep = null,
  }) {
    if (typeof databasePath !== "string" || databasePath.length === 0) {
      throw new TypeError("databasePath must be a non-empty string")
    }
    if (
      changeHistoryLimit !== null &&
      (!Number.isInteger(changeHistoryLimit) || changeHistoryLimit < 1)
    ) {
      throw new TypeError(
        "changeHistoryLimit must be a positive integer or null"
      )
    }
    this.#db = new Database(databasePath)
    this.#db.pragma("journal_mode = WAL")
    this.#db.pragma("foreign_keys = ON")
    this.#now = now
    this.#historyLimit = changeHistoryLimit
    this.#onMutationStep = onMutationStep
    this.#createSchema()
  }

  close() {
    this.#db.close()
  }

  upsert({ connectionId, stream, key, data, emittedAt = this.#now() }) {
    const identity = validateLiveRecord({
      connectionId,
      stream,
      key,
      data,
      emittedAt,
    })
    return this.#mutate(identity, "upsert")
  }

  delete({ connectionId, stream, key, emittedAt = this.#now() }) {
    const identity = validateDelete({ connectionId, stream, key, emittedAt })
    return this.#mutate(identity, "delete")
  }

  /**
   * Imports the lossless DataConnect `pdpp.recordsByStream` envelope map.
   * The whole snapshot is one transaction, so malformed input cannot leave a
   * partially imported connector run behind.
   */
  importSnapshot({ connectionId, recordsByStream, snapshot }) {
    requireNonEmptyString(connectionId, "connectionId")
    if (!isPlainObject(recordsByStream)) {
      throw new RecordsRepositoryError(
        "invalid_snapshot",
        "recordsByStream must be an object"
      )
    }
    const snapshotMetadata = validateSnapshotMetadata(snapshot, recordsByStream)

    const apply = this.#db.transaction(() => {
      const results = []
      const observedKeysByResetStream = new Map(
        snapshotMetadata.resetStreams.map(stream => [stream, new Set()])
      )
      for (const [stream, records] of Object.entries(recordsByStream)) {
        requireStream(stream)
        if (!Array.isArray(records)) {
          throw new RecordsRepositoryError(
            "invalid_snapshot",
            `Stream '${stream}' must contain an array`
          )
        }
        for (const envelope of records) {
          if (!isPlainObject(envelope) || envelope.stream !== stream) {
            throw new RecordsRepositoryError(
              "invalid_record",
              `Record envelope does not belong to stream '${stream}'`
            )
          }
          const op = envelope.op ?? "upsert"
          if (op === "upsert") {
            const record = validateLiveRecord({
              connectionId,
              stream,
              key: envelope.key,
              data: envelope.data,
              emittedAt: envelope.emitted_at,
            })
            observedKeysByResetStream.get(stream)?.add(record.key)
            results.push(this.#mutateInTransaction(record, "upsert"))
          } else if (op === "delete") {
            results.push(
              this.#mutateInTransaction(
                validateDelete({
                  connectionId,
                  stream,
                  key: envelope.key,
                  emittedAt: envelope.emitted_at,
                }),
                "delete"
              )
            )
          } else {
            throw new RecordsRepositoryError(
              "invalid_record",
              `Unsupported record operation '${String(op)}'`
            )
          }
        }
      }
      for (const stream of snapshotMetadata.resetStreams) {
        results.push(
          ...this.#reconcileAuthoritativeFullRefreshInTransaction({
            connectionId,
            stream,
            presentKeys: observedKeysByResetStream.get(stream),
            emittedAt: snapshotMetadata.completedAt,
          })
        )
      }
      return results
    })
    return apply()
  }

  getCurrent({ connectionId, stream, key, grant }) {
    validateLocation({ connectionId, stream, key })
    const effectiveGrant = normalizeGrant(stream, grant)
    const row = this.#db
      .prepare(
        `
      SELECT record_key, payload, emitted_at
      FROM current_records
      WHERE connection_id = ? AND stream = ? AND record_key = ? AND deleted = 0
    `
      )
      .get(connectionId, stream, key)
    if (!row) return null
    return discloseLiveRow(row, stream, effectiveGrant)
  }

  summarizeCurrent({ connectionId, stream, grant }) {
    validateLocation({ connectionId, stream })
    const effectiveGrant = normalizeGrant(stream, grant)
    const metadata = GITHUB_STREAMS[stream]
    const visible = this.#db
      .prepare(
        `
      SELECT record_key, payload, emitted_at
      FROM current_records
      WHERE connection_id = ? AND stream = ? AND deleted = 0
    `
      )
      .all(connectionId, stream)
      .map(row => {
        const record = discloseLiveRow(row, stream, effectiveGrant)
        return record === null
          ? null
          : { cursorValue: JSON.parse(row.payload)[metadata.cursorField], record }
      })
      .filter(entry => entry !== null)
    const updated = visible
      .map(entry => entry.cursorValue)
      .filter(value => typeof value === "string")
      .sort()
      .at(-1) ?? null
    return { record_count: visible.length, last_updated: updated }
  }

  listCurrent({
    connectionId,
    stream,
    grant,
    fields,
    filter,
    limit = DEFAULT_LIMIT,
    cursor,
    order = "asc",
  }) {
    validateLocation({ connectionId, stream })
    const normalizedLimit = normalizeLimit(limit)
    const normalizedOrder = normalizeOrder(order)
    const effectiveGrant = normalizeGrant(stream, grant, fields)
    const pageCursor = cursor
      ? decodeCurrentCursor(cursor, connectionId, stream, normalizedOrder)
      : null
    const rows = this.#db
      .prepare(
        `
      SELECT record_key, payload, emitted_at
      FROM current_records
      WHERE connection_id = ? AND stream = ? AND deleted = 0
    `
      )
      .all(connectionId, stream)

    const visible = rows
      .map(row => {
        const record = discloseLiveRow(row, stream, effectiveGrant)
        return record === null
          ? null
          : {
              record,
              key: row.record_key,
              cursorValue:
                JSON.parse(row.payload)[GITHUB_STREAMS[stream].cursorField] ??
                null,
            }
      })
      .filter(
        entry =>
          entry !== null &&
          matchesExactFilter(
            entry.record.data,
            filter,
            stream,
            effectiveGrant.fields
          )
      )
      .sort((left, right) => compareCurrentRows(left, right, normalizedOrder))
      .filter(
        entry =>
          pageCursor === null ||
          compareCurrentRowToCursor(entry, pageCursor, normalizedOrder) > 0
      )

    const page = visible.slice(0, normalizedLimit)
    const hasMore = visible.length > page.length
    return {
      object: "list",
      data: page.map(entry => entry.record),
      has_more: hasMore,
      ...(hasMore
        ? {
            next_cursor: encodeCurrentCursor(
              page.at(-1),
              connectionId,
              stream,
              normalizedOrder
            ),
          }
        : {}),
    }
  }

  listChanges({
    connectionId,
    stream,
    grant,
    changesSince,
    cursor,
    limit = DEFAULT_LIMIT,
  }) {
    validateLocation({ connectionId, stream })
    const normalizedLimit = normalizeLimit(limit)
    const effectiveGrant = normalizeGrant(stream, grant)
    const session = cursor
      ? decodeChangesCursor(cursor, connectionId, stream)
      : this.#startChangesSession(connectionId, stream, changesSince)
    const changes =
      session.mode === "bootstrap"
        ? this.#bootstrapChanges(connectionId, stream, session)
        : this.#latestChangesInWindow(connectionId, stream, session)
    const disclosed = changes
      .map(change =>
        this.#discloseChange(
          change,
          connectionId,
          stream,
          session.sinceVersion,
          effectiveGrant
        )
      )
      .filter(record => record !== null)
      .sort((left, right) => left.version - right.version)
    const page = disclosed.slice(0, normalizedLimit)
    const hasMore = disclosed.length > page.length
    const response = {
      object: "list",
      data: page.map(({ version, ...record }) => record),
      has_more: hasMore,
    }
    if (hasMore) {
      response.next_cursor = encodeChangesCursor(
        {
          ...session,
          afterVersion: page.at(-1).version,
        },
        connectionId,
        stream
      )
    } else {
      response.next_changes_since = encodeChangesSince(
        session.horizonVersion,
        connectionId,
        stream
      )
    }
    return response
  }

  #createSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS current_records (
        connection_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        PRIMARY KEY (connection_id, stream, record_key)
      );
      CREATE TABLE IF NOT EXISTS record_changes (
        connection_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        version INTEGER NOT NULL,
        record_key TEXT NOT NULL,
        payload TEXT,
        emitted_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        PRIMARY KEY (connection_id, stream, version)
      );
      CREATE INDEX IF NOT EXISTS record_changes_by_key
        ON record_changes (connection_id, stream, record_key, version);
      CREATE TABLE IF NOT EXISTS version_counters (
        connection_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version INTEGER NOT NULL,
        PRIMARY KEY (connection_id, stream)
      );
    `)
  }

  #mutate(record, operation) {
    return this.#db.transaction(() =>
      this.#mutateInTransaction(record, operation)
    )()
  }

  #mutateInTransaction(record, operation) {
    const current = this.#db
      .prepare(
        `
      SELECT payload, deleted, version
      FROM current_records
      WHERE connection_id = ? AND stream = ? AND record_key = ?
    `
      )
      .get(record.connectionId, record.stream, record.key)
    const payload =
      operation === "upsert"
        ? canonicalJson(record.data)
        : (current?.payload ?? null)
    if (
      operation === "upsert" &&
      current &&
      current.deleted === 0 &&
      current.payload === payload
    ) {
      return { changed: false }
    }
    if (operation === "delete" && (!current || current.deleted === 1)) {
      return { changed: false }
    }

    const version = this.#db
      .prepare(
        `
      INSERT INTO version_counters (connection_id, stream, max_version)
      VALUES (?, ?, 1)
      ON CONFLICT(connection_id, stream) DO UPDATE SET max_version = max_version + 1
      RETURNING max_version
    `
      )
      .get(record.connectionId, record.stream).max_version
    this.#mutationStep("after-version", { ...record, operation, version })

    if (operation === "upsert") {
      this.#db
        .prepare(
          `
        INSERT INTO current_records (connection_id, stream, record_key, payload, emitted_at, version, deleted, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(connection_id, stream, record_key) DO UPDATE SET
          payload = excluded.payload, emitted_at = excluded.emitted_at, version = excluded.version,
          deleted = 0, deleted_at = NULL
      `
        )
        .run(
          record.connectionId,
          record.stream,
          record.key,
          payload,
          record.emittedAt,
          version
        )
    } else {
      this.#db
        .prepare(
          `
        UPDATE current_records
        SET emitted_at = ?, version = ?, deleted = 1, deleted_at = ?
        WHERE connection_id = ? AND stream = ? AND record_key = ?
      `
        )
        .run(
          record.emittedAt,
          version,
          record.emittedAt,
          record.connectionId,
          record.stream,
          record.key
        )
    }
    this.#mutationStep("after-current", { ...record, operation, version })

    this.#db
      .prepare(
        `
      INSERT INTO record_changes (connection_id, stream, version, record_key, payload, emitted_at, deleted, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        record.connectionId,
        record.stream,
        version,
        record.key,
        payload,
        record.emittedAt,
        operation === "delete" ? 1 : 0,
        operation === "delete" ? record.emittedAt : null
      )
    this.#mutationStep("after-change", { ...record, operation, version })
    this.#pruneHistory(record.connectionId, record.stream)
    return { changed: true, version }
  }

  /**
   * Turn records absent from a completed, authoritative full refresh into
   * ordinary durable delete changes. Incremental imports never call this;
   * their omitted records are deliberately ambiguous and remain current.
   */
  #reconcileAuthoritativeFullRefreshInTransaction({
    connectionId,
    stream,
    presentKeys,
    emittedAt,
  }) {
    const currentKeys = this.#db
      .prepare(
        `
      SELECT record_key
      FROM current_records
      WHERE connection_id = ? AND stream = ? AND deleted = 0
    `
      )
      .all(connectionId, stream)
      .map(row => row.record_key)
    return currentKeys
      .filter(key => !presentKeys.has(key))
      .map(key =>
        this.#mutateInTransaction(
          validateDelete({ connectionId, stream, key, emittedAt }),
          "delete"
        )
      )
  }

  #mutationStep(step, context) {
    if (this.#onMutationStep) this.#onMutationStep(step, context)
  }

  #pruneHistory(connectionId, stream) {
    if (this.#historyLimit === null) return
    this.#db
      .prepare(
        `
      DELETE FROM record_changes
      WHERE connection_id = ? AND stream = ? AND version <= (
        SELECT MAX(version) - ? FROM record_changes WHERE connection_id = ? AND stream = ?
      )
    `
      )
      .run(connectionId, stream, this.#historyLimit, connectionId, stream)
  }

  #startChangesSession(connectionId, stream, changesSince) {
    const { sinceVersion, isBeginning } = decodeChangesSince(
      changesSince,
      connectionId,
      stream
    )
    const horizon =
      this.#db
        .prepare(
          `
      SELECT max_version FROM version_counters WHERE connection_id = ? AND stream = ?
    `
        )
        .get(connectionId, stream)?.max_version ?? 0
    if (isBeginning) {
      return {
        mode: "bootstrap",
        sinceVersion: 0,
        afterVersion: 0,
        horizonVersion: horizon,
      }
    }
    const min = this.#db
      .prepare(
        `
      SELECT MIN(version) AS min_version FROM record_changes WHERE connection_id = ? AND stream = ?
    `
      )
      .get(connectionId, stream).min_version
    if (min !== null && sinceVersion < min - 1) throw new CursorExpiredError()
    return {
      mode: "changes",
      sinceVersion,
      afterVersion: sinceVersion,
      horizonVersion: horizon,
    }
  }

  #bootstrapChanges(connectionId, stream, session) {
    const currentRows = this.#db
      .prepare(
        `
      SELECT version, record_key, payload, emitted_at, deleted, deleted_at
      FROM current_records
      WHERE connection_id = ? AND stream = ?
    `
      )
      .all(connectionId, stream)
    const snapshotRows = this.#db
      .prepare(
        `
      SELECT version, record_key, payload, emitted_at, deleted, deleted_at
      FROM record_changes
      WHERE connection_id = ? AND stream = ? AND version <= ?
      ORDER BY version ASC
    `
      )
      .all(connectionId, stream, session.horizonVersion)
    const latestBeforeHorizon = new Map()
    for (const row of snapshotRows) latestBeforeHorizon.set(row.record_key, row)
    for (const row of currentRows) {
      if (row.version <= session.horizonVersion)
        latestBeforeHorizon.set(row.record_key, row)
    }
    return [...latestBeforeHorizon.values()].filter(
      row => row.deleted === 0 && row.version > session.afterVersion
    )
  }

  #latestChangesInWindow(connectionId, stream, session) {
    const rows = this.#db
      .prepare(
        `
      SELECT version, record_key, payload, emitted_at, deleted, deleted_at
      FROM record_changes
      WHERE connection_id = ? AND stream = ? AND version > ? AND version <= ?
      ORDER BY version ASC
    `
      )
      .all(connectionId, stream, session.sinceVersion, session.horizonVersion)
    const latestByKey = new Map()
    for (const row of rows) latestByKey.set(row.record_key, row)
    return [...latestByKey.values()].filter(
      row => row.version > session.afterVersion
    )
  }

  #discloseChange(change, connectionId, stream, sinceVersion, grant) {
    const before = this.#snapshotAt(
      connectionId,
      stream,
      change.record_key,
      sinceVersion
    )
    const beforeRecord = before ? discloseSnapshot(before, stream, grant) : null
    const afterRecord = change.deleted
      ? null
      : discloseSnapshot(change, stream, grant)
    if (sameDisclosedData(beforeRecord, afterRecord)) return null
    if (afterRecord) return { ...afterRecord, version: change.version }
    if (!beforeRecord) return null
    return {
      object: "record",
      id: change.record_key,
      stream,
      deleted: true,
      deleted_at: change.deleted_at,
      emitted_at: change.emitted_at,
      version: change.version,
    }
  }

  #snapshotAt(connectionId, stream, key, version) {
    return (
      this.#db
        .prepare(
          `
      SELECT record_key, payload, emitted_at, deleted, deleted_at
      FROM record_changes
      WHERE connection_id = ? AND stream = ? AND record_key = ? AND version <= ?
      ORDER BY version DESC LIMIT 1
    `
        )
        .get(connectionId, stream, key, version) ?? null
    )
  }
}

function validateLiveRecord({ connectionId, stream, key, data, emittedAt }) {
  validateLocation({ connectionId, stream, key })
  if (!isPlainObject(data))
    throw new RecordsRepositoryError(
      "invalid_record",
      "Record data must be an object"
    )
  const metadata = requireStream(stream)
  for (const field of metadata.requiredFields) {
    if (typeof data[field] !== "string" || data[field].length === 0) {
      throw new RecordsRepositoryError(
        "invalid_record",
        `Stream '${stream}' requires non-empty '${field}'`
      )
    }
  }
  if (data.id !== key) {
    throw new RecordsRepositoryError(
      "invalid_record_identity",
      "Record key must equal data.id"
    )
  }
  if (!isIsoTimestamp(data[metadata.consentTimeField])) {
    throw new RecordsRepositoryError(
      "invalid_record",
      `Stream '${stream}' requires a valid '${metadata.consentTimeField}' timestamp`
    )
  }
  if (
    data[metadata.cursorField] != null &&
    !isIsoTimestamp(data[metadata.cursorField])
  ) {
    throw new RecordsRepositoryError(
      "invalid_record",
      `Stream '${stream}' has an invalid '${metadata.cursorField}' timestamp`
    )
  }
  if (!isIsoTimestamp(emittedAt)) {
    throw new RecordsRepositoryError(
      "invalid_record",
      "emittedAt must be a valid ISO-8601 timestamp"
    )
  }
  return { connectionId, stream, key, data, emittedAt }
}

function validateDelete({ connectionId, stream, key, emittedAt }) {
  validateLocation({ connectionId, stream, key })
  if (!isIsoTimestamp(emittedAt)) {
    throw new RecordsRepositoryError(
      "invalid_record",
      "emittedAt must be a valid ISO-8601 timestamp"
    )
  }
  return { connectionId, stream, key, emittedAt }
}

/**
 * Legacy exports carry no snapshot metadata and therefore retain the
 * historical merge-only behavior. A reset is opt-in, fully described, and
 * only accepted with an explicit completed-at timestamp for durable deletes.
 */
function validateSnapshotMetadata(snapshot, recordsByStream) {
  if (snapshot === undefined) {
    return { resetStreams: [], completedAt: null }
  }
  if (!isPlainObject(snapshot)) {
    throw new RecordsRepositoryError(
      "invalid_snapshot",
      "snapshot metadata must be an object"
    )
  }
  const mode = snapshot.collection_mode
  if (mode !== "full_refresh" && mode !== "incremental") {
    throw new RecordsRepositoryError(
      "invalid_snapshot",
      "snapshot.collection_mode must be full_refresh or incremental"
    )
  }
  const resetStreams = snapshot.reset_streams
  if (
    !Array.isArray(resetStreams) ||
    resetStreams.some(
      stream => typeof stream !== "string" || stream.length === 0
    ) ||
    new Set(resetStreams).size !== resetStreams.length
  ) {
    throw new RecordsRepositoryError(
      "invalid_snapshot",
      "snapshot.reset_streams must be unique non-empty stream names"
    )
  }
  if (mode === "incremental" && resetStreams.length > 0) {
    throw new RecordsRepositoryError(
      "invalid_snapshot",
      "incremental snapshots cannot reset streams"
    )
  }
  for (const stream of resetStreams) {
    requireStream(stream)
    if (!Object.hasOwn(recordsByStream, stream)) {
      throw new RecordsRepositoryError(
        "invalid_snapshot",
        `Authoritative snapshot must include an array for reset stream '${stream}'`
      )
    }
  }
  if (resetStreams.length === 0) return { resetStreams, completedAt: null }
  if (!isIsoTimestamp(snapshot.completed_at)) {
    throw new RecordsRepositoryError(
      "invalid_snapshot",
      "snapshot.completed_at must be an ISO-8601 timestamp when resetting streams"
    )
  }
  return { resetStreams, completedAt: snapshot.completed_at }
}

function validateLocation({ connectionId, stream, key }) {
  requireNonEmptyString(connectionId, "connectionId")
  requireStream(stream)
  if (key !== undefined) requireNonEmptyString(key, "key")
}

function requireStream(stream) {
  const metadata = GITHUB_STREAMS[stream]
  if (!metadata)
    throw new RecordsRepositoryError(
      "invalid_record",
      `Unsupported GitHub stream '${String(stream)}'`
    )
  return metadata
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordsRepositoryError(
      "invalid_request",
      `${name} must be a non-empty string`
    )
  }
}

function normalizeGrant(stream, grant = {}, requestedFields) {
  if (!isPlainObject(grant))
    throw new RecordsRepositoryError(
      "invalid_request",
      "grant must be an object"
    )
  const metadata = requireStream(stream)
  const grantFields =
    grant.fields === undefined
      ? null
      : normalizeFields(stream, grant.fields, "grant.fields")
  const requestFields =
    requestedFields === undefined
      ? null
      : normalizeFields(stream, requestedFields, "fields")
  if (
    requestFields &&
    grantFields &&
    requestFields.some(
      field => !grantFields.includes(field) && !metadata.requiredFields.includes(field)
    )
  ) {
    throw new RecordsRepositoryError(
      "field_not_granted",
      "Requested fields exceed the grant"
    )
  }
  const selected = requestFields ?? grantFields
  const fields = selected
    ? [...new Set([...metadata.requiredFields, ...selected])]
    : null
  const resources =
    grant.resources === undefined
      ? null
      : normalizeStringList(grant.resources, "grant.resources")
  const timeRange = grant.timeRange ?? grant.time_range
  if (
    timeRange !== undefined &&
    (!isPlainObject(timeRange) ||
      (timeRange.since && !isIsoTimestamp(timeRange.since)) ||
      (timeRange.until && !isIsoTimestamp(timeRange.until)))
  ) {
    throw new RecordsRepositoryError(
      "invalid_request",
      "grant.timeRange must contain valid ISO-8601 timestamps"
    )
  }
  return { fields, resources, timeRange: timeRange ?? null }
}

function normalizeFields(stream, value, name) {
  const fields = normalizeStringList(value, name)
  const known = GITHUB_STREAMS[stream].fields
  if (fields.some(field => !known.includes(field))) {
    throw new RecordsRepositoryError(
      "unknown_field",
      `${name} includes an unknown field`
    )
  }
  return fields
}

function normalizeStringList(value, name) {
  if (
    !Array.isArray(value) ||
    value.some(item => typeof item !== "string" || item.length === 0)
  ) {
    throw new RecordsRepositoryError(
      "invalid_request",
      `${name} must be an array of non-empty strings`
    )
  }
  return value
}

function discloseLiveRow(row, stream, grant) {
  return discloseSnapshot({ ...row, deleted: 0 }, stream, grant)
}

function discloseSnapshot(row, stream, grant) {
  if (row.deleted) return null
  const data = JSON.parse(row.payload)
  const metadata = GITHUB_STREAMS[stream]
  if (grant.resources && !grant.resources.includes(data.id)) return null
  const time = data[metadata.consentTimeField]
  if (
    grant.timeRange?.since &&
    Date.parse(time) < Date.parse(grant.timeRange.since)
  )
    return null
  if (
    grant.timeRange?.until &&
    Date.parse(time) >= Date.parse(grant.timeRange.until)
  )
    return null
  const projected = grant.fields
    ? Object.fromEntries(
        Object.entries(data).filter(([field]) => grant.fields.includes(field))
      )
    : data
  return {
    object: "record",
    id: row.record_key,
    stream,
    data: projected,
    emitted_at: row.emitted_at,
  }
}

function matchesExactFilter(data, filter, stream, grantedFields) {
  if (filter === undefined) return true
  if (!isPlainObject(filter))
    throw new RecordsRepositoryError(
      "invalid_request",
      "filter must be an object"
    )
  return Object.entries(filter).every(([field, value]) => {
    if (!GITHUB_STREAMS[stream].fields.includes(field)) {
      throw new RecordsRepositoryError(
        "unknown_field",
        `Unknown filter field '${field}'`
      )
    }
    if (grantedFields && !grantedFields.includes(field)) {
      throw new RecordsRepositoryError(
        "field_not_granted",
        `Filter field '${field}' exceeds the grant`
      )
    }
    return data[field] === value
  })
}

function normalizeLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RecordsRepositoryError(
      "invalid_request",
      "limit must be a positive integer"
    )
  return Math.min(limit, MAX_LIMIT)
}

function normalizeOrder(order) {
  if (order !== "asc" && order !== "desc")
    throw new RecordsRepositoryError(
      "invalid_request",
      "order must be asc or desc"
    )
  return order
}

function compareCurrentRows(left, right, order) {
  const leftValue = left.cursorValue
  const rightValue = right.cursorValue
  const leftMissing = leftValue == null || leftValue === ""
  const rightMissing = rightValue == null || rightValue === ""
  let comparison
  if (leftMissing !== rightMissing) comparison = leftMissing ? 1 : -1
  else if (!leftMissing && leftValue !== rightValue)
    comparison = Date.parse(leftValue) < Date.parse(rightValue) ? -1 : 1
  else comparison = left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  return order === "asc" ? comparison : -comparison
}

function compareCurrentRowToCursor(row, cursor, order) {
  return compareCurrentRows(
    row,
    { key: cursor.key, cursorValue: cursor.cursorValue },
    order
  )
}

function encodeCurrentCursor(record, connectionId, stream, order) {
  return encodeOpaque({
    kind: "current",
    connectionId,
    stream,
    order,
    cursorValue: record.cursorValue,
    key: record.key,
  })
}

function decodeCurrentCursor(cursor, connectionId, stream, order) {
  const value = decodeOpaque(cursor, "invalid_cursor")
  if (
    value.kind !== "current" ||
    value.connectionId !== connectionId ||
    value.stream !== stream ||
    value.order !== order ||
    typeof value.key !== "string"
  ) {
    throw new RecordsRepositoryError(
      "invalid_cursor",
      "Cursor does not match this query"
    )
  }
  return value
}

function encodeChangesSince(version, connectionId, stream) {
  return encodeOpaque({ kind: "changes_since", version, connectionId, stream })
}

function decodeChangesSince(value, connectionId, stream) {
  if (value === "beginning") return { sinceVersion: 0, isBeginning: true }
  const cursor = decodeOpaque(value, "invalid_cursor")
  if (
    cursor.kind !== "changes_since" ||
    cursor.connectionId !== connectionId ||
    cursor.stream !== stream ||
    !Number.isInteger(cursor.version) ||
    cursor.version < 0
  ) {
    throw new RecordsRepositoryError(
      "invalid_cursor",
      "changes_since does not match this stream"
    )
  }
  return { sinceVersion: cursor.version, isBeginning: false }
}

function encodeChangesCursor(session, connectionId, stream) {
  return encodeOpaque({
    kind: "changes_page",
    connectionId,
    stream,
    ...session,
  })
}

function decodeChangesCursor(cursor, connectionId, stream) {
  const value = decodeOpaque(cursor, "invalid_cursor")
  if (
    value.kind !== "changes_page" ||
    value.connectionId !== connectionId ||
    value.stream !== stream ||
    !["bootstrap", "changes"].includes(value.mode) ||
    ![value.sinceVersion, value.afterVersion, value.horizonVersion].every(
      part => Number.isInteger(part) && part >= 0
    )
  ) {
    throw new RecordsRepositoryError(
      "invalid_cursor",
      "Cursor does not match this changes session"
    )
  }
  return value
}

function encodeOpaque(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function decodeOpaque(value, code) {
  if (typeof value !== "string" || value.length === 0)
    throw new RecordsRepositoryError(code, "Cursor is required")
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (!isPlainObject(parsed)) throw new Error("not an object")
    return parsed
  } catch {
    throw new RecordsRepositoryError(code, "Malformed cursor")
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value))
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortJson(value[key])])
  )
}

function sameDisclosedData(before, after) {
  if (before === null && after === null) return true
  if (before === null || after === null) return false
  return canonicalJson(before.data) === canonicalJson(after.data)
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

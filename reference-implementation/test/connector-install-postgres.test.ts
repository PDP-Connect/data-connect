// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector install on Postgres over a connector that already has data.
 *
 * Incident (v0.7.62, 2026-10-17): installing gmail over an instance migrated
 * with its connections and records activated the connector, but the request
 * never returned. The install held the file lock and an idle-in-transaction
 * lifecycle advisory lock while `registerConnector` re-derived every existing
 * record, one transaction per record. Every later install failed as busy.
 */

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { registerConnector } from "../server/auth.ts"
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createConnectorInstallStore,
} from "../server/connector-install/index.ts"
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts"
import { withConnectorLifecycleLock } from "../server/connector-lifecycle-lock.ts"
import { closeDb, initDb } from "../server/db.ts"
import { __setPostgresRecordSortBackfillPhaseHookForTest } from "../server/postgres-records.ts"
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from "../server/postgres-storage.ts"
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts"

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL
const CONNECTOR_ID = "gmail"
const INSTANCES = ["cin_gmail_primary", "cin_gmail_work"] as const
const RECORDS_PER_STREAM = 40
const digest = `sha256:${"a".repeat(64)}`
const configDigest = `sha256:${"b".repeat(64)}`
// `withConnectorLifecycleLock` key for gmail, as two 32-bit halves in pg_locks.
const GMAIL_LIFECYCLE_LOCK = { classid: 1_636_929_005, objid: 1_056_513_344 }

const shippedGmail = JSON.parse(
  readFileSync(new URL("./fixtures/collection-profiles/gmail.json", import.meta.url), "utf8")
) as Record<string, unknown>

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>(settle => {
    resolve = settle
  })
  return { promise, resolve }
}

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${String(ms)} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function withPostgres(name: string, body: () => Promise<void>): Promise<void> {
  assert.ok(POSTGRES_URL)
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: `pdpp_test_install_${name}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,
      templateName: null,
    },
    async databaseUrl => {
      initDb(":memory:")
      try {
        await initPostgresStorage({ backend: "postgres", databaseUrl })
        await body()
      } finally {
        await closePostgresStorage()
        closeDb()
      }
    }
  )
}

/** gmail as a migrated instance has it: registered, two connections, records whose derived columns predate the manifest. */
async function seedMigratedGmail(): Promise<void> {
  await registerConnector(shippedGmail, { backfillRetrievalIndexes: false })
  const now = new Date().toISOString()
  for (const connectorInstanceId of INSTANCES) {
    await postgresQuery(
      `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name,
         source_kind, source_binding_key, created_at, updated_at)
       VALUES($1, 'owner', $2, 'Gmail', 'account', $1, $3, $3)`,
      [connectorInstanceId, CONNECTOR_ID, now]
    )
    for (const stream of ["messages", "message_bodies"]) {
      const values: string[] = []
      const params: unknown[] = []
      for (let index = 0; index < RECORDS_PER_STREAM; index += 1) {
        const id = `${stream}-${String(index).padStart(4, "0")}`
        const receivedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
        const data =
          stream === "messages"
            ? { id, received_at: receivedAt, snippet: `snippet ${id}`, subject: `subject ${id}` }
            : { body_text: `body ${id}`, id, message_received_at: receivedAt }
        const base = values.length * 5
        values.push(`($1, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 4})`)
        params.push(connectorInstanceId, stream, id, JSON.stringify(data), receivedAt)
      }
      // Every row shares $1, the connector id.
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, primary_key_text)
         VALUES ${values.join(", ")}`,
        [CONNECTOR_ID, ...params]
      )
    }
  }
}

function gmailInstallService(
  dataDir: string,
  hooks: { readonly onRepair?: (repair: Promise<unknown>) => void; readonly stage?: Promise<void> } = {}
) {
  const entry: ConnectorCatalogEntry = {
    bindings: {},
    config_digest: configDigest,
    connector_id: CONNECTOR_ID,
    connector_key: CONNECTOR_ID,
    digest,
    latest: true,
    version: "9.0.0",
  }
  return createConnectorInstallService({
    catalogLoader: async () => [entry],
    dataDir,
    installArtifact: async root => {
      await hooks.stage
      mkdirSync(join(root, "profile"), { recursive: true })
      mkdirSync(join(root, "dist"), { recursive: true })
      writeFileSync(
        join(root, "profile", "collection-profile.json"),
        JSON.stringify({ ...shippedGmail, version: "9.0.0" })
      )
      writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n")
      writeFileSync(join(root, "provenance.json"), "{}\n")
    },
    registerManifest: installedConnectorManifestRegistration.registerManifest,
    repairManifestDerivedState: manifest => {
      const repair = installedConnectorManifestRegistration.repairManifestDerivedState(manifest)
      hooks.onRepair?.(repair)
      return repair
    },
    store: createConnectorInstallStore(),
  })
}

async function gmailLifecycleLockHolders(): Promise<number> {
  const result = await postgresQuery<{ holders: string }>(
    `SELECT count(*)::text AS holders FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 1`,
    [GMAIL_LIFECYCLE_LOCK.classid, GMAIL_LIFECYCLE_LOCK.objid]
  )
  return Number(result.rows[0]?.holders ?? 0)
}

test(
  "PostgreSQL: installing over a connector with existing records returns before the O(records) repair and holds no lock during it",
  { skip: !POSTGRES_URL },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"))
    const repairEntered = deferred()
    const repairRelease = deferred()
    let repair: Promise<unknown> | undefined
    try {
      await withPostgres("repair", async () => {
        await seedMigratedGmail()
        __setPostgresRecordSortBackfillPhaseHookForTest(async point => {
          if (point === "before-instance-fence") {
            repairEntered.resolve()
            await repairRelease.promise
          }
        })
        try {
          const service = gmailInstallService(dataDir, {
            onRepair: started => {
              repair = started
            },
          })
          const installed = await within(service.install(CONNECTOR_ID, digest), 5000, "gmail install")
          assert.equal(installed.digest, digest)
          await within(repairEntered.promise, 5000, "derived repair start")

          // The repair is running, and neither lock is held.
          assert.equal(existsSync(join(dataDir, ".connector-install.lock")), false)
          assert.equal(await gmailLifecycleLockHolders(), 0)
          assert.equal(
            await within(
              withConnectorLifecycleLock(dataDir, CONNECTOR_ID, async () => "free"),
              2000,
              "lifecycle lock"
            ),
            "free"
          )

          repairRelease.resolve()
          await within(Promise.resolve(repair), 10_000, "derived repair")
          const stale = await postgresQuery<{ stale: string }>(
            `SELECT count(*)::text AS stale FROM records
              WHERE connector_id = $1 AND stream = 'messages' AND cursor_value IS DISTINCT FROM record_json->>'received_at'`,
            [CONNECTOR_ID]
          )
          assert.equal(stale.rows[0]?.stale, "0", "the deferred repair still re-derives existing records")
        } finally {
          repairRelease.resolve()
          await Promise.resolve(repair).catch(() => undefined)
          __setPostgresRecordSortBackfillPhaseHookForTest(null)
        }
      })
    } finally {
      rmSync(dataDir, { force: true, recursive: true })
    }
  }
)

test(
  "PostgreSQL: same-process lifecycle waiters cannot exhaust the pool the install holder needs",
  { skip: !POSTGRES_URL },
  async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pdpp-install-pg-"))
    const stage = deferred()
    const waiters: Promise<unknown>[] = []
    let repair: Promise<unknown> | undefined
    try {
      await withPostgres("pool", async () => {
        await seedMigratedGmail()
        const service = gmailInstallService(dataDir, {
          onRepair: started => {
            repair = started
          },
          stage: stage.promise,
        })
        const installing = service.install(CONNECTOR_ID, digest)
        // The install now holds the gmail lifecycle lock and waits on its artifact.
        for (let attempt = 0; attempt < 200 && (await gmailLifecycleLockHolders()) === 0; attempt += 1) {
          await new Promise(settle => setTimeout(settle, 10))
        }
        assert.equal(await gmailLifecycleLockHolders(), 1)
        // More waiters than the interactive pool has connections (8): scheduler
        // ticks, run starts and connection upserts for the same connector.
        for (let index = 0; index < 8; index += 1) {
          waiters.push(withConnectorLifecycleLock(dataDir, CONNECTOR_ID, async () => index))
        }
        await new Promise(settle => setTimeout(settle, 200))
        stage.resolve()
        assert.equal((await within(installing, 5000, "gmail install")).digest, digest)
        assert.deepEqual(await within(Promise.all(waiters), 5000, "lifecycle waiters"), [0, 1, 2, 3, 4, 5, 6, 7])
        await within(Promise.resolve(repair), 30_000, "derived repair")
      })
    } finally {
      stage.resolve()
      rmSync(dataDir, { force: true, recursive: true })
    }
  }
)

test(
  "PostgreSQL: terminating the backend of an open transaction fails that transaction without crashing the process",
  { skip: !POSTGRES_URL },
  async () => {
    await withPostgres("terminate", async () => {
      const holding = deferred()
      const terminated = deferred()
      let holdingPid = 0
      const transaction = withPostgresTransaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(424242)")
        const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        holdingPid = backend.rows[0]?.pid ?? 0
        holding.resolve()
        // Idle in transaction, as the install's lifecycle lock was.
        await terminated.promise
        await client.query("SELECT 1")
      })
      await holding.promise
      await postgresQuery("SELECT pg_terminate_backend($1)", [holdingPid])
      await new Promise(settle => setTimeout(settle, 200))
      terminated.resolve()
      // Before the fix, the client's unhandled `error` event crashed the process here.
      await assert.rejects(transaction)
      assert.equal((await postgresQuery<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok, 1)
    })
  }
)

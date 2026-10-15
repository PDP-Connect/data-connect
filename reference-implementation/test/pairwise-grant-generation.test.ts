// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  backfillTrustedClientSectorMembership,
  completePairwiseIdentityLegacyBackfill,
  getPairwiseHandle,
  getPairwiseV1Handle,
  initializePairwiseIdentityRootKey,
  lookupPairwiseInstanceMapping,
  migratePairwiseIdentityIssuer,
  type PairwiseHandleInput,
  PairwiseIdentityContextError,
  PairwiseIdentityDeploymentError,
  projectPairwiseGrant,
  recordTrustedClientSectorMembership,
} from "../server/pairwise-identity.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { TEST_DATABASE_SENTINEL_SCHEMA } from "../server/postgres-test-database-guard.ts";
import { SqliteDriver } from "../server/sqlite-driver.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const ISSUER = "https://as.example";
const SECTOR = "https://sector.example/applications.json";
const OTHER_SECTOR = "https://other.example/sector.json";
const SCHEME_KEY = ["issuer", "subject_id", "client_id", "kind", "source_id", "internal_id", "scheme"];
const PRECHANGE_KEY = SCHEME_KEY.slice(0, 6);
const READ_STATEMENT = /^\s*(SELECT|PRAGMA|WITH)\b/i;
const ROOT_KEY_FAILURE = /root key/i;
const SUBJECT_HANDLE = /^sub_v1_[A-Za-z0-9_-]{43}$/;

// Frozen pre-change shapes. Real old databases carry these tables; the
// current bootstrap must upgrade them in place without changing any handle.
const PRECHANGE_TABLE = `CREATE TABLE pairwise_identity_handles (
  issuer TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('subject','grantor','instance')),
  source_id TEXT NOT NULL,
  internal_id TEXT NOT NULL,
  client_sector TEXT,
  scheme TEXT NOT NULL DEFAULT 'legacy' CHECK (scheme IN ('legacy','v1')),
  handle TEXT NOT NULL UNIQUE,
  PRIMARY KEY (issuer,subject_id,client_id,kind,source_id,internal_id)
)`;
const PRECHANGE_SQLITE_INDEX = `CREATE UNIQUE INDEX idx_pairwise_identity_handles_v1_scope
  ON pairwise_identity_handles(issuer, client_sector, kind, subject_id, internal_id)
  WHERE scheme = 'v1'`;
const PRECHANGE_PG_INDEX = `CREATE UNIQUE INDEX idx_pg_pairwise_identity_handles_v1_scope
  ON pairwise_identity_handles(issuer, client_sector, kind, subject_id, internal_id)
  WHERE scheme = 'v1'`;

type Row = Record<string, unknown>;
interface RawSqlite {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Row[];
    run: (...params: unknown[]) => unknown;
  };
}
type LegacyRow = [string, string, string, string, string, string];

// [subject_id, client_id, kind, source_id, internal_id, handle]
const CLIENT_A_LEGACY: LegacyRow[] = [
  ["person-4", "client-a", "subject", "", "person-4", "sub_disclosed_legacy"],
  ["person-4", "client-a", "grantor", "", "person-9", "sub_disclosed_grantor"],
  ["person-4", "client-a", "instance", "source-primary", "cin-17", "inst_disclosed_legacy"],
  ["person-4", "client-a", "instance", "", "cin-18", "inst_disclosed_sourceless"],
];

interface Harness {
  readonly backend: "sqlite" | "postgres";
  /** Takes the backend's stopped backup and points the harness at the restored copy. */
  backupAndRestore: () => Promise<void>;
  close: () => Promise<void>;
  init: () => Promise<void>;
  /** Runs storage init in another process. */
  initInChild: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<Row[]>;
  /** Raw statement against the database file or URL before storage init. */
  raw: (sql: string, params?: unknown[]) => Promise<Row[]>;
}

function toPostgresParams(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => {
    index += 1;
    return `$${index}`;
  });
}

function isRead(sql: string): boolean {
  return READ_STATEMENT.test(sql);
}

function runChild(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`child storage init exited ${code}: ${output}`))
    );
  });
}

async function withSqlite(run: (h: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-pairwise-generation-"));
  let path = join(directory, "identities.sqlite");
  const harness: Harness = {
    backend: "sqlite",
    backupAndRestore() {
      const backupPath = join(directory, "backup.sqlite");
      getDb().prepare("VACUUM INTO ?").run(backupPath);
      closeDb();
      path = backupPath;
      initDb(path);
      return Promise.resolve();
    },
    close() {
      closeDb();
      return Promise.resolve();
    },
    // biome-ignore lint/suspicious/useAwait: Convert synchronous startup failures to rejections for both backends.
    async init() {
      initDb(path);
    },
    initInChild() {
      return runChild(
        `import { closeDb, initDb } from './server/db.ts';
				 initDb(process.env.PAIRWISE_GENERATION_SQLITE_PATH);
				 closeDb();`,
        { PAIRWISE_GENERATION_SQLITE_PATH: path }
      );
    },
    query(sql, params = []) {
      const statement = getDb().prepare(sql);
      if (isRead(sql)) {
        return Promise.resolve(statement.all<Row>(...params));
      }
      statement.run(...params);
      return Promise.resolve([]);
    },
    raw(sql, params = []) {
      const db = new SqliteDriver(path, {
        timeout: 5000,
      }) as unknown as RawSqlite;
      try {
        if (isRead(sql)) {
          return Promise.resolve(db.prepare(sql).all(...params));
        }
        if (params.length) {
          db.prepare(sql).run(...params);
        } else {
          db.exec(sql);
        }
        return Promise.resolve([]);
      } finally {
        db.close();
      }
    },
  };
  try {
    await run(harness);
  } finally {
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
}

let postgresCounter = 0;
function postgresDatabaseName(): string {
  postgresCounter += 1;
  return `pdpp_pairwise_gen_${process.pid}_${postgresCounter}`;
}

async function withPostgres(run: (h: Harness) => Promise<void>): Promise<void> {
  const connectionString = POSTGRES_URL as string;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString,
      databaseName: postgresDatabaseName(),
      templateName: null,
    },
    (sourceUrl) =>
      withTemporaryPostgresDatabase(
        {
          closeConnections: closePostgresStorage,
          connectionString,
          databaseName: postgresDatabaseName(),
          templateName: null,
        },
        async (restoreUrl) => {
          let databaseUrl = sourceUrl;
          const harness: Harness = {
            backend: "postgres",
            async backupAndRestore() {
              await closePostgresStorage();
              const dump = execFileSync(
                "pg_dump",
                ["--no-owner", "--no-privileges", `--exclude-schema=${TEST_DATABASE_SENTINEL_SCHEMA}`, sourceUrl],
                { encoding: "utf8" }
              );
              execFileSync("psql", [
                restoreUrl,
                "-q",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
              ]);
              execFileSync("psql", [restoreUrl, "-q", "-v", "ON_ERROR_STOP=1"], {
                input: dump,
                stdio: ["pipe", "ignore", "inherit"],
              });
              databaseUrl = restoreUrl;
              await initPostgresStorage({ backend: "postgres", databaseUrl });
            },
            close: closePostgresStorage,
            async init() {
              await initPostgresStorage({ backend: "postgres", databaseUrl });
            },
            initInChild() {
              return runChild(
                `import { closePostgresStorage, initPostgresStorage } from './server/postgres-storage.ts';
								 await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PAIRWISE_GENERATION_PG_URL });
								 await closePostgresStorage();`,
                { PAIRWISE_GENERATION_PG_URL: databaseUrl }
              );
            },
            async query(sql, params = []) {
              return (await postgresQuery<Row>(toPostgresParams(sql), params)).rows;
            },
            async raw(sql, params = []) {
              const pool = new Pool({ connectionString: databaseUrl });
              try {
                return (await pool.query(toPostgresParams(sql), params)).rows;
              } finally {
                await pool.end();
              }
            },
          };
          try {
            await run(harness);
          } finally {
            await closePostgresStorage();
          }
        }
      )
  );
}

function backendTest(name: string, scenario: (h: Harness) => Promise<void>): void {
  test(`${name} (SQLite)`, () => withSqlite(scenario));
  test(`${name} (PostgreSQL)`, { skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset" }, () =>
    withPostgres(scenario)
  );
}

function hmacHandle(parts: string[], prefix: "sub" | "inst"): string {
  const digest = createHmac("sha256", TEST_KEY)
    .update(JSON.stringify(["pdpp-pairwise", "v1", ...parts]))
    .digest("base64url");
  return `${prefix}_v1_${digest}`;
}

function personHandle(sector: string, personId: string): string {
  return hmacHandle(["person", ISSUER, sector, personId], "sub");
}

function expectedInstanceHandle(sector: string, subjectId: string, internalId: string): string {
  return hmacHandle(["instance", ISSUER, sector, subjectId, internalId], "inst");
}

function subjectInput(clientId: string, sector = SECTOR): PairwiseHandleInput {
  return {
    clientId,
    clientSector: sector,
    internalId: "person-4",
    issuer: ISSUER,
    kind: "subject",
    subjectId: "person-4",
  };
}

function instanceInput(clientId: string, internalId: string, sourceId: string, sector = SECTOR): PairwiseHandleInput {
  return {
    clientId,
    clientSector: sector,
    internalId,
    issuer: ISSUER,
    kind: "instance",
    sourceId,
    subjectId: "person-4",
  };
}

async function insertLegacyRows(
  write: (sql: string, params: unknown[]) => Promise<unknown>,
  rows: LegacyRow[]
): Promise<void> {
  for (const row of rows) {
    // biome-ignore lint/performance/noAwaitInLoops: Preserve deterministic insertion order across both storage drivers.
    await write(
      `INSERT INTO pairwise_identity_handles
			  (issuer,subject_id,client_id,kind,source_id,internal_id,handle)
			 VALUES (?,?,?,?,?,?,?)`,
      [ISSUER, ...row]
    );
  }
}

async function provisionKey(h: Harness): Promise<void> {
  await initializePairwiseIdentityRootKey(ISSUER);
  await h.query("UPDATE pairwise_identity_root_keys SET root_key_hex=? WHERE issuer=?", [
    TEST_KEY.toString("hex"),
    ISSUER,
  ]);
}

/** Old client-a rows plus trusted memberships for two same-sector clients and one other-sector client. */
async function seedMixedClients(): Promise<void> {
  await recordTrustedClientSectorMembership({
    clientId: "client-a",
    clientSector: SECTOR,
    issuer: ISSUER,
  });
  await completePairwiseIdentityLegacyBackfill(ISSUER);
  await recordTrustedClientSectorMembership({
    clientId: "client-b",
    clientSector: SECTOR,
    issuer: ISSUER,
  });
  await recordTrustedClientSectorMembership({
    clientId: "client-c",
    clientSector: OTHER_SECTOR,
    issuer: ISSUER,
  });
}

function allRows(h: Harness, scheme: "legacy" | "v1"): Promise<Row[]> {
  return h.query(
    `SELECT issuer,subject_id,client_id,kind,source_id,internal_id,client_sector,scheme,handle
		   FROM pairwise_identity_handles WHERE scheme=? ORDER BY handle`,
    [scheme]
  );
}

async function primaryKey(h: Harness, raw = false): Promise<string[]> {
  const run = raw ? h.raw.bind(h) : h.query.bind(h);
  const rows =
    h.backend === "sqlite"
      ? await run("SELECT name FROM pragma_table_info('pairwise_identity_handles') WHERE pk > 0 ORDER BY pk")
      : await run(
          `SELECT a.attname AS name
					   FROM pg_constraint c
					   CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
					   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
					  WHERE c.conrelid = 'pairwise_identity_handles'::regclass AND c.contype = 'p'
					  ORDER BY k.position`
        );
  return rows.map((row) => String(row.name));
}

/** Catalog shape plus the table's physical storage identity, which a rebuild or rewrite changes. */
function schemaState(h: Harness): Promise<Row[]> {
  if (h.backend === "sqlite") {
    return h.query(
      `SELECT type,name,sql,rootpage FROM sqlite_master
			  WHERE tbl_name='pairwise_identity_handles' ORDER BY name`
    );
  }
  return h.query(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS sql, NULL AS storage
		   FROM pg_constraint WHERE conrelid='pairwise_identity_handles'::regclass
		 UNION ALL
		 SELECT indexname, indexdef, NULL FROM pg_indexes
		  WHERE schemaname=current_schema() AND tablename='pairwise_identity_handles'
		 UNION ALL
		 SELECT 'table', NULL, relfilenode::text FROM pg_class
		  WHERE oid='pairwise_identity_handles'::regclass
		 ORDER BY 1`
  );
}

/**
 * Catalog shape only: a restored database has new physical storage, and
 * SQLite keeps the literal CREATE text, whose layout and identifier quoting
 * differ after a rebuild and rename.
 */
async function logicalSchema(h: Harness): Promise<Row[]> {
  return (await schemaState(h)).map(({ rootpage: _rootpage, storage: _storage, sql, ...rest }) => ({
    ...rest,
    sql:
      typeof sql === "string"
        ? sql.replaceAll('"', "").replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")")
        : sql,
  }));
}

async function issueV1(): Promise<Record<string, string>> {
  return {
    grantorA: await getPairwiseV1Handle({
      ...subjectInput("client-a"),
      kind: "grantor",
      subjectId: "person-7",
    }),
    instanceA: await getPairwiseV1Handle(instanceInput("client-a", "cin-17", "source-primary")),
    instanceAliasA: await getPairwiseV1Handle(instanceInput("client-a", "cin-17", "source-alias")),
    instanceB: await getPairwiseV1Handle(instanceInput("client-b", "cin-17", "source-primary")),
    instanceC: await getPairwiseV1Handle(instanceInput("client-c", "cin-17", "source-primary", OTHER_SECTOR)),
    sourcelessA: await getPairwiseV1Handle(instanceInput("client-a", "cin-18", "source-primary")),
    subjectA: await getPairwiseV1Handle(subjectInput("client-a")),
    subjectB: await getPairwiseV1Handle(subjectInput("client-b")),
    subjectC: await getPairwiseV1Handle(subjectInput("client-c", OTHER_SECTOR)),
  };
}

const EXPECTED_V1 = {
  grantorA: personHandle(SECTOR, "person-4"),
  instanceA: expectedInstanceHandle(SECTOR, "person-4", "cin-17"),
  instanceAliasA: expectedInstanceHandle(SECTOR, "person-4", "cin-17"),
  instanceB: expectedInstanceHandle(SECTOR, "person-4", "cin-17"),
  instanceC: expectedInstanceHandle(OTHER_SECTOR, "person-4", "cin-17"),
  sourcelessA: expectedInstanceHandle(SECTOR, "person-4", "cin-18"),
  subjectA: personHandle(SECTOR, "person-4"),
  subjectB: personHandle(SECTOR, "person-4"),
  subjectC: personHandle(OTHER_SECTOR, "person-4"),
};

function expectedV1Rows(): Row[] {
  const row = (
    clientId: string,
    sector: string,
    kind: string,
    subjectId: string,
    internalId: string,
    handle: string
  ) => ({
    client_id: clientId,
    client_sector: sector,
    handle,
    internal_id: internalId,
    issuer: ISSUER,
    kind,
    scheme: "v1",
    source_id: "",
    subject_id: subjectId,
  });
  return [
    row("client-a", SECTOR, "subject", "person-4", "person-4", EXPECTED_V1.subjectA),
    row("client-a", SECTOR, "instance", "person-4", "cin-17", EXPECTED_V1.instanceA),
    row("client-a", SECTOR, "instance", "person-4", "cin-18", EXPECTED_V1.sourcelessA),
    row("client-c", OTHER_SECTOR, "subject", "person-4", "person-4", EXPECTED_V1.subjectC),
    row("client-c", OTHER_SECTOR, "instance", "person-4", "cin-17", EXPECTED_V1.instanceC),
  ].sort((left, right) => left.handle.localeCompare(right.handle));
}

async function lookups(): Promise<Record<string, unknown>> {
  const lookup = (clientId: string, sector: string, instanceHandle: string) =>
    lookupPairwiseInstanceMapping({
      clientId,
      clientSector: sector,
      instanceHandle,
      issuer: ISSUER,
      subjectId: "person-4",
    });
  return {
    crossSector: await lookup("client-c", OTHER_SECTOR, EXPECTED_V1.instanceA),
    legacyA: await lookup("client-a", SECTOR, "inst_disclosed_legacy"),
    v1A: await lookup("client-a", SECTOR, EXPECTED_V1.instanceA),
    v1B: await lookup("client-b", SECTOR, EXPECTED_V1.instanceA),
    v1C: await lookup("client-c", OTHER_SECTOR, EXPECTED_V1.instanceC),
  };
}

const EXPECTED_LOOKUPS = {
  crossSector: null,
  legacyA: null,
  v1A: { internalId: "cin-17", retainedSourceId: "" },
  v1B: { internalId: "cin-17", retainedSourceId: "" },
  v1C: { internalId: "cin-17", retainedSourceId: "" },
};

backendTest("new grant projection selects HMAC v1 beside stored legacy rows", async (h) => {
  await h.init();
  await provisionKey(h);
  await insertLegacyRows((sql, params) => h.query(sql, params), CLIENT_A_LEGACY);
  await seedMixedClients();
  const legacyBefore = await allRows(h, "legacy");
  const approvedOldGrant = {
    client: { client_id: "client-a" },
    grant_id: "old-approved-grant",
    grantors: [{ capacity: "https://example.test/capacity/legal-representative", id: "sub_disclosed_grantor" }],
    source: { id: "source-primary" },
    streams: [{ instance_ids: ["inst_disclosed_legacy", "inst_disclosed_sourceless"], name: "orders" }],
    subject: { id: "sub_disclosed_legacy" },
  };
  const oldBytes = JSON.stringify(approvedOldGrant);
  const input = {
    ...approvedOldGrant,
    grant_id: "new-approved-grant",
    grantors: [{ capacity: "https://example.test/capacity/legal-representative", id: "person-9" }],
    streams: [{ instance_ids: ["cin-17", "cin-18"], name: "orders" }],
    subject: { id: "person-4" },
  };
  const inputBytes = JSON.stringify(input);
  const expected = {
    ...input,
    grantors: [
      { capacity: "https://example.test/capacity/legal-representative", id: personHandle(SECTOR, "person-9") },
    ],
    streams: [
      {
        instance_ids: [
          expectedInstanceHandle(SECTOR, "person-4", "cin-17"),
          expectedInstanceHandle(SECTOR, "person-4", "cin-18"),
        ],
        name: "orders",
      },
    ],
    subject: { id: personHandle(SECTOR, "person-4") },
  };
  const context = { issuer: ISSUER, resolveClientSector: () => SECTOR };
  assert.deepEqual(await projectPairwiseGrant(input, "person-4", context), expected);
  assert.equal(JSON.stringify(input), inputBytes, "new input is not mutated");
  assert.equal(JSON.stringify(approvedOldGrant), oldBytes, "previously approved values are retained");
  assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  await h.close();
  await h.init();
  assert.deepEqual(await projectPairwiseGrant(input, "person-4", context), expected);
  assert.equal(JSON.stringify(approvedOldGrant), oldBytes);
  assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  assert.deepEqual(
    await lookupPairwiseInstanceMapping({
      ...instanceInput("client-a", "cin-17", "source-primary"),
      instanceHandle: expectedInstanceHandle(SECTOR, "person-4", "cin-17"),
    }),
    { internalId: "cin-17", retainedSourceId: "" }
  );
});

backendTest("fresh projections reject raw IDs across authenticated client sectors", async (h) => {
  await h.init();
  await provisionKey(h);
  await insertLegacyRows((sql, params) => h.query(sql, params), [
    ["person-4", "client-a", "subject", "", "person-4", "person-4"],
    ["person-4", "client-a", "instance", "source-primary", "cin-17", "cin-17"],
  ]);
  await seedMixedClients();

  const project = (clientId: string, sector: string) =>
    projectPairwiseGrant(
      {
        client: { client_id: clientId },
        source: { id: "source-primary" },
        streams: [{ instance_ids: ["cin-17"], name: "orders" }],
        subject: { id: "person-4" },
      },
      "person-4",
      { issuer: ISSUER, resolveClientSector: () => sector }
    );
  const projectedA = await project("client-a", SECTOR);
  const projectedC = await project("client-c", OTHER_SECTOR);
  const lookup = (clientId: string, sector: string, instanceHandle: string) =>
    lookupPairwiseInstanceMapping({
      clientId,
      clientSector: sector,
      instanceHandle,
      issuer: ISSUER,
      subjectId: "person-4",
    });
  const handleA = projectedA.streams[0]?.instance_ids?.[0] as string;
  const handleC = projectedC.streams[0]?.instance_ids?.[0] as string;

  assert.match(projectedA.subject.id, SUBJECT_HANDLE);
  assert.match(projectedC.subject.id, SUBJECT_HANDLE);
  assert.notEqual(projectedA.subject.id, "person-4");
  assert.notEqual(projectedC.subject.id, "person-4");
  assert.notEqual(projectedA.subject.id, projectedC.subject.id);
  assert.equal(await lookup("client-a", SECTOR, "cin-17"), null);
  assert.equal(await lookup("client-c", OTHER_SECTOR, "cin-17"), null);
  assert.equal(await lookup("client-c", OTHER_SECTOR, handleA), null);
  assert.deepEqual(await lookup("client-a", SECTOR, handleA), {
    internalId: "cin-17",
    retainedSourceId: "",
  });
  assert.deepEqual(await lookup("client-c", OTHER_SECTOR, handleC), {
    internalId: "cin-17",
    retainedSourceId: "",
  });
});

backendTest(
  "default issuance is HMAC-only beside unchanged legacy mappings across restart",
  async (h) => {
    await h.init();
    await provisionKey(h);
    await insertLegacyRows((sql, params) => h.query(sql, params), CLIENT_A_LEGACY);
    await seedMixedClients();
    const legacyBefore = await allRows(h, "legacy");
    const schemaBefore = await schemaState(h);

    assert.equal(await getPairwiseHandle(subjectInput("client-a")), EXPECTED_V1.subjectA);
    assert.equal(
      await getPairwiseHandle(instanceInput("client-a", "cin-17", "source-primary")),
      EXPECTED_V1.instanceA
    );
    assert.deepEqual(
      (await allRows(h, "v1")).map((row) => row.handle),
      [EXPECTED_V1.instanceA, EXPECTED_V1.subjectA].sort()
    );

    assert.deepEqual(await issueV1(), EXPECTED_V1);
    assert.notEqual(EXPECTED_V1.subjectA, EXPECTED_V1.subjectC);
    assert.deepEqual(await lookups(), EXPECTED_LOOKUPS);
    assert.deepEqual(await allRows(h, "v1"), expectedV1Rows());
    assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
    assert.equal(await getPairwiseHandle(subjectInput("client-a")), EXPECTED_V1.subjectA);
    assert.deepEqual(await schemaState(h), schemaBefore);

    await h.close();
    await h.init();
    assert.deepEqual(await schemaState(h), schemaBefore);
    assert.deepEqual(await issueV1(), EXPECTED_V1);
    assert.deepEqual(await lookups(), EXPECTED_LOOKUPS);
    assert.deepEqual(await allRows(h, "v1"), expectedV1Rows());
    assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  }
);

backendTest("ambiguous legacy aliases do not affect default HMAC issuance or lookup", async (h) => {
  await h.init();
  await provisionKey(h);
  const write = (sql: string, params: unknown[]) => h.query(sql, params);
  await insertLegacyRows(write, [
    ["person-4", "old-a", "instance", "source-a", "cin-amb", "inst_amb_a"],
    ["person-4", "old-b", "instance", "source-b", "cin-amb", "inst_amb_b"],
  ]);
  for (const clientId of ["old-a", "old-b"]) {
    // biome-ignore lint/performance/noAwaitInLoops: Enroll trusted members sequentially before the backfill barrier.
    await backfillTrustedClientSectorMembership({
      clientId,
      clientSector: SECTOR,
      issuer: ISSUER,
    });
  }
  await completePairwiseIdentityLegacyBackfill(ISSUER);
  const legacyBefore = await allRows(h, "legacy");
  const input = instanceInput("old-a", "cin-amb", "source-a");

  assert.equal(
    await getPairwiseHandle(input),
    expectedInstanceHandle(SECTOR, "person-4", "cin-amb")
  );
  const issued = await getPairwiseV1Handle(input);
  assert.equal(issued, expectedInstanceHandle(SECTOR, "person-4", "cin-amb"));
  assert.equal(await getPairwiseV1Handle(instanceInput("old-b", "cin-amb", "source-b")), issued);
  const reverse = (clientId: string, clientSector: string, instanceHandle: string) =>
    lookupPairwiseInstanceMapping({ clientId, clientSector, instanceHandle, issuer: ISSUER, subjectId: "person-4" });
  const expected = { internalId: "cin-amb", retainedSourceId: "" };
  assert.deepEqual(await reverse("old-a", SECTOR, issued), expected);
  assert.deepEqual(await reverse("old-b", SECTOR, issued), expected);
  assert.equal(await reverse("old-a", SECTOR, "inst_amb_a"), null);
  assert.equal(await reverse("old-b", SECTOR, "inst_amb_b"), null);
  await recordTrustedClientSectorMembership({ clientId: "other-sector", clientSector: OTHER_SECTOR, issuer: ISSUER });
  assert.equal(await reverse("other-sector", OTHER_SECTOR, issued), null);
  assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  assert.deepEqual(
    (await allRows(h, "v1")).map((row) => row.handle),
    [issued]
  );
});

backendTest("explicit v1 issuance fails closed without trusted context or a valid root key", async (h) => {
  await h.init();
  await provisionKey(h);
  await insertLegacyRows((sql, params) => h.query(sql, params), CLIENT_A_LEGACY);
  await seedMixedClients();
  const legacyBefore = await allRows(h, "legacy");

  await assert.rejects(getPairwiseV1Handle(subjectInput("client-unknown")), PairwiseIdentityContextError);
  await assert.rejects(getPairwiseV1Handle(subjectInput("client-a", OTHER_SECTOR)), PairwiseIdentityContextError);
  await assert.rejects(
    getPairwiseV1Handle({
      ...subjectInput("client-a"),
      issuer: "https://other-as.example",
    }),
    PairwiseIdentityDeploymentError
  );
  await assert.rejects(
    getPairwiseV1Handle({ ...subjectInput("client-a"), internalId: "" }),
    PairwiseIdentityContextError
  );
  assert.deepEqual(await allRows(h, "v1"), []);

  const issued = await getPairwiseV1Handle(subjectInput("client-a"));
  await h.query("UPDATE pairwise_identity_root_keys SET root_key_hex=? WHERE issuer=?", ["not-a-key", ISSUER]);
  await assert.rejects(getPairwiseV1Handle(subjectInput("client-a")), ROOT_KEY_FAILURE);
  await assert.rejects(getPairwiseV1Handle(instanceInput("client-a", "cin-17", "source-primary")), ROOT_KEY_FAILURE);
  await h.query("DELETE FROM pairwise_identity_root_keys WHERE issuer=?", [ISSUER]);
  await assert.rejects(getPairwiseV1Handle(subjectInput("client-a")), ROOT_KEY_FAILURE);
  await assert.rejects(getPairwiseV1Handle(instanceInput("client-a", "cin-17", "source-primary")), ROOT_KEY_FAILURE);
  assert.deepEqual(
    (await allRows(h, "v1")).map((row) => row.handle),
    [issued]
  );
  assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
});

backendTest(
  "bootstrap upgrades the pre-change primary key in place and keeps both generations across restarts",
  async (h) => {
    await h.raw(PRECHANGE_TABLE);
    await h.raw(h.backend === "sqlite" ? PRECHANGE_SQLITE_INDEX : PRECHANGE_PG_INDEX);
    await insertLegacyRows((sql, params) => h.raw(sql, params), CLIENT_A_LEGACY);
    assert.deepEqual(await primaryKey(h, true), PRECHANGE_KEY);
    const legacyBefore = await h.raw(
      `SELECT issuer,subject_id,client_id,kind,source_id,internal_id,client_sector,scheme,handle
			   FROM pairwise_identity_handles ORDER BY handle`
    );

    await h.init();
    assert.deepEqual(await primaryKey(h), SCHEME_KEY);
    assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
    await provisionKey(h);
    await seedMixedClients();
    assert.deepEqual(await issueV1(), EXPECTED_V1);
    assert.deepEqual(await allRows(h, "v1"), expectedV1Rows());
    assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
    const upgradedSchema = await schemaState(h);

    await h.close();
    await h.init();
    assert.deepEqual(await schemaState(h), upgradedSchema);
    assert.deepEqual(await issueV1(), EXPECTED_V1);
    assert.deepEqual(await lookups(), EXPECTED_LOOKUPS);
    assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  }
);

/** Rewrites a bootstrapped database's identity table to the pre-change key while storage is closed. */
async function downgradeToPrechangeKey(h: Harness): Promise<void> {
  if (h.backend === "sqlite") {
    await h.raw("DROP TABLE pairwise_identity_handles");
    await h.raw(PRECHANGE_TABLE);
    await h.raw(PRECHANGE_SQLITE_INDEX);
  } else {
    await h.raw(
      `ALTER TABLE pairwise_identity_handles
			   DROP CONSTRAINT pairwise_identity_handles_pkey,
			   ADD CONSTRAINT pairwise_identity_handles_pkey
			     PRIMARY KEY (issuer,subject_id,client_id,kind,source_id,internal_id)`
    );
  }
  assert.deepEqual(await primaryKey(h, true), PRECHANGE_KEY);
}

backendTest("upgraded and freshly bootstrapped identity tables have the same shape", async (h) => {
  await h.init();
  const fresh = await logicalSchema(h);
  assert.deepEqual(await primaryKey(h), SCHEME_KEY);
  await h.close();
  await downgradeToPrechangeKey(h);
  await h.init();
  assert.deepEqual(await logicalSchema(h), fresh);
});

backendTest("concurrent bootstraps of a pre-change identity table migrate once without losing rows", async (h) => {
  // Bootstrap everything else first so the child starters race only on
  // the identity-table key change.
  await h.init();
  await h.close();
  await downgradeToPrechangeKey(h);
  await insertLegacyRows((sql, params) => h.raw(sql, params), CLIENT_A_LEGACY);
  const legacyBefore = await h.raw(
    `SELECT issuer,subject_id,client_id,kind,source_id,internal_id,client_sector,scheme,handle
			   FROM pairwise_identity_handles ORDER BY handle`
  );
  await Promise.all([h.initInChild(), h.initInChild(), h.initInChild()]);
  assert.deepEqual(await primaryKey(h, true), SCHEME_KEY);
  await h.init();
  assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  await provisionKey(h);
  await seedMixedClients();
  assert.deepEqual(await issueV1(), EXPECTED_V1);
});

backendTest("a failed primary-key upgrade rolls back and leaves the pre-change table usable for retry", async (h) => {
  if (h.backend === "sqlite") {
    // A red-stage table without the kind CHECK holds a row the current
    // table rejects, so the copy fails after the rebuild has started.
    await h.raw(`CREATE TABLE pairwise_identity_handles (
			  issuer TEXT NOT NULL, subject_id TEXT NOT NULL, client_id TEXT NOT NULL,
			  kind TEXT NOT NULL, source_id TEXT NOT NULL, internal_id TEXT NOT NULL,
			  handle TEXT NOT NULL UNIQUE,
			  PRIMARY KEY (issuer,subject_id,client_id,kind,source_id,internal_id)
			)`);
    await insertLegacyRows(
      (sql, params) => h.raw(sql, params),
      [...CLIENT_A_LEGACY, ["person-4", "client-a", "bogus", "", "x", "bogus_handle"]]
    );
  } else {
    // The old key has another name and its replacement name is taken,
    // so ADD CONSTRAINT fails after DROP CONSTRAINT has run.
    await h.raw(PRECHANGE_TABLE.replace("PRIMARY KEY", "CONSTRAINT pairwise_identity_handles_legacy_key PRIMARY KEY"));
    await h.raw("CREATE TABLE pairwise_identity_name_blocker (id INTEGER)");
    await h.raw("CREATE INDEX pairwise_identity_handles_pkey ON pairwise_identity_name_blocker(id)");
    await insertLegacyRows((sql, params) => h.raw(sql, params), CLIENT_A_LEGACY);
  }
  const snapshot = () =>
    h.raw(
      `SELECT issuer,subject_id,client_id,kind,source_id,internal_id,handle
				   FROM pairwise_identity_handles ORDER BY handle`
    );
  const before = await snapshot();

  await assert.rejects(h.init());
  await h.close();
  assert.deepEqual(await primaryKey(h, true), PRECHANGE_KEY);
  assert.deepEqual(await snapshot(), before);
  if (h.backend === "sqlite") {
    assert.deepEqual(
      await h.raw("SELECT name FROM sqlite_master WHERE name LIKE 'pairwise_identity_handles%' ORDER BY name"),
      [{ name: "pairwise_identity_handles" }]
    );
    await h.raw("DELETE FROM pairwise_identity_handles WHERE kind='bogus'");
  } else {
    // The whole bootstrap batch rolled back, not just the key change.
    assert.deepEqual(await h.raw("SELECT to_regclass('grants') AS grants"), [{ grants: null }]);
    await h.raw("DROP TABLE pairwise_identity_name_blocker");
  }

  await h.init();
  assert.deepEqual(await primaryKey(h), SCHEME_KEY);
  const kept = await h.query(
    `SELECT issuer,subject_id,client_id,kind,source_id,internal_id,handle
			   FROM pairwise_identity_handles ORDER BY handle`
  );
  assert.deepEqual(
    kept,
    before.filter((row) => row.kind !== "bogus")
  );
});

backendTest("a stopped backup of mixed legacy and v1 rows restores both generations", async (h) => {
  await h.raw(PRECHANGE_TABLE);
  await h.raw(h.backend === "sqlite" ? PRECHANGE_SQLITE_INDEX : PRECHANGE_PG_INDEX);
  await insertLegacyRows((sql, params) => h.raw(sql, params), CLIENT_A_LEGACY);
  await h.init();
  await provisionKey(h);
  await seedMixedClients();
  assert.deepEqual(await issueV1(), EXPECTED_V1);
  const legacyBefore = await allRows(h, "legacy");
  const v1Before = await allRows(h, "v1");
  const schemaBefore = await logicalSchema(h);

  await h.backupAndRestore();
  assert.deepEqual(await logicalSchema(h), schemaBefore);
  assert.deepEqual(await allRows(h, "legacy"), legacyBefore);
  assert.deepEqual(await allRows(h, "v1"), v1Before);
  assert.deepEqual(await issueV1(), EXPECTED_V1);
  assert.deepEqual(await lookups(), EXPECTED_LOOKUPS);
  assert.deepEqual(await allRows(h, "v1"), v1Before);
});

backendTest("issuer migration moves both generations without re-deriving disclosed handles", async (h) => {
  await h.init();
  await provisionKey(h);
  await insertLegacyRows((sql, params) => h.query(sql, params), CLIENT_A_LEGACY);
  await seedMixedClients();
  assert.deepEqual(await issueV1(), EXPECTED_V1);
  const project = (rows: Row[]) => rows.map(({ issuer: _issuer, ...rest }) => rest);
  const legacyBefore = project(await allRows(h, "legacy"));
  const v1Before = project(await allRows(h, "v1"));
  const movedIssuer = "https://published-as.example";

  await migratePairwiseIdentityIssuer({
    fromIssuer: ISSUER,
    toIssuer: movedIssuer,
  });
  const moved = await h.query("SELECT DISTINCT issuer FROM pairwise_identity_handles");
  assert.deepEqual(moved, [{ issuer: movedIssuer }]);
  assert.deepEqual(project(await allRows(h, "legacy")), legacyBefore);
  assert.deepEqual(project(await allRows(h, "v1")), v1Before);
  assert.equal(
    await getPairwiseV1Handle({
      ...subjectInput("client-a"),
      issuer: movedIssuer,
    }),
    EXPECTED_V1.subjectA
  );
  await assert.rejects(getPairwiseV1Handle(subjectInput("client-a")), PairwiseIdentityDeploymentError);
});

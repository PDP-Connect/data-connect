// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds, once per gate run, a Postgres TEMPLATE database carrying the fully
 * bootstrapped RI schema (all tables/indexes/migrations) and the test-sentinel
 * marker, so per-file/per-test database provisioning can `CREATE DATABASE ...
 * TEMPLATE <template>` -- a filesystem-level copy -- instead of re-running
 * ~2000 lines of DDL from scratch every time.
 *
 * Measured motivation (pdpp PR #278, ported here as-is): schema
 * bootstrap is ~85-90% of per-file Postgres provisioning cost, and none of it
 * is network round-trip count -- it is the fixed cost of building ~91 index
 * relations from scratch. `CREATE DATABASE ... TEMPLATE` copies the already-
 * built index files instead of rebuilding them.
 *
 * FAIL-CLOSED CONTRACT: a missing or unusable template must throw, never
 * silently fall back to `CREATE DATABASE` without a template. A silent
 * fallback would defeat the point of measuring speedup honestly (a run that
 * "looks the same" but quietly stopped using the fast path), and worse, it
 * would hide a broken template build behind normal-looking (slow) green runs.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { provisionTestDatabase } from "../server/postgres-test-database-guard.ts";

const { Client } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Digest of the source file that defines `bootstrapPostgresSchema` and every
 * migration function it runs. This is the reviewer-required P2 fix: the
 * template's usability was previously verified only by
 * `datistemplate`/`datallowconn` (does *a* template exist and accept no
 * connections), which says nothing about whether the SCHEMA/MIGRATION CODE
 * that built it is the same code this process would run today. A template
 * built by a stale worker process, or reused across a code change mid-run
 * some other way, could otherwise be silently treated as usable while
 * carrying an outdated migration set. Binding this digest into the
 * template's metadata row and re-checking it on every clone closes that gap:
 * a template built from different migration source now fails closed instead
 * of being trusted.
 */
async function currentPostgresStorageSourceDigest(): Promise<string> {
  const source = await readFile(join(__dirname, "..", "server", "postgres-storage.ts"), "utf8");
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Metadata lives on the fixed `postgres` admin database, NOT inside the
 * template database itself -- `ALLOW_CONNECTIONS false` (set once a template
 * is marked usable) blocks every connection to the template, including
 * superuser ones, so a metadata table stored there would be unreadable
 * exactly when callers need to read it (verified directly: a superuser
 * `psql` connect to a datallowconn=false database throws "is not currently
 * accepting connections", no exception for the owning role). Keyed by
 * template name so multiple runners' templates can coexist on one cluster.
 */
const TEMPLATE_METADATA_TABLE = "pdpp_test_template_metadata";

/**
 * Byte length of the per-run nonce that template names derive from.
 *
 * External review P1-2: this was 4 bytes (32 bits), which puts a same-name
 * collision inside the range a shared CI cluster reaches -- roughly 77k runs
 * for a 50% chance, by the birthday bound. Since a colliding name is exactly
 * the condition under which one run could inherit another's template, the
 * nonce is the whole separation guarantee and 16 bytes (128 bits) makes it
 * negligible.
 */
export const POSTGRES_TEST_RUNNER_NONCE_BYTES = 16;

/** What a completed template build publishes: its name and the identity it committed. */
export interface BuiltPostgresTestTemplate {
  identityDigest: string;
  templateName: string;
}

async function databaseExists(admin: InstanceType<typeof Client>, databaseName: string): Promise<boolean> {
  const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
  return rows.length > 0;
}

/**
 * Everything a clone call site verifies before trusting a template. Each
 * field is one of the four identity elements the P2 review asked to bind:
 *
 *   - `runnerId`            -- the run that built it (also encoded in the
 *                              template name; the two must agree)
 *   - `schemaVersion`       -- digest of the catalog (tables, columns,
 *                              indexes) the built template actually carries
 *   - `schemaSourceDigest`  -- digest of the `postgres-storage.ts` that
 *                              built it (must equal this process's own)
 *   - `builtAt`             -- creation instant, as the metadata table
 *                              returns it (`built_at::text`)
 *
 * `identityDigest` is a digest over all of the above plus the template
 * name. It is stored beside them so that altering any single field after
 * the build (a tampered or partially rewritten row) is detected even when
 * the altered field has no independent expectation at clone time, and it
 * is the token `scripts/run-tests.ts` hands each child so the child can
 * insist on the exact build its own run produced.
 */
export interface PostgresTestTemplateMetadata {
  builtAt: string;
  identityDigest: string;
  /**
   * OID of the template database itself. Bound into the identity digest so a
   * drop-and-recreate that preserves the NAME is detected: PostgreSQL issues
   * a new OID for the new database, and the recomputed digest stops matching
   * (external review P2).
   */
  templateOid: string;
  runnerId: string;
  schemaSourceDigest: string;
  schemaVersion: string;
}

async function ensureTemplateMetadataTable(admin: InstanceType<typeof Client>): Promise<void> {
  await admin.query(
    `CREATE TABLE IF NOT EXISTS ${TEMPLATE_METADATA_TABLE} (
       template_name text PRIMARY KEY,
       runner_id text NOT NULL,
       schema_source_digest text NOT NULL,
       built_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  // Rows written by the earlier three-column builder have NULL here and are
  // refused by the identity check below (they carry no schema version and
  // no identity digest), which is the correct outcome for a template built
  // by older code.
  await admin.query(
    `ALTER TABLE ${TEMPLATE_METADATA_TABLE}
       ADD COLUMN IF NOT EXISTS schema_version text,
       ADD COLUMN IF NOT EXISTS identity_digest text,
       ADD COLUMN IF NOT EXISTS template_oid text`
  );
}

function templateIdentityDigest(
  templateName: string,
  metadata: Omit<PostgresTestTemplateMetadata, "identityDigest">
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        templateName,
        metadata.runnerId,
        metadata.schemaVersion,
        metadata.schemaSourceDigest,
        metadata.builtAt,
        metadata.templateOid,
      ])
    )
    .digest("hex");
}

/**
 * Digest of the schema a database actually carries: every column of every
 * table and every index definition in `public`, in catalog order. Computed
 * on the template while it still accepts connections (before
 * `ALLOW_CONNECTIONS false`) and recorded as its `schema_version`.
 */
export async function computePostgresSchemaCatalogDigest(connectionString: string): Promise<string> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows: columns } = await client.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`
    );
    const { rows: indexes } = await client.query(
      `SELECT tablename, indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname`
    );
    return createHash("sha256").update(JSON.stringify({ columns, indexes })).digest("hex");
  } finally {
    await client.end();
  }
}

/**
 * Write the metadata row and return the identity it published.
 *
 * The identity is computed BEFORE the row is written, from values this
 * builder chose, and is then inserted in the same statement as those values.
 * That ordering is the point (external review P1-2): an identity derived by
 * reading a row back cannot distinguish the row this run just wrote from one
 * that was already there. `builtAt` is therefore supplied by the caller as a
 * fixed ISO string rather than left to the server's `now()`, so the digest
 * can be committed up front and still cover the stored timestamp exactly.
 */
async function writeTemplateMetadata(
  admin: InstanceType<typeof Client>,
  templateName: string,
  metadata: {
    builtAt: string;
    runnerId: string;
    schemaSourceDigest: string;
    schemaVersion: string;
    templateOid: string;
  }
): Promise<string> {
  await ensureTemplateMetadataTable(admin);
  // The digest must cover `built_at` exactly as the table will later RENDER
  // it (`built_at::text`), which is not the ISO-8601 form we hand in. Ask the
  // server to render our chosen instant first, so the value hashed here and
  // the value read at clone time are byte-identical -- without ever letting
  // the row itself decide what the identity is.
  const { rows: renderedRows } = await admin.query<{ built_at: string }>(
    "SELECT ($1::timestamptz)::text AS built_at",
    [metadata.builtAt]
  );
  const builtAt = renderedRows[0]?.built_at;
  if (!builtAt) {
    throw new Error(`could not render build timestamp ${JSON.stringify(metadata.builtAt)} for template metadata`);
  }
  const identityDigest = templateIdentityDigest(templateName, { ...metadata, builtAt });
  await admin.query(
    `INSERT INTO ${TEMPLATE_METADATA_TABLE} (template_name, runner_id, schema_source_digest, schema_version, identity_digest, built_at, template_oid)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)`,
    [
      templateName,
      metadata.runnerId,
      metadata.schemaSourceDigest,
      metadata.schemaVersion,
      identityDigest,
      metadata.builtAt,
      metadata.templateOid,
    ]
  );
  // Read back only to CONFIRM the published row reproduces the precommitted
  // digest -- never to source it. If the server rendered `built_at`
  // differently from the string we hashed, fail loudly here rather than let
  // clone-time recomputation disagree later.
  const stored = await readTemplateMetadata(admin, templateName);
  if (!stored) {
    throw new Error(`template metadata row for "${templateName}" vanished between insert and read-back`);
  }
  if (templateIdentityDigest(templateName, stored) !== identityDigest) {
    throw new Error(
      `template metadata row for "${templateName}" does not reproduce the identity committed before publication (stored built_at ${JSON.stringify(stored.builtAt)} vs written ${JSON.stringify(metadata.builtAt)})`
    );
  }
  return identityDigest;
}

async function readTemplateMetadata(
  admin: InstanceType<typeof Client>,
  templateName: string
): Promise<PostgresTestTemplateMetadata | null> {
  await ensureTemplateMetadataTable(admin);
  const {
    rows: [row],
  } = await admin.query<{
    runner_id: string;
    schema_source_digest: string;
    schema_version: string | null;
    identity_digest: string | null;
    template_oid: string | null;
    built_at: string;
  }>(
    `SELECT runner_id, schema_source_digest, schema_version, identity_digest, template_oid, built_at::text AS built_at
       FROM ${TEMPLATE_METADATA_TABLE}
      WHERE template_name = $1`,
    [templateName]
  );
  if (!row) {
    return null;
  }
  return {
    builtAt: row.built_at,
    identityDigest: row.identity_digest ?? "",
    runnerId: row.runner_id,
    schemaSourceDigest: row.schema_source_digest,
    schemaVersion: row.schema_version ?? "",
    templateOid: row.template_oid ?? "",
  };
}

/**
 * Distinct advisory-lock key from `POSTGRES_BOOTSTRAP_SERIALIZATION_LOCK`
 * (postgres-storage.ts) -- that lock serializes concurrent bootstraps of ONE
 * already-selected database; this one serializes concurrent *template
 * builds* across parallel gate workers, taken on the admin ("postgres")
 * connection before any template database exists.
 */
const TEMPLATE_BUILD_SERIALIZATION_LOCK = [482_571, 151];

/**
 * Advisory lock held across the whole verify -> capture-OID -> clone
 * sequence, so two participants cannot interleave a template swap between
 * one another's check and copy (external review P2). Distinct from the build
 * lock: a clone must not block template construction, only other clones.
 */
export const TEMPLATE_CLONE_SERIALIZATION_LOCK = [482_571, 152];

function adminUrl(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const TEMPLATE_NAME_PREFIX = "pdpp_test_template_";

/** Derive the per-run template database name from the same runnerId used for per-file names, so concurrent runs on a shared cluster never collide. */
export function deriveDedicatedPostgresTemplateName(runnerId: string): string {
  return `${TEMPLATE_NAME_PREFIX}${runnerId}`;
}

function runnerIdFromTemplateName(templateName: string): string | null {
  return templateName.startsWith(TEMPLATE_NAME_PREFIX) ? templateName.slice(TEMPLATE_NAME_PREFIX.length) : null;
}

async function withAdminClient<T>(
  connectionString: string,
  fn: (client: InstanceType<typeof Client>) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: adminUrl(connectionString) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function templateIsUsable(client: InstanceType<typeof Client>, templateName: string): Promise<boolean> {
  const {
    rows: [row],
  } = await client.query<{ datistemplate: boolean; datallowconn: boolean }>(
    "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
    [templateName]
  );
  // A template mid-build (or left over from a crashed prior run) would not
  // yet have datistemplate=true set -- treat that as "not usable", not as
  // "usable but somehow wrong", so a stale half-built database is rebuilt
  // rather than trusted.
  return row?.datistemplate === true && row?.datallowconn === false;
}

/**
 * Identity check beyond `templateIsUsable`'s pg_database flags (P2 fix). A
 * clone call site that receives a template name via env var (a different
 * process than the one that built it) cannot otherwise tell a template
 * built by its own run from the current migration source apart from one
 * built by stale worker state, an unrelated prior run that reused a
 * colliding name, or a metadata row altered after the build. Every element
 * of `PostgresTestTemplateMetadata` is verified, and any single mismatch
 * refuses the template:
 *
 *   1. runner id in the row must equal the runner id the template name
 *      encodes;
 *   2. schema source digest must equal this process's own
 *      `postgres-storage.ts`;
 *   3. schema version and identity digest must be present (rows from the
 *      older builder have neither), and the identity digest must equal a
 *      recomputation over the row -- this is what catches an altered build
 *      time or schema version, which have no independent expectation here;
 *   4. when the caller was handed an identity token by the run that built
 *      the template, the row's identity digest must equal that token.
 */
async function templateIdentityMatches(
  admin: InstanceType<typeof Client>,
  templateName: string,
  expectedIdentity: string | undefined
): Promise<{ ok: true; metadata: PostgresTestTemplateMetadata } | { ok: false; reason: string }> {
  const metadata = await readTemplateMetadata(admin, templateName);
  if (!metadata) {
    return {
      ok: false,
      reason:
        "no metadata row found (template was not built by this codebase's own template builder, or its metadata row was lost)",
    };
  }
  const runnerIdFromName = runnerIdFromTemplateName(templateName);
  if (runnerIdFromName === null || metadata.runnerId !== runnerIdFromName) {
    return {
      ok: false,
      reason: `runner id mismatch: metadata row records runner ${JSON.stringify(metadata.runnerId)} but the template name encodes ${JSON.stringify(runnerIdFromName)} -- the row does not describe the run that built this template`,
    };
  }
  const expectedDigest = await currentPostgresStorageSourceDigest();
  if (metadata.schemaSourceDigest !== expectedDigest) {
    return {
      ok: false,
      reason: `schema source digest mismatch: template was built from postgres-storage.ts digest ${metadata.schemaSourceDigest.slice(0, 12)}..., this process's postgres-storage.ts digests to ${expectedDigest.slice(0, 12)}... -- the migration/bootstrap code has changed since this template was built`,
    };
  }
  if (!(metadata.schemaVersion && metadata.identityDigest)) {
    return {
      ok: false,
      reason:
        "metadata row carries no schema version or identity digest (template was built by an older template builder that did not bind them)",
    };
  }
  if (templateIdentityDigest(templateName, metadata) !== metadata.identityDigest) {
    return {
      ok: false,
      reason:
        "identity digest mismatch: the metadata row's runner id, schema version, source digest, or build time was altered after the template was built",
    };
  }
  if (expectedIdentity !== undefined && expectedIdentity !== metadata.identityDigest) {
    return {
      ok: false,
      reason: `identity token mismatch: this run expected template identity ${expectedIdentity.slice(0, 12)}... but the row records ${metadata.identityDigest.slice(0, 12)}... -- the template is not the build this run produced`,
    };
  }
  return { metadata, ok: true };
}

/**
 * Build (or verify) the per-run Postgres test template database. Idempotent
 * and safe under concurrent callers: callers race for
 * `TEMPLATE_BUILD_SERIALIZATION_LOCK` on the admin connection, the winner
 * builds, losers wait for the lock and then verify the winner's result
 * instead of rebuilding.
 *
 * Returns the template database name. Throws on any failure -- there is no
 * return value meaning "couldn't build a template, proceed without one";
 * callers that want that fallback must catch and decide explicitly, and this
 * harness's own call sites do not.
 */
export async function ensurePostgresTestTemplate(
  baseConnectionString: string,
  runnerId: string
): Promise<BuiltPostgresTestTemplate> {
  const templateName = deriveDedicatedPostgresTemplateName(runnerId);
  let identityDigest: string | null = null;

  await withAdminClient(baseConnectionString, async (admin) => {
    await admin.query("SELECT pg_advisory_lock($1, $2)", TEMPLATE_BUILD_SERIALIZATION_LOCK);
    try {
      // A database already occupying this run's name is an ERROR, never
      // something to adopt (external review P1-2). `runnerId` is a fresh
      // >=128-bit nonce, so nothing legitimate can already be here; whatever
      // is, this run did not build it, and anything this run later
      // "verifies" about it would be verifying a stranger's work.
      if (await databaseExists(admin, templateName)) {
        throw new Error(
          `Postgres test template "${templateName}" already exists before this run built it. The template name derives from a freshly generated ${POSTGRES_TEST_RUNNER_NONCE_BYTES}-byte run nonce, so a collision is not expected; refusing to adopt a template this run did not create rather than inheriting an unknown schema. Drop it if it is a leftover.`
        );
      }

      await admin.query(`CREATE DATABASE ${quotedIdentifier(templateName)}`);

      const templateUrl = databaseUrl(baseConnectionString, templateName);
      // Stamp the sentinel BEFORE bootstrapping schema, exactly like every
      // other scratch-database creation path in this harness --
      // provisionTestDatabase refuses to stamp a database holding real data,
      // and the database is provably empty one statement after CREATE
      // DATABASE, so this ordering is honest.
      await provisionTestDatabase(templateUrl);
      // Run the REAL, unmodified initPostgresStorage -- the exact chokepoint
      // every Postgres-backed test file already goes through today (guard
      // check + bootstrapPostgresSchema). This is the one-time cost the
      // template amortizes; every later clone skips it entirely.
      await initPostgresStorage({ backend: "postgres", databaseUrl: templateUrl });
      // initPostgresStorage leaves the process-global pool pointed at the
      // template. Close it so the template build does not leak a live
      // pool/connection into the caller, which would also hold
      // datallowconn=false hostage (ALTER DATABASE ... datallowconn fails
      // while the pool's own connections are still open against it).
      await closePostgresStorage();

      // Record the schema the template actually carries while it still
      // accepts connections; once ALLOW_CONNECTIONS is false nothing can
      // read its catalog again.
      const schemaVersion = await computePostgresSchemaCatalogDigest(templateUrl);

      await admin.query(
        `ALTER DATABASE ${quotedIdentifier(templateName)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
      );

      if (!(await templateIsUsable(admin, templateName))) {
        throw new Error(
          `Postgres test template build for "${templateName}" completed but the database is not marked as a usable template afterward (datistemplate/datallowconn check failed). Refusing to let callers clone from it.`
        );
      }

      // Write metadata AFTER the template is confirmed usable (marked +
      // verified), so a metadata row's presence always implies a real,
      // successfully-built template stands behind it -- never the reverse
      // ordering, which could leave a metadata row pointing at a template
      // build that failed partway through marking.
      const builtOid = await templateOid(admin, templateName);
      if (builtOid === null) {
        throw new Error(`Postgres test template "${templateName}" vanished immediately after being built`);
      }
      identityDigest = await writeTemplateMetadata(admin, templateName, {
        builtAt: new Date().toISOString(),
        templateOid: builtOid,
        runnerId,
        schemaSourceDigest: await currentPostgresStorageSourceDigest(),
        schemaVersion,
      });
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1, $2)", TEMPLATE_BUILD_SERIALIZATION_LOCK);
    }
  });

  if (identityDigest === null) {
    throw new Error(`Postgres test template "${templateName}" build completed without publishing an identity`);
  }
  return { identityDigest, templateName };
}

/**
 * Verify a named template database is present and usable. Used by clone call
 * sites that received a template name via env var from a different process
 * (the child test process did not build the template itself, so it cannot
 * assume the name it was handed is still good) -- throws loudly rather than
 * cloning from, or silently skipping, a template that turns out to be gone.
 */
export async function assertPostgresTestTemplateUsable(
  baseConnectionString: string,
  templateName: string,
  { expectedIdentity }: { expectedIdentity?: string | undefined } = {}
): Promise<PostgresTestTemplateMetadata> {
  return await withAdminClient(baseConnectionString, async (admin) => {
    const verified = await verifyTemplateOnConnection(admin, templateName, expectedIdentity);
    return verified.metadata;
  });
}

/**
 * Verify a template using an ALREADY-OPEN admin connection, returning both
 * its metadata and the OID of the database that was actually verified.
 *
 * Taking the connection as a parameter is the point (external review P2):
 * the caller can hold one connection across verification and the subsequent
 * `CREATE DATABASE ... TEMPLATE`, instead of checking on a connection that is
 * closed before the clone runs. The OID comes back so the caller can prove,
 * immediately before cloning, that the name still refers to the same
 * database it verified.
 */
async function verifyTemplateOnConnection(
  admin: InstanceType<typeof Client>,
  templateName: string,
  expectedIdentity: string | undefined
): Promise<{ metadata: PostgresTestTemplateMetadata; oid: string }> {
  if (!(await templateIsUsable(admin, templateName))) {
    throw new Error(
      `Postgres test template "${templateName}" is missing or not usable (expected datistemplate=true, datallowconn=false). Refusing to fall back to a from-scratch bootstrap silently -- if the template was supposed to exist, this is the bug; if templating is not wanted, unset PDPP_TEST_POSTGRES_TEMPLATE instead.`
    );
  }
  const identity = await templateIdentityMatches(admin, templateName, expectedIdentity);
  if (!identity.ok) {
    throw new Error(
      `Postgres test template "${templateName}" failed identity verification: ${identity.reason}. Refusing to clone from a template that cannot be proven to be the one this run built from this process's own migration code -- a stale, foreign, or altered template could otherwise mask a real migration defect.`
    );
  }
  const oid = await templateOid(admin, templateName);
  if (oid === null) {
    throw new Error(`Postgres test template "${templateName}" disappeared during verification`);
  }
  // The identity binds the OID the template had when it was built. If the
  // name now resolves to a different database, this run is looking at
  // something it did not build -- a drop-and-recreate under the same name
  // (external review P2). Nothing else in the row would reveal that.
  if (identity.metadata.templateOid !== oid) {
    throw new Error(
      `Postgres test template "${templateName}" failed identity verification: the name now refers to a different database (metadata records oid ${JSON.stringify(identity.metadata.templateOid)}, the live template has oid ${oid}) -- it was dropped and recreated under the same name since this run built it.`
    );
  }
  return { metadata: identity.metadata, oid };
}

async function templateOid(admin: InstanceType<typeof Client>, templateName: string): Promise<string | null> {
  const { rows } = await admin.query<{ oid: string }>("SELECT oid::text AS oid FROM pg_database WHERE datname = $1", [
    templateName,
  ]);
  return rows[0]?.oid ?? null;
}

/**
 * Clone a per-file runner database only after proving the template is the
 * exact build this runner created. Keeping the check and clone together
 * prevents a runner call site from accidentally issuing a raw TEMPLATE clone
 * that bypasses the identity boundary.
 */
export async function clonePostgresTestDatabaseFromTemplate(
  baseConnectionString: string,
  databaseName: string,
  templateName: string,
  expectedIdentity: string
): Promise<void> {
  await withAdminClient(baseConnectionString, async (admin) => {
    // ONE connection, ONE lock, across verify -> capture OID -> clone
    // (external review P2). Previously the verification ran on a second,
    // independently opened connection that was already closed by the time
    // CREATE DATABASE ran here, so nothing tied what was checked to what was
    // copied.
    await admin.query("SELECT pg_advisory_lock($1, $2)", TEMPLATE_CLONE_SERIALIZATION_LOCK);
    try {
      const verified = await verifyTemplateOnConnection(admin, templateName, expectedIdentity);
      // Re-read the OID immediately before the clone. The lock keeps other
      // participants in this protocol out, but a drop-and-recreate from
      // anything that does not take the lock would otherwise be invisible:
      // the name still resolves, so only the OID reveals that it now points
      // at a different database than the one just verified.
      const oidAtCloneTime = await templateOid(admin, templateName);
      if (oidAtCloneTime !== verified.oid) {
        throw new Error(
          `Postgres test template "${templateName}" is no longer the database that was verified (oid ${verified.oid} at verification, ${oidAtCloneTime ?? "absent"} at clone time). Refusing to clone: the template was replaced between the check and the copy.`
        );
      }
      await admin.query(`CREATE DATABASE ${quotedIdentifier(databaseName)} TEMPLATE ${quotedIdentifier(templateName)}`);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1, $2)", TEMPLATE_CLONE_SERIALIZATION_LOCK);
    }
  });
}

/**
 * The identity token of a template this process just built (or verified).
 * `scripts/run-tests.ts` passes it to every child as
 * PDPP_TEST_POSTGRES_TEMPLATE_IDENTITY so the child's clone-time check can
 * insist on exactly this build rather than any template of the same name.
 */
export async function readPostgresTestTemplateIdentity(
  baseConnectionString: string,
  templateName: string
): Promise<string> {
  const metadata = await assertPostgresTestTemplateUsable(baseConnectionString, templateName);
  return metadata.identityDigest;
}

/** Drop the per-run template database and its metadata row. Best-effort: called during gate teardown, after which nothing else needs the template. */
export async function dropPostgresTestTemplate(baseConnectionString: string, templateName: string): Promise<void> {
  await withAdminClient(baseConnectionString, async (admin) => {
    // A template must have IS_TEMPLATE cleared before it can be dropped.
    await admin.query(`ALTER DATABASE ${quotedIdentifier(templateName)} WITH IS_TEMPLATE false`).catch(() => {
      // Best-effort: if this fails the DROP below will surface a clearer error.
    });
    await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(templateName)} WITH (FORCE)`);
    // Best-effort: an orphaned metadata row for a dropped template is inert
    // (readTemplateMetadata's caller always checks templateIsUsable's
    // pg_database flags first, which fail immediately once the database is
    // gone), but dropping it keeps the shared admin table from accumulating
    // rows for every runner that has ever passed through this cluster.
    await admin.query(`DELETE FROM ${TEMPLATE_METADATA_TABLE} WHERE template_name = $1`, [templateName]).catch(() => {
      // Best-effort: the metadata table may not exist yet on a fresh cluster.
    });
  });
}

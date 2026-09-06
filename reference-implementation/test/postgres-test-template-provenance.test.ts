// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * External review P1-2: the template's identity was ADOPTED from whatever
 * database already sat under the expected name, rather than being decided by
 * the run that built it.
 *
 * Three things combined to make that unsafe:
 *
 *   1. The run nonce was `randomBytes(4)` -- 32 bits. Template names are
 *      derived from it, so name collision across concurrent or repeated runs
 *      on one cluster is a birthday problem at ~77k runs, not a negligible
 *      one.
 *   2. `ensurePostgresTestTemplate` returned early when a database under the
 *      derived name was already `datistemplate=true, datallowconn=false`.
 *      It did not check that THIS run built it.
 *   3. It returned only the template NAME, so the caller learned the
 *      expected identity by reading the candidate back
 *      (`readPostgresTestTemplateIdentity`). The value being verified was
 *      therefore sourced from the thing under verification -- circular. A
 *      pre-existing template's own digest simply became the expectation.
 *
 * Together these mean a stale or foreign same-name template could be adopted
 * whole, and every later clone would "verify" successfully against it.
 *
 * The repair: a >=128-bit nonce; a pre-existing template under a fresh
 * nonce's name is an ERROR rather than a reuse; the expected identity is
 * computed and committed BEFORE the template is published; and
 * `ensurePostgresTestTemplate` returns the identity it wrote so no caller
 * ever needs to re-read the candidate to learn what to expect.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  deriveDedicatedPostgresTemplateName,
  ensurePostgresTestTemplate,
  POSTGRES_TEST_RUNNER_NONCE_BYTES,
} from "../scripts/postgres-test-template.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const { Client } = pg;

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const POSTGRES_SKIP = POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset or non-dedicated";

function adminUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = "/postgres";
  return url.toString();
}

async function withAdmin<T>(base: string, fn: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrlFor(base) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function dropTemplate(base: string, templateName: string): Promise<void> {
  await withAdmin(base, async (admin) => {
    await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE false`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    await admin
      .query("DELETE FROM pdpp_test_template_metadata WHERE template_name = $1", [templateName])
      .catch(() => undefined);
  });
}

test("run nonce is at least 128 bits", () => {
  // A 32-bit nonce (randomBytes(4)) puts same-name collisions inside the
  // range a busy CI cluster actually reaches. Names derived from the nonce
  // are the only thing separating one run's template from another's.
  assert.ok(
    POSTGRES_TEST_RUNNER_NONCE_BYTES >= 16,
    `run nonce must be >=16 bytes (128 bits) to make same-name template collision negligible; got ${POSTGRES_TEST_RUNNER_NONCE_BYTES}`
  );
});

test("REFUSES to adopt a pre-existing template sitting under this run's name", { skip: POSTGRES_SKIP }, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = randomBytes(POSTGRES_TEST_RUNNER_NONCE_BYTES).toString("hex");
  const templateName = deriveDedicatedPostgresTemplateName(runnerId);

  // Stand up a database that LOOKS like a finished template under exactly
  // the name this run's fresh nonce derives -- the shape a stale leftover or
  // a foreign process's template would have.
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${templateName}"`);
    await admin.query(`ALTER DATABASE "${templateName}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
  });

  try {
    await assert.rejects(
      () => ensurePostgresTestTemplate(baseUrl, runnerId),
      /already exists/i,
      "a database already occupying this run's freshly-generated template name must be an error, not something to adopt: this run did not build it, so nothing it later verifies about it means anything"
    );
  } finally {
    await dropTemplate(baseUrl, templateName);
  }
});

test("returns the identity it wrote, without re-reading the candidate", { skip: POSTGRES_SKIP }, async () => {
  const baseUrl = POSTGRES_URL as string;
  const runnerId = randomBytes(POSTGRES_TEST_RUNNER_NONCE_BYTES).toString("hex");

  const built = await ensurePostgresTestTemplate(baseUrl, runnerId);
  try {
    // The builder must hand back the identity as part of its own return
    // value. If callers have to read it back off the candidate database,
    // the expectation is sourced from the thing being verified.
    assert.equal(
      typeof built.identityDigest,
      "string",
      "ensurePostgresTestTemplate must return the identity it wrote, so no caller re-reads the candidate to learn what to expect"
    );
    assert.match(built.identityDigest, /^[0-9a-f]{64}$/, "identity digest should be a sha256 hex digest");
    assert.equal(built.templateName, deriveDedicatedPostgresTemplateName(runnerId));

    // And that precommitted value must be the one actually published.
    const stored = await withAdmin(baseUrl, async (admin) => {
      const { rows } = await admin.query<{ identity_digest: string }>(
        "SELECT identity_digest FROM pdpp_test_template_metadata WHERE template_name = $1",
        [built.templateName]
      );
      return rows[0]?.identity_digest;
    });
    assert.equal(
      stored,
      built.identityDigest,
      "the identity committed before publication must equal the identity stored on the published template"
    );
  } finally {
    await dropTemplate(baseUrl, built.templateName);
  }
});

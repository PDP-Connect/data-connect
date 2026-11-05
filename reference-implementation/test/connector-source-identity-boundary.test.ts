// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector source identity at the registration boundary.
 *
 * A connector's Core source identity is the `source.id` of the SourceDeclaration
 * the runtime retains for its connector key. Resolution order, on both write
 * paths (`registerConnector` and the installer's `publishConnectorActivation`):
 *
 *   1. a retained declaration keeps its `source.id`; provenance cannot change it;
 *   2. otherwise an explicit declaration is validated and used;
 *   3. otherwise a first-party key takes the reviewed legacy source identity from
 *      the runtime-owned map (connector-legacy-source-map.ts), independent of the
 *      incoming provenance (`manifest_uri`) and alias (`connector_id`);
 *   4. otherwise the registration is refused before any write.
 *
 * Covers both write paths.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { executeAsPolyfillConnectorRegister } from "../operations/as-polyfill-connector-register/index.ts";
import {
  __setRegisterConnectorPhaseHookForTest,
  connectorDeclarationDigest,
  getAcceptedDeclarationDigest,
  getConnectorManifest,
  normalizeConnectorManifestForStorage,
  registerConnector,
} from "../server/auth.ts";
import {
  getConnectorActivation,
  publishConnectorActivation,
} from "../server/connector-install/activation-authority.ts";
import type { ConnectorInstallRecord } from "../server/connector-install/index.ts";
import {
  LEGACY_FIRST_PARTY_ENTRIES,
  LEGACY_FIRST_PARTY_KEYS,
  legacyFirstPartySourceIdFor,
} from "../server/connector-legacy-source-map.ts";
import { validateConnectorManifest } from "../server/connector-manifest-validation.ts";
import { closeDb, initDb } from "../server/db.ts";
import { readPolyfillManifests } from "../server/polyfill-connectors-runtime.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest } from "../server/source-declaration-legacy-collection.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const PUBLISHER = "https://publishers.example/accepted";
const DOC_ONE = "https://docs.example/manifests/one.json";
const DOC_TWO = "https://docs.example/manifests/two.json";
const EXPLICIT_SOURCE = "https://sources.example/explicit/identity-boundary";
const OTHER_SOURCE = "https://sources.example/other/identity-boundary";

const INVALID_REQUEST = "invalid_request";
const ALREADY_BOUND = /already bound to source/;
const CANONICAL_KEY_MESSAGE = /canonical key/;
const INVALID_SOURCE_DECLARATION = /Invalid SourceDeclaration/;
const KEY_MATCH_MESSAGE = /connector_id must match connector_key/;
const NO_SOURCE_MESSAGE = /no source declaration/;
const URL_KEY_MESSAGE = /is a URL with no connector_key/;

/** The reviewed historical source identity of a shipped first-party connector. */
function firstPartySource(slug: string): string {
  return `https://registry.pdpp.dev/connectors/${slug}`;
}

function streamFor(name: string) {
  return {
    name,
    primary_key: ["id"],
    schema: {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    },
    selection: { fields: true, resources: true },
    semantics: "append_only",
  };
}

function legacyManifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    capabilities: { human_interaction: [] },
    display_name: "Identity boundary",
    protocol_version: "0.1.0",
    streams: [streamFor("items")],
    version: "1.0.0",
    ...overrides,
  };
}

/** A fully valid Core declaration, produced by the existing legacy projection. */
function explicitDeclaration(connectorKey: string, sourceId: string, streams = [streamFor("items")]) {
  return snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
    legacyManifest({
      connector_id: connectorKey,
      connector_key: connectorKey,
      streams,
    }),
    {
      connectorImplementationId: `https://implementations.example/connectors/${connectorKey}`,
      publisherId: PUBLISHER,
      sourceId,
    }
  );
}

function retainedSourceId(stored: Record<string, unknown> | null): string | undefined {
  const declaration = stored?.source_declaration as { source?: { id?: unknown } } | undefined;
  return typeof declaration?.source?.id === "string" ? declaration.source.id : undefined;
}

async function storedFor(connectorKey: string): Promise<Record<string, unknown> | null> {
  return ((await getConnectorManifest(connectorKey)) as Record<string, unknown> | null) ?? null;
}

async function assertRejectedWithoutWrite(
  connectorKey: string,
  attempt: () => Promise<unknown>,
  messagePattern: RegExp
): Promise<void> {
  await assert.rejects(attempt, (error: unknown) => {
    const err = error as { code?: unknown; message?: unknown };
    assert.equal(err.code, INVALID_REQUEST);
    assert.match(String(err.message), messagePattern);
    return true;
  });
  assert.equal(await storedFor(connectorKey), null, "a rejected registration must not persist a manifest");
}

const SCENARIOS: Array<{ name: string; run: () => Promise<void> | void }> = [];

function scenario(name: string, run: () => Promise<void> | void): void {
  SCENARIOS.push({ name, run });
}

const PROVENANCE_VARIANTS: [string, Record<string, unknown>][] = [
  ["provenance U1", { manifest_uri: DOC_ONE }],
  ["provenance U2", { manifest_uri: DOC_TWO }],
  ["no provenance", {}],
];

// Fresh first registration, unmapped custom key: provenance must not choose the source.
for (const [label, provenance] of PROVENANCE_VARIANTS) {
  scenario(`a fresh custom key without a declaration is refused before any write (${label})`, async () => {
    const key = "srcid-fresh-custom";
    await assertRejectedWithoutWrite(
      key,
      () =>
        registerConnector(
          legacyManifest({
            connector_id: key,
            connector_key: key,
            ...provenance,
          }),
          {
            skipDerivedRepair: true,
          }
        ),
      NO_SOURCE_MESSAGE
    );
  });
}

// Fresh key-only registration (no connector_id), unmapped custom key: refused, no fallback.
scenario("a fresh key-only custom manifest without a declaration is refused before any write", async () => {
  const key = "srcid-fresh-keyonly";
  await assertRejectedWithoutWrite(
    key,
    () => registerConnector(legacyManifest({ connector_key: key, manifest_uri: DOC_ONE }), { skipDerivedRepair: true }),
    NO_SOURCE_MESSAGE
  );
});

// Unmapped registry-URL alias: a URL connector_id must not become the operational key or the source.
scenario("an unmapped registry URL connector_id is refused and never becomes a source", async () => {
  const url = "https://registry.pdpp.dev/connectors/srcid-fresh-url";
  await assertRejectedWithoutWrite(
    url,
    () => registerConnector(legacyManifest({ connector_id: url, manifest_uri: DOC_ONE }), { skipDerivedRepair: true }),
    URL_KEY_MESSAGE
  );
});

// Causal guard: an explicit, valid declaration does not make an unknown URL an operational key.
scenario("a URL-only connector_id with an explicit valid declaration is refused before any write", async () => {
  const url = "https://sources.example/connectors/srcid-explicit-url";
  const key = "srcid-explicit-url";
  await assertRejectedWithoutWrite(
    url,
    () =>
      registerConnector(
        legacyManifest({
          connector_id: url,
          manifest_uri: DOC_ONE,
          source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
        }),
        { skipDerivedRepair: true }
      ),
    URL_KEY_MESSAGE
  );
  assert.equal(await storedFor(key), null, "the declared slug must not be registered either");
});

// Known first-party key: the reviewed source identity wins over any incoming provenance.
for (const [label, provenance] of PROVENANCE_VARIANTS) {
  scenario(`a first-party key takes its reviewed source identity regardless of provenance (${label})`, async () => {
    const key = "amazon";
    await registerConnector(
      legacyManifest({
        connector_id: key,
        connector_key: key,
        ...provenance,
      }),
      {
        skipDerivedRepair: true,
      }
    );
    assert.equal(retainedSourceId(await storedFor(key)), firstPartySource("amazon"));
  });
}

// Known registry-URL alias with no connector_key resolves to its key and the same reviewed source.
scenario("a known registry URL alias resolves to its key and the reviewed source", async () => {
  await registerConnector(
    legacyManifest({
      connector_id: firstPartySource("gmail"),
      manifest_uri: DOC_ONE,
    }),
    { skipDerivedRepair: true }
  );
  const stored = await storedFor("gmail");
  assert.equal(stored?.connector_key, "gmail");
  assert.equal(retainedSourceId(stored), firstPartySource("gmail"));
});

// Known legacy local alias with its canonical key and no declaration resolves to the reviewed source.
scenario("a known legacy local alias with its canonical key takes the reviewed source", async () => {
  await registerConnector(
    legacyManifest({
      connector_id: "claude_code",
      connector_key: "claude-code",
    }),
    {
      skipDerivedRepair: true,
    }
  );
  assert.equal(retainedSourceId(await storedFor("claude-code")), firstPartySource("claude-code"));
});

// Control: an explicit validated declaration is the supported route for a first-party key too.
scenario("an explicit declaration wins over the reviewed mapping on a first registration", async () => {
  const key = "amazon";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
});

// Retained identity: a provenance-only update keeps the retained source (no fresh synthesis involved).
scenario("a provenance-only update keeps the retained source identity", async () => {
  const key = "srcid-prov";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_ONE,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_TWO,
      version: "1.1.0",
    }),
    { skipDerivedRepair: true }
  );
  assert.equal(
    retainedSourceId(await storedFor(key)),
    EXPLICIT_SOURCE,
    "manifest_uri must not replace the retained source"
  );
});

// Retained identity: a key-only update keeps the retained declaration.
scenario("a key-only update keeps the retained declaration", async () => {
  const key = "srcid-keyonly";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  await registerConnector(legacyManifest({ connector_key: key, version: "1.1.0" }), { skipDerivedRepair: true });
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
});

// Retained identity: an explicit different source identity cannot replace the retained one.
scenario("an explicit different source identity cannot replace the retained one", async () => {
  const key = "srcid-replace";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  await assert.rejects(
    () =>
      registerConnector(
        legacyManifest({
          connector_id: key,
          connector_key: key,
          manifest_uri: DOC_ONE,
          source_declaration: explicitDeclaration(key, OTHER_SOURCE),
          version: "1.1.0",
        }),
        { skipDerivedRepair: true }
      ),
    (error: unknown) => {
      const err = error as { code?: unknown; message?: unknown };
      assert.equal(err.code, INVALID_REQUEST);
      assert.match(String(err.message), ALREADY_BOUND);
      return true;
    }
  );
  assert.equal(
    retainedSourceId(await storedFor(key)),
    EXPLICIT_SOURCE,
    "the retained source must survive the rejected update"
  );
});

// Fail-before (explicit invalid): an explicit declaration is validated before it is retained.
scenario("an invalid explicit SourceDeclaration is rejected before persistence", async () => {
  const key = "srcid-invalid";
  const invalid = {
    ...explicitDeclaration(key, EXPLICIT_SOURCE),
    protocol_version: "9.9.9",
  };
  await assertRejectedWithoutWrite(
    key,
    () =>
      registerConnector(
        legacyManifest({
          connector_id: key,
          connector_key: key,
          manifest_uri: DOC_ONE,
          source_declaration: invalid,
        }),
        { skipDerivedRepair: true }
      ),
    INVALID_SOURCE_DECLARATION
  );
});

// Control: a valid explicit declaration keeps its identity when provenance changes.
scenario("a valid explicit declaration keeps its source identity when provenance changes", async () => {
  const key = "srcid-explicit";
  const declaration = explicitDeclaration(key, EXPLICIT_SOURCE);
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_ONE,
      source_declaration: declaration,
    }),
    { skipDerivedRepair: true }
  );
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_TWO,
      source_declaration: declaration,
      version: "1.1.0",
    }),
    { skipDerivedRepair: true }
  );
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
});

// Control: a legitimate schema update keeps the source and yields a new declaration version.
scenario("a schema update keeps the source identity and yields a new declaration version", async () => {
  const key = "srcid-schema";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  const first = (await storedFor(key))?.source_declaration as {
    declaration_version: string;
  };
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_ONE,
      streams: [streamFor("items"), streamFor("more")],
      version: "1.1.0",
    }),
    { skipDerivedRepair: true }
  );
  const second = (await storedFor(key))?.source_declaration as {
    declaration_version: string;
  };
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
  assert.notEqual(second.declaration_version, first.declaration_version);
});

// Control: the normalizer keeps a retained identity when given explicit context.
scenario("the normalizer keeps a retained identity when given it as context", () => {
  const key = "srcid-context";
  const retained = explicitDeclaration(key, EXPLICIT_SOURCE);
  const { storedManifest } = normalizeConnectorManifestForStorage(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_TWO,
    }),
    { retainedSourceDeclaration: retained }
  );
  assert.equal(retainedSourceId(storedManifest), EXPLICIT_SOURCE);
});

// Control: an alias with a different explicit key is rejected (existing validator guard).
scenario("a known alias with a different explicit key is rejected", async () => {
  await assertRejectedWithoutWrite(
    "codex",
    () =>
      registerConnector(
        legacyManifest({
          connector_id: "claude_code",
          connector_key: "codex",
        }),
        {
          skipDerivedRepair: true,
        }
      ),
    CANONICAL_KEY_MESSAGE
  );
});

// Control: an explicit key with an unmapped, unequal custom URI is rejected (existing validator guard).
scenario("an explicit key with an unmapped unequal custom URI is rejected", async () => {
  await assertRejectedWithoutWrite(
    "srcid-custom",
    () =>
      registerConnector(
        legacyManifest({
          connector_id: "https://example.org/manifest.json",
          connector_key: "srcid-custom",
        }),
        {
          skipDerivedRepair: true,
        }
      ),
    KEY_MATCH_MESSAGE
  );
});

// Control: a known alias with its canonical explicit key is accepted when the source comes from an explicit declaration.
scenario("a known alias with its canonical explicit key is accepted", async () => {
  await registerConnector(
    legacyManifest({
      connector_id: "claude_code",
      connector_key: "claude-code",
      source_declaration: explicitDeclaration("claude-code", EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  const stored = await storedFor("claude-code");
  assert.equal(stored?.connector_key, "claude-code");
  assert.equal(retainedSourceId(stored), EXPLICIT_SOURCE);
});

// Control: an idempotent re-registration of the same content keeps everything.
scenario("an idempotent re-registration keeps the retained identity", async () => {
  const key = "srcid-idem";
  const manifest = legacyManifest({
    connector_id: key,
    connector_key: key,
    source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
  });
  await registerConnector(manifest, { skipDerivedRepair: true });
  await registerConnector(manifest, { skipDerivedRepair: true });
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
});

// Concurrency: two registrations that name different explicit sources cannot both commit.
scenario("concurrent registrations of different explicit sources commit exactly one", async () => {
  const key = "srcid-race";
  const results = await Promise.allSettled([
    registerConnector(
      legacyManifest({
        connector_id: key,
        connector_key: key,
        source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
      }),
      { skipDerivedRepair: true }
    ),
    registerConnector(
      legacyManifest({
        connector_id: key,
        connector_key: key,
        source_declaration: explicitDeclaration(key, OTHER_SOURCE),
      }),
      { skipDerivedRepair: true }
    ),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "exactly one registration may commit");
  const winner = retainedSourceId(await storedFor(key));
  assert.ok(winner === EXPLICIT_SOURCE || winner === OTHER_SOURCE);
});

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ParkedWriter {
  readonly arrived: Deferred;
  readonly released: Deferred;
}

/**
 * Parks each registration of `connectorKey` at the stale-read point (after it observed the retained identity,
 * before it persists) until the test releases it. Parking is keyed by the source the writer intends.
 */
function parkRegistrationsAtStaleRead(
  connectorKey: string,
  sourceIds: readonly string[]
): {
  readonly gate: (sourceId: string) => ParkedWriter;
  readonly release: (sourceId: string) => void;
  readonly reset: () => void;
} {
  const gates = new Map<string, ParkedWriter>(
    sourceIds.map((sourceId) => [sourceId, { arrived: deferred(), released: deferred() }])
  );
  const gate = (sourceId: string): ParkedWriter => {
    const found = gates.get(sourceId);
    if (!found) {
      throw new Error(`no parked writer for ${sourceId}`);
    }
    return found;
  };
  __setRegisterConnectorPhaseHookForTest(async (point, context) => {
    if (point !== "before-manifest-persisted" || context.connectorId !== connectorKey) {
      return;
    }
    const sourceId = retainedSourceId(context.manifest as Record<string, unknown>);
    const writer = sourceId === undefined ? undefined : gates.get(sourceId);
    if (!writer) {
      return;
    }
    writer.arrived.resolve();
    await writer.released.promise;
  });
  return {
    gate,
    release: (sourceId) => gate(sourceId).released.resolve(),
    reset: () => {
      __setRegisterConnectorPhaseHookForTest(null);
      for (const writer of gates.values()) {
        writer.released.resolve();
      }
    },
  };
}

/**
 * Resolves when the writer reaches its stale-read point. Fails if the writer settles first: then the
 * interleaving was not replayed. Racing (not awaiting) keeps a late settlement from becoming an unhandled rejection.
 */
function parkedBefore(arrived: Promise<void>, writer: Promise<unknown>): Promise<void> {
  return Promise.race([
    arrived,
    writer.then(() => {
      throw new Error("a writer settled before the stale-read point: the interleaving was not replayed");
    }),
  ]);
}

function explicitRegistration(key: string, sourceId: string, extra: Record<string, unknown> = {}) {
  return registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, sourceId),
      ...extra,
    }),
    { skipDerivedRepair: true }
  );
}

// Causal replay of the unlocked interleaving (source-identity-boundary-r5 model, Locked = FALSE): both writers read
// "no retained identity" before either persists. The commit-time check must keep the first commit and refuse the
// second, leaving the registry row byte-identical.
scenario(
  "two writers that both read no retained identity: the commit-time check keeps the first and refuses the second",
  async () => {
    const key = "srcid-race-replay";
    const park = parkRegistrationsAtStaleRead(key, [EXPLICIT_SOURCE, OTHER_SOURCE]);
    const writerA = explicitRegistration(key, EXPLICIT_SOURCE);
    const writerB = explicitRegistration(key, OTHER_SOURCE);
    try {
      await Promise.all([
        parkedBefore(park.gate(EXPLICIT_SOURCE).arrived.promise, writerA),
        parkedBefore(park.gate(OTHER_SOURCE).arrived.promise, writerB),
      ]);
      park.release(EXPLICIT_SOURCE);
      await writerA;
      const afterA = JSON.stringify(await storedFor(key));
      assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);

      park.release(OTHER_SOURCE);
      await assert.rejects(writerB, (error: unknown) => {
        const err = error as { code?: unknown; message?: unknown };
        assert.equal(err.code, INVALID_REQUEST);
        assert.match(String(err.message), ALREADY_BOUND);
        return true;
      });
      assert.equal(JSON.stringify(await storedFor(key)), afterA, "the refused writer must not change the registry row");
      assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE, "the first writer's source survives");
      assert.equal(await getConnectorActivation(key), null, "no activation is written by a registration");
    } finally {
      park.reset();
      await Promise.allSettled([writerA, writerB]);
    }
  }
);

// Installer publish races a registration that read no identity. The registration resumes last and must be refused.
scenario(
  "a registration that read no identity before an installer publish is refused and the installer source survives",
  async () => {
    const key = "srcid-race-install";
    const park = parkRegistrationsAtStaleRead(key, [EXPLICIT_SOURCE]);
    const registration = explicitRegistration(key, EXPLICIT_SOURCE);
    try {
      await parkedBefore(park.gate(EXPLICIT_SOURCE).arrived.promise, registration);
      await publishConnectorActivation(
        installRecord(
          key,
          legacyManifest({
            connector_id: key,
            connector_key: key,
            source_declaration: explicitDeclaration(key, OTHER_SOURCE),
          })
        )
      );
      park.release(EXPLICIT_SOURCE);
      await assert.rejects(registration, (error: unknown) => {
        const err = error as { code?: unknown; message?: unknown };
        assert.equal(err.code, INVALID_REQUEST);
        assert.match(String(err.message), ALREADY_BOUND);
        return true;
      });
      assert.equal(retainedSourceId(await storedFor(key)), OTHER_SOURCE, "the installer's source is retained");
      const activation = await getConnectorActivation(key);
      assert.equal(retainedSourceId(activation?.canonicalManifest ?? null), OTHER_SOURCE);
    } finally {
      park.reset();
      await Promise.allSettled([registration]);
    }
  }
);

// A seeded retained identity that differs from the reviewed map must survive a schema/provenance update through the writer.
scenario("a retained custom source for a mapped key survives a schema update without a declaration", async () => {
  const key = "amazon";
  await explicitRegistration(key, EXPLICIT_SOURCE);
  const before = (await storedFor(key))?.source_declaration as { declaration_version: string } | undefined;
  assert.notEqual(EXPLICIT_SOURCE, firstPartySource("amazon"), "the seed must differ from the reviewed map");
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_TWO,
      streams: [streamFor("items"), streamFor("more")],
      version: "1.1.0",
    }),
    { skipDerivedRepair: true }
  );
  const stored = await storedFor(key);
  const after = stored?.source_declaration as {
    declaration_version: string;
    publisher: { id: string };
    streams: { name: string }[];
  };
  assert.equal(retainedSourceId(stored), EXPLICIT_SOURCE, "the retained custom source, not the map, is kept");
  assert.equal(after.publisher.id, PUBLISHER, "the retained publisher is kept");
  assert.deepEqual(
    after.streams.map((stream) => stream.name),
    ["items", "more"],
    "the new schema is the one stored"
  );
  assert.equal(stored?.version, "1.1.0");
  assert.notEqual(after.declaration_version, before?.declaration_version);
  assert.equal(await getConnectorActivation(key), null);
});

// Pure lookup: prototype names and unmapped names never resolve, and no key can be repointed through the exports.
scenario("prototype and unmapped names never resolve to a reviewed source", async () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "srcid-not-mapped"]) {
    assert.equal(legacyFirstPartySourceIdFor(name), undefined, `${name} must not resolve`);
  }
  await assertRejectedWithoutWrite(
    "constructor",
    () =>
      registerConnector(legacyManifest({ connector_id: "constructor", connector_key: "constructor" }), {
        skipDerivedRepair: true,
      }),
    NO_SOURCE_MESSAGE
  );
});

// Mutation control: the exported map views are frozen; a mutation attempt is refused and the lookup is unchanged.
scenario("exported key, entry and tuple views cannot be mutated to repoint a lookup", () => {
  assert.equal(Object.isFrozen(LEGACY_FIRST_PARTY_KEYS), true);
  assert.equal(Object.isFrozen(LEGACY_FIRST_PARTY_ENTRIES), true);
  const [firstKey, firstSource] = LEGACY_FIRST_PARTY_ENTRIES[0] ?? [];
  assert.ok(firstKey && firstSource);
  const tuple = LEGACY_FIRST_PARTY_ENTRIES[0] as unknown as object;
  assert.equal(Reflect.set(tuple, 1, OTHER_SOURCE), false, "a frozen entry tuple refuses assignment");
  assert.equal(Reflect.set(LEGACY_FIRST_PARTY_ENTRIES as unknown as object, 0, [firstKey, OTHER_SOURCE]), false);
  assert.equal(Reflect.set(LEGACY_FIRST_PARTY_KEYS as unknown as object, 0, "constructor"), false);
  assert.equal(legacyFirstPartySourceIdFor(firstKey), firstSource, "the lookup is unchanged");
  assert.equal(legacyFirstPartySourceIdFor("amazon"), firstPartySource("amazon"));
});

// Null and undefined mean "unspecified" (documented normalizer behavior), never a request for a map fallback.
async function assertAbsenceDeclaration(declaration: null | undefined): Promise<void> {
  await registerConnector(
    legacyManifest({ connector_id: "amazon", connector_key: "amazon", source_declaration: declaration }),
    { skipDerivedRepair: true }
  );
  assert.equal(retainedSourceId(await storedFor("amazon")), firstPartySource("amazon"));
  await assertRejectedWithoutWrite(
    "srcid-null-unmapped",
    () =>
      registerConnector(
        legacyManifest({
          connector_id: "srcid-null-unmapped",
          connector_key: "srcid-null-unmapped",
          source_declaration: declaration,
        }),
        { skipDerivedRepair: true }
      ),
    NO_SOURCE_MESSAGE
  );
}

scenario(
  "a null or undefined declaration is absence: mapped keys take the map, unmapped keys refuse, retained keys keep",
  async () => {
    await assertAbsenceDeclaration(null);
    await assertAbsenceDeclaration(undefined);
    const key = "srcid-null-retained";
    await explicitRegistration(key, EXPLICIT_SOURCE);
    await registerConnector(
      legacyManifest({ connector_id: key, connector_key: key, source_declaration: null, version: "1.1.0" }),
      { skipDerivedRepair: true }
    );
    assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
  }
);

// Malformed nonnull declarations refuse before any write, and never fall back to the reviewed map or provenance.
for (const [label, malformed] of [
  ["an empty object", {}],
  ["a string", "declaration"],
  ["a number", 42],
  ["a boolean", true],
  ["an array", []],
] as const) {
  scenario(`${label} as a declaration is refused before write on a mapped key (no map fallback)`, async () => {
    await assertRejectedWithoutWrite(
      "amazon",
      () =>
        registerConnector(
          legacyManifest({ connector_id: "amazon", connector_key: "amazon", source_declaration: malformed }),
          {
            skipDerivedRepair: true,
          }
        ),
      INVALID_SOURCE_DECLARATION
    );
  });
}

/** The POST /connectors operation, wired with the same dependencies the server mounts. */
function postRegister(manifest: Record<string, unknown>) {
  return executeAsPolyfillConnectorRegister(
    { manifest },
    {
      declarationDigest: connectorDeclarationDigest,
      getAcceptedDeclarationDigest,
      getConnectorManifest,
      normalizeManifestForStorage: normalizeConnectorManifestForStorage,
      registerConnector: (stored: Record<string, unknown>) => registerConnector(stored, { skipDerivedRepair: true }),
      validateManifest: (stored: Record<string, unknown>) => validateConnectorManifest(stored),
    }
  );
}

// POST control: an identical re-POST of a retained connector is idempotent and keeps its source.
scenario("an identical POST to a retained connector is idempotent and keeps its source", async () => {
  const key = "srcid-post-idem";
  const manifest = legacyManifest({
    connector_id: key,
    connector_key: key,
    manifest_uri: DOC_ONE,
    source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
  });
  await registerConnector(manifest, { skipDerivedRepair: true });
  const outcome = await postRegister(manifest);
  assert.equal(outcome.outcome, "success", JSON.stringify(outcome));
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
});

// POST control: a first-party identical re-POST with no declaration is idempotent under the reviewed source.
scenario("an identical POST of a first-party connector without a declaration is idempotent", async () => {
  const manifest = legacyManifest({
    connector_id: "amazon",
    connector_key: "amazon",
    manifest_uri: DOC_ONE,
  });
  const first = await postRegister(manifest);
  assert.equal(first.outcome, "success", JSON.stringify(first));
  const second = await postRegister(manifest);
  assert.equal(second.outcome, "success", JSON.stringify(second));
  assert.equal(retainedSourceId(await storedFor("amazon")), firstPartySource("amazon"));
});

// POST: a version update without a declaration keeps the retained source, whatever provenance it names.
scenario("a POST version update without a declaration keeps the retained source", async () => {
  const key = "srcid-post-update";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  const outcome = await postRegister(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_TWO,
      version: "1.1.0",
    })
  );
  assert.equal(outcome.outcome, "success", JSON.stringify(outcome));
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
});

// POST by a known registry alias: an identical re-POST compares against the retained identity of its canonical key.
// A lookup under the raw alias misses the retained row, takes the reviewed fresh-path source, and reports
// equivocation for content the server already accepted.
scenario(
  "an identical POST by a known registry alias to a retained connector is idempotent and keeps its source",
  async () => {
    const key = "amazon";
    const alias = `https://registry.pdpp.dev/connectors/${key}`;
    // The retained declaration is the one a re-projection of this provenance produces (implementation id = manifest_uri),
    // so an identical re-POST can be compared by digest.
    const retained = snapshotContentAddressedSourceDeclarationFromLegacyConnectorManifest(
      legacyManifest({ connector_id: key, connector_key: key }),
      { connectorImplementationId: alias, publisherId: PUBLISHER, sourceId: EXPLICIT_SOURCE }
    );
    await registerConnector(
      legacyManifest({ connector_id: key, connector_key: key, manifest_uri: alias, source_declaration: retained }),
      { skipDerivedRepair: true }
    );
    const outcome = await postRegister(legacyManifest({ connector_id: alias, manifest_uri: alias }));
    assert.equal(outcome.outcome, "success", JSON.stringify(outcome));
    assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE);
  }
);

/** An installer record whose manifest is the given one; only the identity fields matter here. */
function installRecord(connectorKey: string, manifest: Record<string, unknown>): ConnectorInstallRecord {
  const hex = (digit: string) => `sha256:${digit.repeat(64)}`;
  return {
    activatedAt: "2026-11-02T00:00:00.000Z",
    bindings: {},
    configDigest: hex("0"),
    connectorId: connectorKey,
    digest: hex("1"),
    entrypointPath: "/app/entrypoint.js",
    entrypointSha256: hex("2"),
    manifest,
    manifestPath: "/app/manifest.json",
    manifestSha256: hex("3"),
    provenancePath: "/app/provenance.json",
    provenanceSha256: hex("4"),
    registry: "ghcr.io",
    repository: `ghcr.io/example/connectors/${connectorKey}`,
    root: `/var/lib/pdpp/${connectorKey}`,
    tier: null,
    version: "1.0.0",
  };
}

// Installer: a retained source survives a provenance-only install.
scenario("an installer publish keeps the retained source identity across a provenance change", async () => {
  const key = "srcid-install-prov";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      manifest_uri: DOC_ONE,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  await publishConnectorActivation(
    installRecord(
      key,
      legacyManifest({
        connector_id: key,
        connector_key: key,
        manifest_uri: DOC_TWO,
      })
    )
  );
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE, "the registry keeps the retained source");
  const activation = await getConnectorActivation(key);
  assert.equal(
    retainedSourceId(activation?.canonicalManifest ?? null),
    EXPLICIT_SOURCE,
    "the activation records the same source"
  );
});

// Installer: an explicit different identity is rejected before any write.
scenario("an installer publish cannot rebind a retained source to an explicit different one", async () => {
  const key = "srcid-install-replace";
  await registerConnector(
    legacyManifest({
      connector_id: key,
      connector_key: key,
      source_declaration: explicitDeclaration(key, EXPLICIT_SOURCE),
    }),
    { skipDerivedRepair: true }
  );
  await assert.rejects(
    () =>
      publishConnectorActivation(
        installRecord(
          key,
          legacyManifest({
            connector_id: key,
            connector_key: key,
            manifest_uri: DOC_ONE,
            source_declaration: explicitDeclaration(key, OTHER_SOURCE),
          })
        )
      ),
    (error: unknown) => {
      const err = error as { code?: unknown; message?: unknown };
      assert.equal(err.code, INVALID_REQUEST);
      assert.match(String(err.message), ALREADY_BOUND);
      return true;
    }
  );
  assert.equal(retainedSourceId(await storedFor(key)), EXPLICIT_SOURCE, "the registry keeps the retained source");
  assert.equal(await getConnectorActivation(key), null, "no activation is written for a rejected publish");
});

// Installer, fresh: an unmapped custom key with provenance is refused before any registry or activation write.
scenario("an installer publish refuses a fresh custom key without a declaration", async () => {
  const key = "srcid-install-fresh";
  await assert.rejects(
    () =>
      publishConnectorActivation(
        installRecord(
          key,
          legacyManifest({
            connector_id: key,
            connector_key: key,
            manifest_uri: DOC_ONE,
          })
        )
      ),
    (error: unknown) => {
      const err = error as { code?: unknown; message?: unknown };
      assert.equal(err.code, INVALID_REQUEST);
      assert.match(String(err.message), NO_SOURCE_MESSAGE);
      return true;
    }
  );
  assert.equal(await storedFor(key), null, "no registry row is written");
  assert.equal(await getConnectorActivation(key), null, "no activation is written");
});

// The reviewed map is the proof for fresh first-party registrations: it must equal the pinned package
// identities exactly. A package change that adds, removes or re-points a shipped key fails here, so the
// map is reviewed rather than extended silently.
test("the reviewed legacy source map equals the pinned first-party package identities", () => {
  const pinned = readPolyfillManifests();
  const byKey = new Map(pinned.map((entry) => [entry.manifest.connector_key, entry.manifest]));
  assert.equal(pinned.length, 45, "the pinned package ships 45 first-party manifests");
  assert.deepEqual([...LEGACY_FIRST_PARTY_KEYS].sort(), [...byKey.keys()].sort());
  const canonicalPairs = [...LEGACY_FIRST_PARTY_ENTRIES].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const mappingPin = createHash("sha256").update(JSON.stringify(canonicalPairs), "utf8").digest("hex");
  assert.equal(mappingPin, "7e8f726725b7a14705571339c84a52d8f05888ffc0996b77cce3d4ae13dae9e6");
  for (const [key, sourceId] of LEGACY_FIRST_PARTY_ENTRIES) {
    const manifest = byKey.get(key);
    assert.ok(manifest, `pinned manifest for ${key}`);
    assert.equal(manifest.connector_id, sourceId, `${key}: connector_id is the reviewed source`);
    assert.equal(manifest.manifest_uri, sourceId, `${key}: manifest_uri is the reviewed source`);
    assert.equal(manifest.source_declaration, undefined, `${key}: the pinned manifest declares no source`);
  }
});

for (const entry of SCENARIOS) {
  test(`SQLite: ${entry.name}`, async () => {
    initDb(":memory:");
    try {
      await entry.run();
    } finally {
      closeDb();
    }
  });

  test(`PostgreSQL: ${entry.name} (skipped: PDPP_TEST_POSTGRES_URL unset)`, {
    skip: !process.env.PDPP_TEST_POSTGRES_URL,
  }, async () => {
    const url = process.env.PDPP_TEST_POSTGRES_URL;
    assert.ok(url);
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: url,
        databaseName: `pdpp_test_srcid_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}_1`,
        templateName: null,
      },
      async (databaseUrl) => {
        initDb(":memory:");
        try {
          await initPostgresStorage({ backend: "postgres", databaseUrl });
          await entry.run();
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
}

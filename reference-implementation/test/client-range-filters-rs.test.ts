// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the resource-server and client vectors of the experimental client range
// filters profile (spec-client-range-filters.md Section 11.2 and 11.3) against a
// real reference server. The AS vectors run in client-range-filters-as.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { rsAdvertisesClientRangeFilters } from "../server/client-range-filters.ts";
import { getDb } from "../server/db.ts";
import {
  assertExpected,
  type Fixture,
  fetchJson,
  type IssuedGrant,
  issueClientGrant,
  type JsonObject,
  loadVectors,
  manifestFor,
  materializeConnection,
  type ResponseLike,
  registerManifest,
  resolveQuery,
  responseMember,
  type Step,
  seedRecords,
  setGrantExtensions,
  startWorld,
  type Vector,
  type World,
} from "./helpers/client-range-filters-harness.ts";

const { file, exactRecords } = loadVectors();
const equivalenceGroups = new Map<string, Array<{ id: string; response: ResponseLike }>>();

function isRsVector(vector: Vector): boolean {
  return !(vector.id.startsWith("as-") || vector.id.startsWith("client-"));
}

// One server serves every vector. Each vector gets its own connection so the
// stored data and grants of one never reach another. The fixtures call their
// connection `inst_a`; the adapter renames it per vector.
let world: World;
let activeRun: VectorRun | undefined;
let manifestVersion = 0;

class VectorRun {
  readonly captures = new Map<string, string>();
  readonly vector: Vector;
  readonly instanceId: string;
  fixtureName: string;
  grants = new Map<string, IssuedGrant>();
  unevaluable: Array<{ field: string; stream: string }> = [];
  horizon: string | undefined;

  constructor(vector: Vector, ordinal: number) {
    this.vector = vector;
    this.instanceId = `inst_v${ordinal}`;
    this.fixtureName = vector.fixture as string;
  }

  get world(): World {
    return world;
  }

  get fixture(): Fixture {
    return file.fixtures[this.fixtureName] as Fixture;
  }

  rename<T>(value: T): T {
    return JSON.parse(JSON.stringify(value).replaceAll("inst_a", this.instanceId)) as T;
  }

  async start(): Promise<void> {
    activeRun = this;
    await this.activateFixture(this.fixtureName, true);
  }

  // Reset stored data to the named fixture. A grant is issued once per vector:
  // switching fixtures mid-vector keeps the grant and replaces only the records.
  async activateFixture(name: string, issue: boolean): Promise<void> {
    this.fixtureName = name;
    const fixture = this.fixture;
    this.unevaluable = fixture.serving?.unevaluable_filters ?? [];
    this.horizon = undefined;
    if (issue) {
      manifestVersion += 1;
      await registerManifest(this.world, manifestFor(fixture.retained_declaration, `crf.v${manifestVersion}`));
      await materializeConnection(this.instanceId);
    } else {
      getDb().prepare("DELETE FROM records WHERE connector_instance_id = ?").run(this.instanceId);
    }
    await seedRecords(this.rename(fixture.records), exactRecords.get(`${name}#`) as Map<string, string>);
    if (!issue) {
      return;
    }
    if (fixture.children) {
      for (const [child, value] of Object.entries(fixture.children)) {
        const childGrant = this.rename(value.grant);
        const grant = await issueClientGrant(this.world, childGrant);
        setGrantExtensions(grant.grantId, childGrant.extensions as JsonObject | undefined);
        this.grants.set(child, grant);
      }
    } else {
      const resolved = this.rename(fixture.grant);
      const grant = await issueClientGrant(this.world, resolved);
      setGrantExtensions(grant.grantId, resolved.extensions as JsonObject | undefined);
      this.grants.set("client", grant);
    }
    if (fixture.current_declaration) {
      // The current declaration moves on after consent. The grant must not.
      manifestVersion += 1;
      await registerManifest(this.world, manifestFor(fixture.current_declaration, `crf.v${manifestVersion}`));
    }
  }

  async activateHorizon(horizon: string): Promise<void> {
    const records = this.fixture.horizons?.[horizon]?.records;
    assert.ok(records, `horizon ${horizon}`);
    const { ingestRecord } = await import("../server/records.ts");
    for (const record of this.rename(records)) {
      const data = record.data as Record<string, unknown>;
      await ingestRecord(
        {
          connector_id: "spotify",
          connector_instance_id: record.instance_id,
        } as never,
        {
          data,
          emitted_at: "2026-01-10T00:00:00Z",
          key: record.key,
          stream: "transactions",
        } as never
      );
    }
    this.horizon = horizon;
  }

  tokenFor(request: NonNullable<Step["request"]>): string {
    const kind = request.token?.kind ?? "client";
    const key = kind === "package" ? (request.token?.selected_child as string) : "client";
    const grant = this.grants.get(key);
    assert.ok(grant, `grant for ${key}`);
    return grant.token;
  }

  async send(step: Step): Promise<ResponseLike> {
    const request = step.request as NonNullable<Step["request"]>;
    if (step.fixture && step.fixture !== this.fixtureName) {
      await this.activateFixture(step.fixture, false);
    }
    if (step.horizon) {
      await this.activateHorizon(step.horizon);
    }
    const query = resolveQuery(this.rename(request.query ?? []), this.captures);
    const url = `${this.world.rsUrl}${request.path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = {};
    if (request.path !== "/.well-known/oauth-protected-resource") {
      headers.Authorization = `Bearer ${this.tokenFor(request)}`;
    }
    const response = await fetchJson(url, {
      headers,
      method: request.method ?? "GET",
    });
    for (const [name, member] of Object.entries(step.capture ?? {})) {
      const value = response.body[member];
      assert.equal(typeof value, "string", `${this.vector.id}: capture ${name} from ${member}`);
      this.captures.set(name, value as string);
    }
    return response;
  }

  async run(): Promise<void> {
    for (const step of this.vector.setup ?? []) {
      const response = await this.send(step);
      assertExpected(step.expected ?? {}, response, `${this.vector.id} setup`);
    }
    const response = await this.send(this.vector);
    assertExpected(this.vector.expected as NonNullable<Vector["expected"]>, response, this.vector.id);
    const group = (this.vector as Vector & { response_equivalence_group?: string }).response_equivalence_group;
    if (group) {
      const members = equivalenceGroups.get(group) ?? [];
      members.push({ id: this.vector.id, response });
      equivalenceGroups.set(group, members);
    }
    for (const [index, step] of (this.vector.follow_up ?? []).entries()) {
      const followUp = await this.send(step);
      assertExpected(step.expected ?? {}, followUp, `${this.vector.id} follow_up ${index}`);
    }
  }
}

test.before(async () => {
  world = await startWorld({
    evaluable: ({ field, stream }) =>
      !activeRun?.unevaluable.some((item) => item.field === field && item.stream === stream),
  });
});

test.after(async () => {
  await world.close();
});

const vectorById = new Map(file.vectors.map((vector) => [vector.id, vector]));

// A negative vector proves nothing alone, because Core already rejects every
// client filter. Its `control` (a positive vector, possibly on another fixture)
// must pass first in the same run, or the negative is inconclusive.
async function passControl(vector: Vector, ordinal: number): Promise<void> {
  const controlId = (vector as Vector & { control?: string }).control;
  if (!controlId) {
    return;
  }
  const control = vectorById.get(controlId);
  assert.ok(control, `${vector.id}: control ${controlId} exists`);
  assert.equal(control.expected?.status, 200, `${controlId}: a control expects HTTP 200`);
  const run = new VectorRun(control, 1000 + ordinal);
  await run.start();
  await run.run();
}

for (const [ordinal, vector] of file.vectors.filter(isRsVector).entries()) {
  test(`vector ${vector.id} (${vector.requirements.join(", ")})`, async () => {
    await passControl(vector, ordinal);
    const run = new VectorRun(vector, ordinal);
    await run.start();
    await run.run();
  });
}

test("vectors in one response equivalence group answer identically", () => {
  assert.ok(equivalenceGroups.size > 0, "at least one equivalence group ran");
  for (const [group, members] of equivalenceGroups) {
    const compared = (
      file.vectors.find((vector) => members[0]?.id === vector.id) as Vector & {
        compare_response_members?: string[];
      }
    ).compare_response_members as string[];
    const [first, ...rest] = members;
    assert.ok(first && rest.length > 0, `${group}: needs two or more members`);
    for (const member of rest) {
      for (const path of compared) {
        assert.deepEqual(
          responseMember(member.response, path),
          responseMember(first.response, path),
          `${group}: ${member.id} differs from ${first.id} at ${path}`
        );
      }
    }
  }
});

for (const vector of file.vectors.filter((candidate) => candidate.id.startsWith("client-"))) {
  test(`vector ${vector.id} (${vector.requirements.join(", ")})`, () => {
    const request = vector.request as { metadata: unknown };
    assert.equal(rsAdvertisesClientRangeFilters(request.metadata), vector.expected?.profile_supported);
  });
}

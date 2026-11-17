// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs one resource-server vector of the experimental client range filters
// profile against a real reference server. Both vector files use it: a control
// for an AS negative may be an RS positive (vector README), and it must pass
// in the same run.

import assert from "node:assert/strict";
import { getDb } from "../../server/db.ts";
import { createSqliteConnectorInstanceStore } from "../../server/stores/connector-instance-store.ts";
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
	type Step,
	seedRecords,
	setGrantExtensions,
	startWorld,
	type Vector,
	type World,
} from "./client-range-filters-harness.ts";

export const { file, exactRecords } = loadVectors();
export const equivalenceGroups = new Map<
	string,
	Array<{ id: string; response: ResponseLike }>
>();

// One server serves every vector. Each vector gets its own connection so the
// stored data and grants of one never reach another. The fixtures call their
// connection `inst_a`; the adapter renames it per vector.
let world: World;
let activeRun: VectorRun | undefined;
let manifestVersion = 0;

export class VectorRun {
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
		return JSON.parse(
			JSON.stringify(value).replaceAll("inst_a", this.instanceId),
		) as T;
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
			await registerManifest(
				this.world,
				manifestFor(fixture.retained_declaration, `crf.v${manifestVersion}`),
			);
			await materializeConnection(this.instanceId);
		} else {
			getDb()
				.prepare("DELETE FROM records WHERE connector_instance_id = ?")
				.run(this.instanceId);
		}
		await seedRecords(
			this.rename(fixture.records),
			exactRecords.get(`${name}#`) as Map<string, string>,
		);
		if (!issue) {
			return;
		}
		if (fixture.children) {
			for (const [child, value] of Object.entries(fixture.children)) {
				const childGrant = this.rename(value.grant);
				const grant = await issueClientGrant(this.world, childGrant);
				setGrantExtensions(
					grant.grantId,
					childGrant.extensions as JsonObject | undefined,
				);
				this.grants.set(child, grant);
			}
		} else {
			const resolved = this.rename(fixture.grant);
			const grant = await issueClientGrant(this.world, resolved);
			setGrantExtensions(
				grant.grantId,
				resolved.extensions as JsonObject | undefined,
			);
			this.grants.set("client", grant);
		}
		if (fixture.current_declaration) {
			// The current declaration moves on after consent. The grant must not.
			manifestVersion += 1;
			await registerManifest(
				this.world,
				manifestFor(fixture.current_declaration, `crf.v${manifestVersion}`),
			);
		}
	}

	async activateHorizon(horizon: string): Promise<void> {
		const records = this.fixture.horizons?.[horizon]?.records;
		assert.ok(records, `horizon ${horizon}`);
		const { ingestRecord } = await import("../../server/records.ts");
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
				} as never,
			);
		}
		this.horizon = horizon;
	}

	tokenFor(request: NonNullable<Step["request"]>): string {
		const kind = request.token?.kind ?? "client";
		const key =
			kind === "package" ? (request.token?.selected_child as string) : "client";
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
			assert.equal(
				typeof value,
				"string",
				`${this.vector.id}: capture ${name} from ${member}`,
			);
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
		assertExpected(
			this.vector.expected as NonNullable<Vector["expected"]>,
			response,
			this.vector.id,
		);
		const group = (
			this.vector as Vector & { response_equivalence_group?: string }
		).response_equivalence_group;
		if (group) {
			const members = equivalenceGroups.get(group) ?? [];
			members.push({ id: this.vector.id, response });
			equivalenceGroups.set(group, members);
		}
		for (const [index, step] of (this.vector.follow_up ?? []).entries()) {
			const followUp = await this.send(step);
			assertExpected(
				step.expected ?? {},
				followUp,
				`${this.vector.id} follow_up ${index}`,
			);
		}
	}
}

export async function startRsWorld(): Promise<void> {
	world = await startWorld({
		evaluable: ({ field, stream }) =>
			!activeRun?.unevaluable.some(
				(item) => item.field === field && item.stream === stream,
			),
	});
}

export async function stopRsWorld(): Promise<void> {
	await world.close();
}

/**
 * Run one RS vector end to end, including its setup and follow-up steps. The
 * vector's connection is revoked afterwards so that a later wildcard request,
 * which resolves every active connection of the source, does not see it.
 */
export async function runRsVector(
	vector: Vector,
	ordinal: number,
): Promise<void> {
	const run = new VectorRun(vector, ordinal);
	await run.start();
	try {
		await run.run();
	} finally {
		const now = new Date().toISOString();
		await createSqliteConnectorInstanceStore().updateStatus(run.instanceId, {
			revokedAt: now,
			status: "revoked",
			updatedAt: now,
		});
	}
}

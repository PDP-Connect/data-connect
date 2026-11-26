// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Durable per-connection provider-invalidation proofs and their repaired markers. */

import {
	execDynamicSqlAcknowledged,
	iterateDynamicSqlAcknowledged,
} from "../../lib/db.ts";
import type { ProviderInvalidationProof } from "../../runtime/browser-surface/repair-decision.ts";
import {
	getStorageBackendKind,
	isPostgresStorageBackend,
	postgresQuery,
} from "../postgres-storage.ts";

export interface LoadedProviderInvalidationProofs {
	/**
	 * The most recently recorded proof for the connection (run order, not
	 * wall-clock time), or null. It may itself be repaired; see
	 * `repairedProofKeys`.
	 */
	readonly proof: ProviderInvalidationProof | null;
	/** `connection\nprovider\nevidence_id` keys already marked repaired. */
	readonly repairedProofKeys: readonly string[];
}

export interface ProviderInvalidationProofStore {
	load: (connectionId: string) => Promise<LoadedProviderInvalidationProofs>;
	/** Marks every unrepaired proof for the connection repaired (replay suppression). */
	markRepaired: (connectionId: string, repairedAt: string) => Promise<void>;
	record: (proof: ProviderInvalidationProof) => Promise<void>;
}

interface ProofRow {
	readonly connection_id: string;
	readonly observed_at: string;
	readonly provider: string;
	readonly repaired_at: string | null;
	readonly run_id: string;
}

function toProof(row: ProofRow): ProviderInvalidationProof {
	return {
		connection_id: row.connection_id,
		evidence_id: row.run_id,
		kind: "provider_invalidation_proof",
		observed_at: row.observed_at,
		provider: row.provider,
		verified: true,
	};
}

/** `rows` arrive in recording order (`ORDER BY seq`); a repair covers only the rows recorded before it. */
function toLoaded(rows: readonly ProofRow[]): LoadedProviderInvalidationProofs {
	const latest = rows.at(-1);
	return {
		proof: latest ? toProof(latest) : null,
		repairedProofKeys: rows
			.filter((row) => row.repaired_at !== null)
			.map((row) => `${row.connection_id}\n${row.provider}\n${row.run_id}`),
	};
}

const SELECT_COLUMNS =
	"connection_id, run_id, provider, observed_at, repaired_at";

function createSqliteStore(): ProviderInvalidationProofStore {
	return {
		load(connectionId) {
			// REVIEWED-DYNAMIC: fixed, parameterised lookup keyed by the connection id.
			const rows = [
				...iterateDynamicSqlAcknowledged<ProofRow>(
					`SELECT ${SELECT_COLUMNS} FROM provider_invalidation_proofs WHERE connection_id = ? ORDER BY seq`,
					[connectionId],
				),
			];
			return Promise.resolve(toLoaded(rows));
		},
		markRepaired(connectionId, repairedAt) {
			// REVIEWED-DYNAMIC: fixed, parameterised update keyed by the connection id.
			execDynamicSqlAcknowledged(
				"UPDATE provider_invalidation_proofs SET repaired_at = ? WHERE connection_id = ? AND repaired_at IS NULL",
				[repairedAt, connectionId],
			);
			return Promise.resolve();
		},
		record(proof) {
			// REVIEWED-DYNAMIC: fixed, parameterised insert; replays of one run id are ignored.
			execDynamicSqlAcknowledged(
				`INSERT INTO provider_invalidation_proofs (connection_id, run_id, provider, observed_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(connection_id, run_id) DO NOTHING`,
				[
					proof.connection_id,
					proof.evidence_id,
					proof.provider,
					proof.observed_at,
				],
			);
			return Promise.resolve();
		},
	};
}

function createPostgresStore(): ProviderInvalidationProofStore {
	return {
		async load(connectionId) {
			const result = await postgresQuery<ProofRow>(
				`SELECT ${SELECT_COLUMNS} FROM provider_invalidation_proofs WHERE connection_id = $1 ORDER BY seq`,
				[connectionId],
			);
			return toLoaded(result.rows);
		},
		async markRepaired(connectionId, repairedAt) {
			await postgresQuery(
				"UPDATE provider_invalidation_proofs SET repaired_at = $2 WHERE connection_id = $1 AND repaired_at IS NULL",
				[connectionId, repairedAt],
			);
		},
		async record(proof) {
			await postgresQuery(
				`INSERT INTO provider_invalidation_proofs (connection_id, run_id, provider, observed_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (connection_id, run_id) DO NOTHING`,
				[
					proof.connection_id,
					proof.evidence_id,
					proof.provider,
					proof.observed_at,
				],
			);
		},
	};
}

let defaultStore: ProviderInvalidationProofStore | null = null;
let defaultBackend: string | null = null;

export function getDefaultProviderInvalidationProofStore(): ProviderInvalidationProofStore {
	const backend = getStorageBackendKind();
	if (!defaultStore || defaultBackend !== backend) {
		defaultStore = isPostgresStorageBackend()
			? createPostgresStore()
			: createSqliteStore();
		defaultBackend = backend;
	}
	return defaultStore;
}

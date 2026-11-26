// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { SourceStatusRow } from "../../lib/source-status-words.ts";
import type { ConfigRevisionWire } from "./connection-config-view-model.ts";
import {
	buildRecoveryDemoModel,
	withStatusDemoVariant,
} from "./source-detail-demo-data.ts";
import type { ConnectorPageModel } from "./source-page.tsx";

export const SOURCE_PRACTICE_STATES = [
	"unknown-count",
  "atlas",
	...Array.from({ length: 24 }, (_, i) => `status-${i + 1}`),
	"status-8-stored-credential",
	"status-8-provider-interaction",
	"status-8-owner-device",
	"status-10-historical-archive",
	"status-10-local-device",
	"status-22-failed-last-run",
	"status-8-no-server-action",
	"status-8-browser-session",
	"pending-details",
	"pending-details-19",
	"update-ready",
	"update-ready-shared",
	"other-accounts",
	"settings-choices",
	"settings-question",
	"device-healthy",
	"partly-more-coming",
	"partly-some-lost",
	"didnt-come",
	"dialog-reset",
	"dialog-disconnect",
	"dialog-delete",
	"dialog-delete-running",
] as const;

export function buildSourcePracticeModel(
	state: string,
): ConnectorPageModel | null {
	if (!(SOURCE_PRACTICE_STATES as readonly string[]).includes(state))
		return null;
	const match = state.match(/^status-(\d{1,2})(?:-([a-z-]+))?$/u);
	const row = Number(
		match?.[1] ??
			(state === "pending-details" ? 20 : state === "atlas" ? 16 : 19),
	) as SourceStatusRow;
	let model = buildRecoveryDemoModel(
		row,
		state === "pending-details" || state === "pending-details-19" || row === 16,
	);
	model = {
		...model,
		source: { ...model.source, display_name: model.displayName },
	};
	if (match?.[2]) model = withStatusDemoVariant(model, match[2]);
	if (state === "status-10-local-device")
		return {
			...model,
			source: { ...model.source, source_kind: "local_device" },
			sourceInstances: buildRecoveryDemoModel(1).sourceInstances,
		};
	if (
		state.startsWith("status-") ||
		[
			"atlas",
			"pending-details",
			"pending-details-19",
			"update-ready",
			"update-ready-shared",
		].includes(state)
	)
		return model;
	model = {
		...model,
		connectorId: "northwind",
		displayName: "Northwind",
		connectionLabelSeed: "Northwind",
		sourceInstances: [],
		connectionPrimaryAction: null,
		source: {
			...model.source,
			connector_id: "northwind",
			connector_display_name: "Northwind",
			display_name: "Northwind",
			source_kind: "account",
		},
		manifest: {
			...model.manifest,
			connector_id: "northwind",
			display_name: "Northwind",
			name: "Northwind",
		},
	};
	if (state === "other-accounts")
		model.otherAccounts = [
			{ connectionId: "cin_sample_other", displayName: "Northwind, work" },
		];
	if (state === "device-healthy")
		model = {
			...model,
			source: { ...model.source, source_kind: "local_device" },
			sourceInstances: buildRecoveryDemoModel(1).sourceInstances.map(
				(device) => ({
					...device,
					display_name: "Work computer",
					last_heartbeat_at: "2026-11-24T11:55:00Z",
				}),
			),
		};
	if (state.startsWith("partly-") || state === "didnt-come") {
		const entry = {
			checkpoint: "committed" as const,
			collected: state === "didnt-come" ? 0 : 24,
			considered: 27,
			coverage_condition: "retryable_gap" as const,
			covered: 24,
			forward_disposition:
				state === "partly-some-lost"
					? ("terminal" as const)
					: ("resumable" as const),
			pending_detail_gaps: 3,
			skipped: null,
			stream: "messages",
		};
		model = {
			...model,
			streams: model.streams.map((stream) =>
				stream.name === "messages"
					? { ...stream, record_count: entry.collected }
					: stream,
			),
			latestKnownGaps: [
				{
					kind: "missing",
					reason: "unavailable",
					stream: "messages",
					message: "Northwind could not send these messages.",
					recovery_hint: { retryable: state !== "partly-some-lost" },
				},
			],
			source: { ...model.source, collection_report: [entry] },
		};
	}
	if (state === "unknown-count") model.streams = model.streams.map((stream) => stream.name === "messages" ? { ...stream, record_count: 999, count_state: "stale" } : { ...stream, record_count: null, count_state: "known_zero" });
	if (state.startsWith("settings-")) {
		const revision: ConfigRevisionWire = {
			collection_boundary_fingerprint: null,
			config: { HISTORY_DAYS: 30 },
			config_contract_id: "sample",
			config_contract_version: 1,
			confirmed_at: null,
			confirmed_by: null,
			connection_id: model.connectionId,
			is_explicit: true,
			option_kind: "collection_scope",
			origin: "owner",
			revision: 1,
			set_at: "2026-11-24T10:00:00Z",
			set_by: "owner",
			source_of_change: "Copy a month of messages.",
			status: "proposed",
		};
		model.configuration = {
			active_revision: null,
			base_epoch: 0,
			base_revision: 0,
			connection_id: model.connectionId,
			connector_key: "northwind",
			options_schema_status: "declared",
			options_schema: {
				connector_key: "northwind",
				description: "Choose what to copy.",
				options: [
					{
						default: 7,
						description: "How many days of messages to copy.",
						enum: null,
						maximum: 365,
						minimum: 1,
						option_key: "HISTORY_DAYS",
						option_kind: "collection_scope",
						platform_classified: true,
						type: "integer",
					},
				],
			},
		};
		model.configRevisions = state === "settings-question" ? [revision] : [];
	}
	if (state.startsWith("dialog-"))
		model.initialDialog =
			state === "dialog-reset"
				? "reset"
				: state === "dialog-disconnect"
					? "disconnect"
					: "delete";
	if (state === "dialog-delete-running")
		model.activeRunId = "run_sample_active";
	return model;
}

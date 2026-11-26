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
  "apps-some", "apps-none",
  "raw-error", "settings-machine-change", "settings-long-list", "waiting-unknown", "archive-leftover", "trouble-unknown", "strong-state-pending", "records-zero-one", "measurement-shortfall", "bookkeeping-kinds", "long-account-name", "own-account",
  "unmeasured-completeness",
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
			(state === "pending-details" ? 20 : state === "waiting-unknown" ? 8 : state === "trouble-unknown" ? 16 : state === "strong-state-pending" ? 13 : state === "archive-leftover" ? 1 : state === "atlas" ? 16 : 19),
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
			{ connectionId: "cin_sample_other", displayName: "Northwind (work)" },
		];
	if (state === "device-healthy")
		model = {
			...model,
			source: { ...model.source, source_kind: "local_device" },
			sourceInstances: buildRecoveryDemoModel(1).sourceInstances.map(
				(device) => ({
					...device,
					display_name: "Work computer",
					last_heartbeat_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
				}),
			),
		};
	if (state.startsWith("partly-") || state === "didnt-come" || state === "raw-error") {
		const entry = {
			checkpoint: "committed" as const,
			collected: ["didnt-come", "raw-error"].includes(state) ? 0 : 24,
			considered: 27,
			coverage_condition: state === "partly-some-lost" ? "terminal_gap" as const : "retryable_gap" as const,
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
					message: state === "raw-error" ? "offset=480: refusing_to_advance_cursor; " + "machine_failure_".repeat(30) : "Northwind could not send these messages.",
					recovery_hint: { retryable: state !== "partly-some-lost" },
				},
			],
			source: { ...model.source, collection_report: [entry] },
		};
	}
	if (state === "unmeasured-completeness") {
    const verdict: NonNullable<ConnectorPageModel["connectionRenderedVerdict"]> = {
      ...model.source.rendered_verdict!,
      pill: { label: "Not measured", tone: "grey" },
      required_actions: [{ affects: ["messages"], audience: "maintainer" as const, kind: "code_fix" as const, cta: "Some data from this source isn't being measured yet", surface: { kind: "maintainer" as const }, satisfied_when: { kind: "none" as const }, terminal: false, urgency: "soon" as const }],
    };
    model = { ...model, connectionRenderedVerdict: verdict, source: { ...model.source, last_run: model.source.last_successful_run, owner_state: { ...model.source.owner_state!, resolver: "blocked_maintainer" }, rendered_verdict: verdict } };
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
			active_revision: state === "settings-choices" ? { ...revision, status: "active" } : null,
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

  if (state === "waiting-unknown") {
    const action = { ...buildRecoveryDemoModel(8).connectionPrimaryAction!, surface: { kind: "provider_interaction" as const }, cta: "Complete the requested action", target: undefined };
    model.source = { ...model.source, owner_state: { ...model.source.owner_state!, resolver: "needs_owner" }, rendered_verdict: { ...model.source.rendered_verdict!, required_actions: [action] } };
    model.connectionPrimaryAction = action;
  }
  if (state === "trouble-unknown") model.source = { ...model.source, owner_state: { ...model.source.owner_state!, resolver: "system_degraded" }, rendered_verdict: { ...model.source.rendered_verdict!, pill: { label: "Can't collect", tone: "red" } } };
  if (state === "strong-state-pending" || state === "archive-leftover") {
    model.connectionHealth = { ...model.connectionHealth!, detail_gap_backlog: { ...buildRecoveryDemoModel(16, true).connectionHealth!.detail_gap_backlog!, pending: 3 } };
    if (state === "strong-state-pending") model.source = { ...model.source, owner_state: { ...model.source.owner_state!, resolver: "blocked_maintainer" } };
    else model.source = { ...model.source, source_visibility: "archived", source_binding_kind: "historical_archive" };
  }
  if (state === "records-zero-one") model.streams = model.streams.map((stream, i) => ({ ...stream, record_count: i === 0 ? 1 : 0, count_state: i === 0 ? "known" : "known_zero" }));
  if (state === "measurement-shortfall") model.source = { ...model.source, collection_report: [{ stream: "messages", collected: 0, considered: 100, covered: "unknown", checkpoint: "unknown", coverage_condition: "unknown", forward_disposition: "unmeasured", skipped: null, pending_detail_gaps: 0 }] };
  if (state === "bookkeeping-kinds") {
    model.streams = [...model.streams, { name: "coverage_diagnostics", object: "stream", record_count: 0, count_state: "known_zero", last_updated: null }];
    model.manifest = { ...model.manifest, streams: [...model.manifest.streams ?? [], { name: "coverage_diagnostics", display: { label: "Copy checks" }, description: "Copy checks" }] };
  }
  if (state === "long-account-name") model.source = { ...model.source, display_name: "Northwind - a deliberately long account name" };
  if (state === "own-account") model.otherAccounts = [{ connectionId: model.connectionId, displayName: "Northwind" }, { connectionId: "cin_sample_other", displayName: "Northwind (work)" }];
  if (state === "settings-machine-change" || state === "settings-long-list") {
    const base = buildSourcePracticeModel("settings-question")!;
    const revision = { ...base.configRevisions[0]!, origin: "agent" as const, set_by: state === "settings-machine-change" ? "migration" : "app:Sample app", source_of_change: "migration:synthetic_machine_reason", config: { CHANNELS: Array.from({ length: 250 }, (_, i) => `C${String(i).padStart(10, "0")}`) } };
    model.configuration = { ...base.configuration!, options_schema: { ...base.configuration!.options_schema!, options: [{ ...base.configuration!.options_schema!.options[0]!, option_key: "CHANNELS", description: "Choose which channels to copy.", type: "string_array", default: [], minimum: null, maximum: null }] } };
    model.configRevisions = [revision];
  }
	if (state.startsWith("dialog-"))
		model.initialDialog =
			state === "dialog-reset"
				? "reset"
				: state === "dialog-disconnect"
					? "disconnect"
					: "delete";
	if (state === "dialog-delete-running") {
    model.activeRunId = "run_sample_active";
    model.overview = { ...model.overview, isRunning: true };
  }
	return model;
}

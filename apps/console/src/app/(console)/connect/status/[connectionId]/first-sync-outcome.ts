// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "After the first sync ends" (design "Page 3"): one outcome, one sentence, the
 * right next button. Pure, so every state can be tested without a server.
 */

import { classifyKnownGaps, type KnownGap } from "../../../lib/run-gaps.ts";
import { humanizeFieldLabel } from "@pdpp/display";
import type {
	ConnectionSetupStatus,
	RefSchedule,
	RunHandleStatus,
} from "../../../lib/ref-client.ts";
import { formatSourceRowSchedule } from "../../../sources/sources-view-model.ts";
import { setupHref, sourceRecordsHref } from "./connect-status-links.ts";

export interface CollectedKind {
	readonly count: number;
	/** The kind in the service's own words. */
	readonly label: string;
	/** The kind's name on the server, for the link to its records. */
	readonly stream: string;
}

export type ScheduleFacts = Pick<
	RefSchedule,
	"effective_mode" | "enabled" | "interval_seconds"
>;

export interface FirstSyncFacts {
	readonly gaps?: readonly KnownGap[];
	readonly failureReason?: string | null;
	readonly runStatus?: RunHandleStatus | null;
	readonly signedIn?: boolean;
	/** Kinds with counts from the finished run, or null when the run did not report them. */
	readonly kinds: readonly { count: number; kind: string }[] | null;
	/**
	 * The schedule the data source's own page reads. `null`: the server has none,
	 * which the Data sources list calls "Manual". `undefined`: the read failed, so
	 * no sentence is better than a wrong one.
	 */
	readonly schedule: ScheduleFacts | null | undefined;
}

export interface OutcomeLink {
	readonly href: string;
	readonly label: string;
}

export type FirstSyncOutcome =
	| {
			readonly kind: "worked";
			readonly collected: readonly CollectedKind[];
			readonly schedule: string | null;
			readonly primary: OutcomeLink;
			readonly secondary: OutcomeLink;
	  }
	| { readonly kind: "empty"; readonly retry: OutcomeLink }
	| {
			readonly kind: "running";
			readonly watch: OutcomeLink;
			readonly runId: string | null;
			readonly signIn: boolean;
			readonly signedIn: boolean;
			readonly addAnother: OutcomeLink;
	  }
	| {
			readonly kind: "partial";
			readonly collected: readonly CollectedKind[];
			readonly missing: readonly {
				label: string;
				message: string;
				retryable: boolean;
			}[];
			readonly primary: OutcomeLink;
			readonly retry: OutcomeLink | null;
	  }
	| { readonly kind: "needs-you"; readonly next: OutcomeLink }
	| {
			readonly kind: "failed";
			readonly title?: string;
			readonly secondary?: OutcomeLink;
			readonly reason: string;
			readonly retry: OutcomeLink;
			readonly wentWrong: string | null;
	  }
	| { readonly kind: "paused"; readonly open: OutcomeLink }
	| { readonly kind: "revoked"; readonly addAnother: OutcomeLink };

const ADD_ANOTHER: OutcomeLink = {
	href: "/sources/add",
	label: "Add another data source",
};

export const outcomeCopy = {
	connected: (name: string) => `${name} is connected.`,
	emptyHeadline: (name: string) =>
		`${name} is connected, but nothing came back.`,
	runningHeadline: (name: string) => `Copying your ${name} data`,
	watch: "Watch it",
	needsYouHeadline: (name: string) => `${name} needs you to finish signing in.`,
	continue: "Continue",
	failedHeadline: (name: string) => `${name} didn't connect.`,
	failedFallback: "Something went wrong while copying your data.",
	pausedHeadline: (name: string) => `${name} is paused.`,
	revokedHeadline: (name: string) => `${name} was disconnected.`,
	seeData: (name: string) => `See your ${name} data`,
	retry: "Try again",
} as const;

/**
 * "DataConnect checks <Name> every hour." / "... only when you ask." Words come
 * from the same derivation the Data sources list uses for its schedule column,
 * so the two never disagree. Null when the schedule could not be read.
 */
export function scheduleSentence(
	name: string,
	schedule: ScheduleFacts | null | undefined,
): string | null {
	if (schedule === undefined) return null;
	const label = formatSourceRowSchedule(schedule);
	if (label === "Manual")
		return `DataConnect checks ${name} only when you ask.`;
	if (/^Every\b/.test(label))
		return `DataConnect checks ${name} ${label.charAt(0).toLowerCase()}${label.slice(1)}.`;
	return null;
}

function retryLabel(status: ConnectionSetupStatus): string {
	if (status.setup_kind === "manual_upload") return "Choose another file";
	if (status.setup_kind === "static_secret") return "Enter the key again";
	return outcomeCopy.retry;
}

function collectedKinds(facts: FirstSyncFacts): CollectedKind[] {
	return (facts.kinds ?? [])
		.filter(({ count }) => count > 0)
		.map(({ count, kind }) => ({
			count,
			label: humanizeFieldLabel(kind),
			stream: kind,
		}));
}

const ZERO_STATES = new Set([
	"first_sync_zero_yield",
	"first_sync_verified_empty",
	"first_sync_unverified_zero",
	"first_sync_unverified_missing_counts",
]);

const NEEDS_YOU_STATES = new Set([
	"awaiting_browser_login",
	"awaiting_credential",
]);

export function firstSyncOutcome(
	status: ConnectionSetupStatus,
	name: string,
	facts: FirstSyncFacts,
): FirstSyncOutcome {
	const retryHref = setupHref(status);
	if (status.setup_state === "revoked")
		return { addAnother: { ...ADD_ANOTHER }, kind: "revoked" };
	if (status.setup_state === "paused") {
		return {
			kind: "paused",
			open: {
				href: sourceRecordsHref(status),
				label: outcomeCopy.seeData(name),
			},
		};
	}
	const reason = facts.failureReason;
	const stopped =
		reason === "owner_cancelled" || reason === "owner_cancel_forced";
	const timedOut =
		status.setup_kind === "browser_session" &&
		reason === "assistance_timed_out";
	const busy =
		status.setup_kind === "browser_session" &&
		(facts.runStatus === "deferred" ||
			facts.runStatus === "waiting_for_browser_surface");
	if (
		status.setup_state === "first_sync_failed" ||
		stopped ||
		timedOut ||
		busy
	) {
		const neverStarted = status.setup_kind === "browser_session" && facts.runStatus === "surface_failed" &&
      facts.signedIn !== true && collectedKinds(facts).length === 0 &&
      (status.run?.records_emitted ?? 0) === 0 && (status.run?.reported_records_emitted ?? 0) === 0;
    const title = stopped
			? "You stopped this."
			: timedOut
				? `The sign-in to ${name} wasn't finished.`
				: busy
					? "DataConnect was busy with another sign-in."
					: undefined;
		return {
			kind: "failed",
			title,
			reason: stopped
				? "What was copied before you stopped is kept."
				: timedOut
					? "Nothing is lost. Start again when you're ready."
					: busy
						? ""
						: neverStarted ? `DataConnect could not open ${name}'s sign-in page.` : outcomeCopy.failedFallback,
			retry: {
				href: retryHref,
				label: stopped
					? "Start again"
					: timedOut
						? `Sign in to ${name}`
						: retryLabel(status),
			},
			secondary:
				stopped && collectedKinds(facts).length > 0
					? {
							href: sourceRecordsHref(status),
							label: outcomeCopy.seeData(name),
						}
					: undefined,
			wentWrong: title ? null : status.last_error?.reason?.trim() || null,
		};
	}
	if (NEEDS_YOU_STATES.has(status.setup_state)) {
		const runId = status.run?.run_id;
		const nextHref = runId
			? `/syncs/${encodeURIComponent(runId)}${status.setup_state === "awaiting_credential" ? "?return_to=status#sign-in-details" : "/stream"}`
			: retryHref;
		return {
			kind: "needs-you",
			next: { href: nextHref, label: outcomeCopy.continue },
		};
	}
	if (
		status.setup_state === "first_sync_pending" ||
		status.setup_state === "first_sync_running" ||
		status.running
	) {
		const runId = status.run?.run_id;
		const watchHref = runId
			? `/syncs/${encodeURIComponent(runId)}${status.setup_kind === "browser_session" ? "/stream" : ""}`
			: "/sources";
		return {
			kind: "running",
			runId: runId ?? null,
			signIn: status.setup_kind === "browser_session",
			signedIn: facts.signedIn === true,
			addAnother: ADD_ANOTHER,
			watch: { href: watchHref, label: outcomeCopy.watch },
		};
	}
	const collected = collectedKinds(facts);
	const missing = classifyKnownGaps(facts.gaps ?? []).coverageGaps.map(
		(gap) => ({
			label: gap.stream ? humanizeFieldLabel(gap.stream) : "Some data",
			message: gap.message?.trim() || "DataConnect could not copy this.",
			retryable: gap.recovery_hint?.retryable === true,
		}),
	);
	const missingByKind = new Map<string, (typeof missing)[number]>();
	for (const gap of missing) {
		const previous = missingByKind.get(gap.label);
		missingByKind.set(
			gap.label,
			previous
				? {
						...gap,
						message:
							previous.message === gap.message
								? gap.message
								: `${previous.message} ${gap.message}`,
						retryable: previous.retryable || gap.retryable,
					}
				: gap,
		);
	}
	if (missing.length > 0)
		return {
			kind: "partial",
			collected,
			missing: [...missingByKind.values()],
			primary: {
				href: sourceRecordsHref(status),
				label: outcomeCopy.seeData(name),
			},
			retry: missing.some((gap) => gap.retryable)
				? { href: retryHref, label: outcomeCopy.retry }
				: null,
		};
	const knownEmpty = facts.kinds !== null && collected.length === 0;
	if (
		ZERO_STATES.has(status.setup_state) ||
		(status.setup_state === "active" && knownEmpty)
	) {
		return {
			kind: "empty",
			retry: { href: retryHref, label: outcomeCopy.retry },
		};
	}
	return {
		collected,
		kind: "worked",
		primary: {
			href: sourceRecordsHref(status),
			label: outcomeCopy.seeData(name),
		},
		schedule: scheduleSentence(name, facts.schedule),
		secondary: { ...ADD_ANOTHER },
	};
}

export function headlineFor(outcome: FirstSyncOutcome, name: string): string {
	switch (outcome.kind) {
		case "worked":
			return outcomeCopy.connected(name);
		case "partial":
			return `${name} is connected, but some of it didn't come.`;
		case "empty":
			return outcomeCopy.emptyHeadline(name);
		case "running":
			return outcomeCopy.runningHeadline(name);
		case "needs-you":
			return outcomeCopy.needsYouHeadline(name);
		case "failed":
			return outcome.title ?? outcomeCopy.failedHeadline(name);
		case "paused":
			return outcomeCopy.pausedHeadline(name);
		case "revoked":
			return outcomeCopy.revokedHeadline(name);
	}
}

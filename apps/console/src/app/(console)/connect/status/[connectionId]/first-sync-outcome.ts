// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "After the first sync ends" (design "Page 3"): one outcome, one sentence, the
 * right next button. Pure, so every state can be tested without a server.
 */

import { NO_NAME_FALLBACK } from "../../../lib/connection-display-name.ts";
import { classifyKnownGaps, type KnownGap } from "../../../lib/run-gaps.ts";
import { resolveSyncCause } from "../../../lib/sync-cause.ts";
import type { StreamManifestEntry } from "@pdpp/display";
import { sourceRecordLabel } from "../../../lib/source-record-label.ts";
import type {
	ConnectionSetupStatus,
	RefSchedule,
	RunHandleStatus,
} from "../../../lib/ref-client.ts";
import { type ScheduleFacts, scheduleState } from "../../../lib/schedule-words.ts";
import { setupHref, sourceRecordsHref } from "./connect-status-links.ts";

export interface CollectedKind {
	readonly count: number;
	/** The kind in the service's own words. */
	readonly label: string;
	/** The kind's name on the server, for the link to its records. */
	readonly stream: string;
}

export type { ScheduleFacts };

export interface FirstSyncFacts {
	/** The manifest's streams: the same labels the source page uses. */
	readonly streams?: readonly StreamManifestEntry[];
	readonly gaps?: readonly KnownGap[];
	readonly failureReason?: string | null;
	/** The run's structured connector error, the same evidence the list row gives the cause resolver. */
	readonly connectorError?: unknown;
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
				/** What the page says about trying again; null says nothing. */
				retryNote: string | null;
				retryable: boolean;
				/** The cause needs the person (sign-in again), so it cannot retry by itself. */
				needsPerson: boolean;
			}[];
			readonly primary: OutcomeLink;
			readonly retry: OutcomeLink | null;
			/** The step the person must take to get the rest, in a phrase ("a new sign-in"); null when none. */
			readonly step: string | null;
			readonly technical: OutcomeLink | null;
	  }
	| { readonly kind: "needs-you"; readonly next: OutcomeLink }
	| {
			readonly kind: "failed";
			readonly title?: string;
			readonly secondary?: OutcomeLink;
			readonly reason: string;
			readonly retry: OutcomeLink;
			readonly wentWrong: string | null;
			readonly technical: OutcomeLink | null;
	  }
	| { readonly kind: "paused"; readonly open: OutcomeLink }
	| {
			readonly kind: "revoked";
			readonly note: string;
			readonly open: OutcomeLink;
			readonly connectAgain: OutcomeLink;
	  };

const ADD_ANOTHER: OutcomeLink = {
	href: "/sources/add",
	label: "Add another data source",
};

/** A name that starts a sentence: "this data source" becomes "This data source". */
function atStart(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "your Venmo data"; with no name at all, just "your data". */
function yourData(name: string): string {
	return name === NO_NAME_FALLBACK ? "your data" : `your ${name} data`;
}

export const outcomeCopy = {
	connected: (name: string) => `${atStart(name)} is connected.`,
	emptyHeadline: (name: string) =>
		`${atStart(name)} is connected, but nothing came back.`,
	partialHeadline: (name: string, step: string | null = null) =>
		step
			? `${atStart(name)} needs ${step} to copy the rest.`
			: `${atStart(name)} is connected, but some of it didn't come.`,
	runningHeadline: (name: string) => `Copying ${yourData(name)}`,
	watch: "Watch it",
	needsYouHeadline: (name: string) =>
		`${atStart(name)} needs you to finish signing in.`,
	continue: "Continue setup",
	failedHeadline: (name: string) => `${atStart(name)} didn't connect.`,
	failedFallback: "Something went wrong while copying your data.",
	pausedHeadline: (name: string) => `${atStart(name)} is paused.`,
	revokedHeadline: (name: string) => `${atStart(name)} was disconnected.`,
	seeData: (name: string) => `See ${yourData(name)}`,
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
	const state = scheduleState(schedule);
	if (state.kind === "manual")
		return `DataConnect checks ${name} only when you ask.`;
	if (state.kind === "scheduled")
		return `DataConnect checks ${name} ${state.every}.`;
	return null;
}

/** A saved username and password is signed in with again; any other saved secret is a key. */
function savedSecretLabel(status: ConnectionSetupStatus): string {
	return status.credential.credential_kind === "username_password"
		? "Sign in again"
		: "Enter the key again";
}

/** Prose only: a single token, or one with a code-style word, is not owner text. */
function plainRemediation(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text && /\s/.test(text) && !/\b[a-z0-9]+_[a-z0-9_]+\b/i.test(text) ? text : null;
}

/** Try again, never a sign-in or key step: only a cause in the credential gets those. */
function retryLabel(status: ConnectionSetupStatus): string {
	if (status.setup_kind === "manual_upload") return "Choose another file";
	return outcomeCopy.retry;
}

function collectedKinds(facts: FirstSyncFacts): CollectedKind[] {
	return (facts.kinds ?? [])
		.filter(({ count }) => count > 0)
		.map(({ count, kind }) => ({
			count,
			label: sourceRecordLabel(kind, facts.streams),
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

const COULD_NOT_COPY = "DataConnect could not copy this.";

/**
 * The cause is the same for every kind of service; the words and the button
 * are the kind's. A file source never gets sign-in words, a saved-key source
 * says "Enter the key again".
 */
function kindSentence(
	status: ConnectionSetupStatus,
	cause: { sentence: string; known: boolean; credentialRejected?: boolean },
): string {
	if (!cause.known) return COULD_NOT_COPY;
	if (cause.credentialRejected && status.setup_kind === "static_secret") {
		return status.credential.credential_kind === "username_password"
			? `${cause.sentence} Check the username and password.`
			: `${cause.sentence.replace(/the sign-in\.$/, "that key.")} Check that all of the key was copied and that it has not expired.`;
	}
	return status.setup_kind === "manual_upload" &&
		/sign[- ]?in/i.test(cause.sentence)
		? COULD_NOT_COPY
		: cause.sentence;
}

function kindActionLabel(
	status: ConnectionSetupStatus,
	action: "Sign in again" | "Try again" | null,
): string | null {
	if (action === null) return null;
	if (status.setup_kind === "manual_upload") return "Choose another file";
	if (status.setup_kind === "static_secret" && action === "Sign in again")
		return savedSecretLabel(status);
	return action;
}

function plainGap(gap: KnownGap, name: string, status: ConnectionSetupStatus) {
	const cause = resolveSyncCause(
		{ error: gap.message, reason: gap.reason },
		name,
	);
	return {
		action: cause.known ? cause.action : null,
		needsPerson: cause.known && cause.needsPerson,
		sentence: kindSentence(status, cause),
	};
}

/**
 * Promise a retry only when a schedule will make it and the cause does not need
 * the person. No schedule at all: say so plainly. Schedule unknown: say nothing.
 */
function retryNote(
	name: string,
	schedule: ScheduleFacts | null | undefined,
	needsPerson: boolean,
	retryable: boolean,
): string | null {
	if (!retryable || needsPerson || schedule === undefined) return null;
	if (scheduleState(schedule).kind === "scheduled")
		return `It will try again the next time DataConnect checks ${name}.`;
	return `Nothing is scheduled for ${name}, so it will not try again by itself.`;
}

/** The raw text and codes live on the run's technical page; this is the way there. */
function technicalLink(runId: string | null | undefined): OutcomeLink | null {
	return runId
		? {
				href: `/syncs/${encodeURIComponent(runId)}/technical`,
				label: "Technical details",
			}
		: null;
}

export function firstSyncOutcome(
	status: ConnectionSetupStatus,
	name: string,
	facts: FirstSyncFacts,
): FirstSyncOutcome {
	const retryHref = setupHref(status);
	if (status.setup_state === "revoked")
		return {
			connectAgain: {
				href: `/sources/add?source_q=${encodeURIComponent(status.connector_id)}`,
				label: "Set up again",
			},
			kind: "revoked",
			note: "Your records stay.",
			open: { href: sourceRecordsHref(status), label: outcomeCopy.seeData(name) },
		};
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
		const cause = title
			? null
			: resolveSyncCause(
					{ connector_error: facts.connectorError, error: facts.failureReason, reason: status.last_error?.reason },
					name,
				);
		const technical = technicalLink(status.run?.run_id);
		const known = cause?.known === true;
		return {
			kind: "failed",
			technical,
			title,
			reason: stopped
				? "What was copied before you stopped is kept."
				: timedOut
					? "Nothing is lost. Start again when you're ready."
					: busy
						? ""
						: neverStarted ? `DataConnect could not open ${name}'s sign-in page.` : known ? kindSentence(status, cause) : outcomeCopy.failedFallback,
			retry: {
				href: retryHref,
				label: stopped
					? "Start again"
					: timedOut
						? `Sign in to ${name}`
						: (known ? kindActionLabel(status, cause.action) : null) ??
								retryLabel(status),
			},
			secondary:
				stopped && collectedKinds(facts).length > 0
					? {
							href: sourceRecordsHref(status),
							label: outcomeCopy.seeData(name),
						}
					: undefined,
			// With a run id the raw reason belongs to the technical page only; the
			// fold stays for a failure that has no run to link to.
			// The fold holds the server's plain remediation, never the raw reason code.
			wentWrong:
				title || technical ? null : plainRemediation(status.last_error?.remediation),
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
		(gap) => {
			const plain = plainGap(gap, name, status);
			return {
				action: plain.action,
				label: gap.stream ? sourceRecordLabel(gap.stream, facts.streams) : "Some data",
				// The service's own text and codes stay on the technical page. A cause we
				// know gets its plain sentence; any other gets one generic sentence.
				message: plain.sentence,
				retryNote: retryNote(name, facts.schedule, plain.needsPerson, gap.recovery_hint?.retryable === true),
				needsPerson: plain.needsPerson,
				retryable: gap.recovery_hint?.retryable === true,
			};
		},
	);
	// What the person can do: sign in again beats try again.
	const gapAction = missing.some((gap) => gap.action === "Sign in again")
		? "Sign in again"
		: missing.some((gap) => gap.action === "Try again")
			? "Try again"
			: null;
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
						needsPerson: previous.needsPerson || gap.needsPerson,
						retryNote: previous.retryNote ?? gap.retryNote,
						retryable: previous.retryable || gap.retryable,
					}
				: gap,
		);
	}
	const step =
		gapAction === "Sign in again"
			? kindActionLabel(status, gapAction) === "Sign in again"
				? "a new sign-in"
				: "the key again"
			: null;
	if (missing.length > 0)
		return {
			kind: "partial",
			step,
			collected,
			missing: [...missingByKind.values()].map(
				({ action: _action, ...gap }) => gap,
			),
			primary: {
				href: sourceRecordsHref(status),
				label: outcomeCopy.seeData(name),
			},
			retry: gapAction
				? { href: retryHref, label: kindActionLabel(status, gapAction) ?? gapAction }
				: missing.some((gap) => gap.retryable)
					? { href: retryHref, label: retryLabel(status) }
					: null,
			technical: technicalLink(status.run?.run_id),
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
			return outcomeCopy.partialHeadline(name, outcome.step);
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type AuthConfig } from "@pdpp/connector-protocol/auth";
import type { AssistanceCompletionStatus, AssistanceRequest, DetailCoverageMessage, DetailGapMessage, DetailGapNetworkPressure, DetailGapStartEntry, EmittedMessage, InteractionRequest, InteractionResponse, ProgressExtra, RecordData, StartMessage, StreamScope, ValidateRecord } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type { BrowserContext, Page } from "playwright";
import { prepareBrowserInteractionTarget, unregisterBrowserInteractionTarget } from "./browser-handoff.ts";
import { type CaptureSession } from "./fixture-capture.ts";
import { type EnsureSessionArgs, type ProbeSessionArgs, type SessionCheckpointFn } from "./session-establish.ts";
import { type TerminalErrorDetails } from "./terminal-error.ts";
export type { AssistanceAttachment, AssistanceAttachmentKind, AssistanceCompletion, AssistanceCompletionStatus, AssistanceOwnerAction, AssistanceProgressPosture, AssistanceRequest, AssistanceResponseContract, AssistanceSensitivity, AttachmentHydrationFailureOutcomeProgress, AttachmentRecoveryOutcomeProgress, CollectionRateProgress, DetailCoverageMessage, DetailGapAttemptedMessage, DetailGapMessage, DetailGapNetworkPressure, DetailGapRecoveredMessage, DetailGapStartEntry, EmittedMessage, InteractionKind, InteractionRequest, InteractionResponse, ProgressExtra, ProviderBudgetProgress, RecordData, ShapeAnomaly, StartMessage, StreamScope, ValidateRecord, } from "@pdpp/connector-protocol/connector-runtime-protocol";
export type { EnsureSessionArgs, ProbeSessionArgs, SessionCheckpointFn, } from "./session-establish.ts";
export type { TerminalErrorDetails } from "./terminal-error.ts";
/**
 * The one shared constructor for a connector-declared typed terminal
 * failure. Every connector that wants a stable `error.code` on its DONE
 * message (rather than relying purely on free-form, redacted `message`
 * text) should throw `createConnectorFailure(...)` instead of hand-rolling
 * `throw new Error(...)` or an ad hoc `{ code, message }` object — this is
 * the single point that validates `code` before it can ever reach the
 * unredacted `connector_error_code` column.
 *
 * `message` is ordinary human-readable free-form text: it still goes
 * through `boundConnectorErrorMessage`/`redactStderrTail` exactly like any
 * other connector-authored message, so it must never itself be treated as
 * safe — write it as you would write any other diagnostic string.
 */
export declare function createConnectorFailure(code: string, message: string, options?: {
    cause?: unknown;
    retryable?: boolean;
}): Error;
type Credentials = Record<string, string>;
interface EmitRecordOptions {
    skipResourceFilter?: boolean;
}
interface BaseCollectContext {
    assist: (req: AssistanceRequest) => Promise<string>;
    capture: CaptureSession | null;
    /**
     * Threaded from the START message's `collection_mode` field (already sent
     * on the wire by RI; this is the connector-runtime-side surfacing of it).
     * `"full_refresh"` is an explicit owner/operator bypass: a connector with
     * its own incremental bookkeeping (checkpoints, anchors, frontiers) MUST
     * ignore that bookkeeping for this run and walk each stream to its natural
     * end, providing a repair path for state a narrower incremental walk would
     * never revisit (e.g. a mutable field that changed further back than any
     * per-record change-detection window). Optional, matching `recoveryOnly`'s
     * precedent, so hand-built `CollectContext` literals elsewhere in the
     * codebase (tests, other connectors) that predate this field keep
     * compiling unchanged. A connector reading this MUST treat `undefined` the
     * same as `"incremental"` — the runtime's real construction site always
     * sets it explicitly (see `run()` below), so `undefined` only ever reaches
     * a connector via a test harness that hasn't been updated yet.
     */
    collectionMode?: "full_refresh" | "incremental";
    completeAssistance: (assistanceRequestId: string, status: AssistanceCompletionStatus, extra?: {
        message?: string;
    }) => Promise<void>;
    credentials: Credentials;
    detailGaps: readonly DetailGapStartEntry[];
    emit: (msg: EmittedMessage) => Promise<void>;
    emitRecord: (stream: string, data: RecordData, options?: EmitRecordOptions) => Promise<void>;
    emittedAt: string;
    progress: (message: string, extra?: ProgressExtra) => Promise<void>;
    /**
     * SLVP-ideal §4.3: when true, the connector MUST run its gap-recovery pass
     * then return before any forward walk / list-phase fetch. Threaded from the
     * START message's `recovery_only` field. Absent/false = ordinary full run —
     * optional so connectors that do not implement recovery-only ignore it.
     */
    recoveryOnly?: boolean;
    /**
     * Report a stream-level collection failure while allowing independent
     * streams to finish. The runtime emits bounded failure evidence immediately
     * and converts the eventual terminal DONE to `failed`; a connector must not
     * turn a failed stream into a successful run merely by returning from
     * `collect()`.
     *
     * Optional for compatibility with hand-built test contexts. The real runtime
     * always supplies it.
     */
    reportStreamFailure?: (stream: string, message: string, options?: {
        retryable?: boolean;
    }) => Promise<void>;
    requestDetailGapPage: (req?: {
        maxBytes?: number;
        streams?: readonly string[];
    }) => Promise<readonly DetailGapStartEntry[]>;
    requested: Map<string, StreamScope>;
    scope: StartMessage["scope"];
    sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
    state: Record<string, unknown>;
}
export interface CollectContext extends BaseCollectContext {
}
export interface BrowserCollectContext extends BaseCollectContext {
    browserSurface?: BrowserSurfaceRuntimeKind;
    context: BrowserContext;
    page: Page;
}
export interface BrowserConfig {
    /**
     * Preserve the run page after failed runs. Use only for sources where closing
     * a failed-but-authenticated page would destroy the best repair surface.
     */
    preservePageOnFailure?: boolean;
    /**
     * Reuse and preserve the run page after successful runs. Use only for
     * sources whose auth state is held in the live page instead of durable
     * browser storage.
     */
    preservePageOnSuccess?: boolean;
    profileName?: string;
}
export interface BrowserRuntimeVisibility {
    readonly envKey: string;
    readonly headless: boolean;
    readonly profileName: string;
}
export declare const BROWSER_HEADLESS_ENV = "PDPP_BROWSER_HEADLESS";
export type BrowserLaunchSource = {
    readonly kind: "managed_neko";
    readonly leaseId?: string;
    readonly profileKey?: string;
    readonly remoteCdpUrl: string;
} | {
    readonly envKey: string;
    readonly kind: "legacy_remote_cdp";
    readonly remoteCdpUrl: string;
} | {
    readonly kind: "isolated_local";
};
/**
 * Reference-runtime-only launch posture exposed to browser connectors for
 * privacy-safe structural diagnostics. It intentionally excludes URLs, lease
 * IDs, profile keys, and browser state; Collection Profile is unaffected.
 */
export type BrowserSurfaceRuntimeKind = BrowserLaunchSource["kind"];
export type NormalizeTerminalError = (error: TerminalErrorDetails) => TerminalErrorDetails;
/** Fields shared by browser and non-browser configs. */
interface BaseRunConnectorConfig {
    auth?: AuthConfig;
    /**
     * Opt in to treating a DECLINED `credentials` interaction as "no stored
     * credential" rather than a run-ending failure. Only for session-first
     * browser connectors that authenticate primarily through the owner's
     * browser profile and have an explicit absent-credential path in
     * `ensureSession`. Leave unset (the default) for anything that cannot
     * function without its secret — see `resolveCredentials`.
     */
    authOptional?: boolean;
    /** Marks a record as a tombstone; runtime strips to { id } + op:'delete'. */
    isTombstone?: (stream: string, data: RecordData) => boolean;
    name: string;
    normalizeTerminalError?: NormalizeTerminalError;
    /**
     * Optional post-commit hook. Runs ONLY on a successful run, AFTER the
     * runtime has acknowledged durable ingest (stdin EOF) and immediately
     * BEFORE process exit. Use it for local side effects that must not precede
     * a durable commit — e.g. reclaiming on-disk residue the connector does not
     * ingest. Never runs on a failed/interrupted run, so no cleanup can outrun
     * the commit receipt. Errors are swallowed (best-effort): a failed cleanup
     * must not turn a durably-committed run into a failure.
     *
     * MUST NOT call `emit`/`progress`/any stdout-JSONL write. By the time this
     * hook runs, the runtime has already consumed this run's DONE message and
     * torn down its message loop for this connector instance; any further
     * stdout JSONL (including PROGRESS) is parsed as "message after DONE" and
     * fails the ALREADY-SUCCEEDED run as `connector_protocol_violation` on the
     * next run's read of this one's exit, not a no-op. Use `logDurableCommit`
     * (stderr, outside the protocol channel) to report hook activity instead.
     */
    onDurableCommit?: (log: (message: string) => void) => void | Promise<void>;
    retryablePattern?: RegExp;
    /** Record field that scope.time_range filters on. Default 'date'. */
    timeRangeField?: string | ((stream: string) => string);
    validateRecord?: ValidateRecord;
}
/** Config for a non-browser connector (API, file-based). */
export interface NonBrowserConnectorConfig extends BaseRunConnectorConfig {
    browser?: undefined;
    collect: (ctx: CollectContext) => Promise<void>;
}
/** Config for a browser-driven connector. */
export interface BrowserConnectorConfig extends BaseRunConnectorConfig {
    browser: BrowserConfig;
    collect: (ctx: BrowserCollectContext) => Promise<void>;
    ensureSession?: (args: EnsureSessionArgs) => Promise<void>;
    probeSession?: (args: ProbeSessionArgs) => Promise<boolean>;
}
/**
 * Discriminated on `browser`: if it's set, `collect` gets page + context;
 * otherwise it doesn't. TS narrows the right way at each call site so
 * destructuring `{ page }` in a browser connector's collect() is type-safe.
 */
export type RunConnectorConfig = NonBrowserConnectorConfig | BrowserConnectorConfig;
type ClosableBrowserPage = Pick<Page, "close" | "isClosed">;
type ReusableBrowserPage = Pick<Page, "isClosed" | "url">;
/**
 * Compose a stable, infrastructure-set terminal-error `code` (e.g.
 * `browser_surface_attach_exhausted`, thrown by the runtime itself via
 * `TerminalError.code` — never a connector-authored message-parse result)
 * with whatever a connector's `normalizeTerminalError` returns.
 *
 * Every current connector normalizer (e.g. ChatGPT's
 * `normalizeChatGptTerminalError`) destructures only `{ message, retryable }`
 * and returns a fresh object, so an incoming infrastructure code is silently
 * dropped unless something restores it. That is data loss, not a deliberate
 * override — a connector never had the chance to see or reject the code it
 * never destructured.
 *
 * Precedence: if the connector's normalizer output ALREADY carries its own
 * `code` (e.g. ChatGPT's explicit `credential_rejected`), that choice is
 * deliberate and wins outright. The infrastructure code only backfills a
 * `code` field the normalized result left empty.
 *
 * Exported and pure so this composition rule is unit-testable without
 * driving the full `runConnector` process/stdio wiring.
 */
export declare function composeNormalizedTerminalError({ message, retryable, code, normalizeTerminalError, }: {
    message: string;
    retryable: boolean;
    code?: string | undefined;
    normalizeTerminalError: NormalizeTerminalError;
}): TerminalErrorDetails;
/**
 * Builds the message an UNEXPECTED (non-`TerminalError`) throw carries into
 * `DONE.error.message` -- an unexpected throw's own `.message` alone is
 * sometimes a generic, contentless string (imapflow's `'Command failed'`
 * for every IMAP NO/BAD response) while the real explanation sits on a
 * side field the generic catch previously never looked at. Bounded so a
 * pathological response body can't bloat the terminal DB row; must never
 * include credential material (see `extractKnownErrorDetail`'s doc comment
 * on why `executedCommand` is already redacted at the source).
 */
export declare function describeUnexpectedFailure(err: unknown): string;
/**
 * Inputs for a per-run detail coverage report. A list+detail connector passes
 * the keys it considered for detail (`requiredKeys`, the denominator) and the
 * subset it hydrated (`hydratedKeys`, the numerator), so the console can tell a
 * partial run from a complete one without inferring it from gaps.
 */
export interface DetailCoverageParams {
    /**
     * Optional explicit `considered` denominator: how many items the run weighed
     * for this stream (the source inventory or boundary it enumerated). When
     * present it is preferred over `requiredKeys.length` so a list stream that has
     * no detail-hydration phase can still declare partial-vs-complete by passing
     * empty `requiredKeys`/`hydratedKeys` and a measured `considered` count. It
     * MUST be measured independently at the enumeration site, never aliased to the
     * collected/emitted count — the runtime never infers it from collected.
     */
    considered?: number;
    /**
     * Optional explicit `covered` count: how many of the `considered` in-boundary
     * items the run accounted for — the items it emitted plus the items it
     * deliberately suppressed as unchanged (a full-sync stream gated by a per-record
     * fingerprint). When present, the projection compares `considered` against
     * `covered` instead of the collected count, so a steady-state run that suppressed
     * every unchanged record reads `complete` rather than a false `partial`. It MUST
     * be measured at the enumeration site from objective per-record outcomes
     * (emitted, or suppressed-because-unchanged) and MUST NOT count a weighed-but-
     * dropped item — a dropped item is in neither the collected nor the covered
     * count, so it still reads `partial`. Never aliased to the collected count.
     */
    covered?: number;
    /** Keys for which a DETAIL_GAP was emitted and should be retried next run. */
    gapKeys?: ReadonlyArray<string | number>;
    /** Subset of requiredKeys whose detail was fetched and emitted. */
    hydratedKeys: ReadonlyArray<string | number>;
    /** Keys skipped by explicit policy, such as selection scope. */
    optionalSkipKeys?: ReadonlyArray<string | number>;
    /** Full set of keys considered for detail fetch this run. */
    requiredKeys: ReadonlyArray<string | number>;
    /** The list/parent stream whose cursor anchors the detail pass. */
    stateStream: string;
    /** The detail stream the coverage report describes. */
    stream: string;
}
/**
 * Build one parent-boundary DETAIL_COVERAGE message after that detail work
 * settles. A shared detail stream emits one message per independently
 * checkpointed parent. Pure: the caller owns when/whether to emit. Empty
 * optional key sets are omitted so a fully hydrated boundary carries no gap
 * fields.
 */
export declare function buildDetailCoverageMessage(params: DetailCoverageParams): DetailCoverageMessage;
/**
 * Build the self-coverage DETAIL_COVERAGE for a full-scan stream: one whose
 * whole boundary is re-enumerated every run and which has no separate detail
 * hydration phase, so the key sets stay empty and `stream === state_stream`.
 *
 * `considered` is the enumerated boundary size, measured at the enumeration
 * site — never the emitted count (see `DetailCoverageParams.considered`). Every
 * in-boundary item is either emitted or suppressed as unchanged, so `covered`
 * equals `considered` and a steady-state run reads covered rather than a false
 * `partial`. A successful enumeration that found nothing declares
 * `considered === covered === 0`: proven-empty is a fact, and it is the only
 * way an empty stream can prove coverage rather than merely lack evidence.
 *
 * The caller owns when to emit, and MUST emit only on a successful
 * enumeration — a fetch or parse failure never proves an empty boundary.
 */
export declare function buildFullScanCoverageMessage(stream: string, considered: number): DetailCoverageMessage;
/**
 * Thin emit wrapper for connectors adopting the detail coverage contract. `ctx`
 * is structural so both the collect context and connector-local dependency bags
 * can use it without importing a heavier runtime type.
 */
export declare function emitDetailCoverage(ctx: {
    emit: (msg: EmittedMessage) => Promise<void>;
}, params: DetailCoverageParams): Promise<void>;
/**
 * Bounded error context for a recoverable detail gap. The same fields feed both
 * the `detail` and `last_error` blocks on the emitted `DETAIL_GAP` — connectors
 * built one identical copy for each by hand, which this helper centralizes.
 *
 * The helper copies these fields onto the wire verbatim; it does NOT redact
 * them. The connector is responsible for passing only safe, bounded values: a
 * connector-chosen error class, an optional HTTP status, an optional human
 * message, and an optional pre-redacted `network_pressure` diagnostic. Do NOT
 * pass bearer tokens, cookies, secret-bearing URLs, request bodies, or raw
 * payloads. In particular, the helper does not strip the attempt/max-attempt
 * budget from `network_pressure` — redact it at the source before passing it
 * here (see ChatGPT's `omitAttemptBudget`). Downstream the runtime applies the
 * same redaction policy as `known_gaps` / `SKIP_RESULT.diagnostics`, but the
 * connector is the only line of redaction inside this helper.
 */
export interface DetailGapErrorContext {
    /** Connector-chosen error class (e.g. `upstream_pressure`, the deferred class). */
    class: string;
    /** Optional upstream HTTP status that triggered the gap. */
    httpStatus?: number;
    /** Optional human-readable message. Carried on `last_error` only — the protocol's `detail` block has no `message` field. */
    message?: string;
    /** Pre-redacted network-pressure diagnostic (endpoint route, method, error class). Copied verbatim — redact at the source. */
    networkPressure?: DetailGapNetworkPressure;
}
/**
 * Inputs for a recoverable `DETAIL_GAP` — a per-record marker that detail for
 * `recordKey` could not be hydrated this run but is expected to be retried. The
 * shape mirrors `DetailCoverageParams`: the caller owns when to emit; the helper
 * owns the fixed reference-only / retryable / pending shape so connectors stop
 * hand-rolling it.
 *
 * `stream`, `recordKey`, `reason`, and `locator` are required. `parentStream`,
 * `listCursor`, and `error` are optional, first-class `DETAIL_GAP` protocol
 * fields and are omitted from the message when absent — a gap with no error
 * context carries neither `detail` nor `last_error` (matching connectors such as
 * USAA's statement gaps), and a flat detail stream carries no `parent_stream`.
 *
 * Only the source-pressure reasons (`rate_limited`, `upstream_pressure`) feed the
 * cross-run source-pressure cooldown governor; `retry_exhausted` and
 * `temporary_unavailable` record a resumable gap without arming a cooldown.
 */
export interface DetailGapParams {
    /** Optional bounded error context fanned into `detail` and `last_error`. Omit both blocks when absent. */
    error?: DetailGapErrorContext;
    /** Optional opaque cursor the next run uses to resume the parent list at this gap. */
    listCursor?: DetailGapMessage["list_cursor"];
    /** Locator the next run uses to re-hydrate this record's detail. */
    locator: DetailGapMessage["detail_locator"];
    /** Optional list/parent stream this detail stream hangs off (e.g. `accounts` for `transactions`). */
    parentStream?: string;
    /** Why detail could not be hydrated; drives retryability and any cooldown. */
    reason: DetailGapMessage["reason"];
    /** Key of the record whose detail is gapped. */
    recordKey: string | number;
    /** The detail stream the gap belongs to. */
    stream: string;
}
/**
 * Build a recoverable `DETAIL_GAP` message. Pure: the caller owns when/whether to
 * emit. The fixed reference-only shape (`status: "pending"`, `retryable: true`,
 * `reference_only: true`) is centralized here so a connector states only what
 * varies. Optional protocol fields (`parent_stream`, `list_cursor`, `detail`,
 * `last_error`) are omitted from the wire message when their input is absent, so
 * a minimal gap carries no empty blocks. When `error` is supplied, the `detail`
 * and `last_error` blocks share the same class / http_status / network_pressure;
 * `error.message` (if any) is added to `last_error` only, since the protocol's
 * `detail` block has no `message` field.
 */
export declare function buildDetailGap(params: DetailGapParams): DetailGapMessage;
/**
 * Thin emit wrapper for connectors adopting the detail-gap contract. `ctx` is
 * structural so both the collect context and connector-local dependency bags can
 * use it without importing a heavier runtime type. Mirrors `emitDetailCoverage`.
 */
export declare function emitDetailGap(ctx: {
    emit: (msg: EmittedMessage) => Promise<void>;
}, params: DetailGapParams): Promise<void>;
export declare const nowIso: () => string;
/**
 * Intentional pacing delay for anti-bot throttling between requests.
 * Distinct from Playwright's sync primitives (waitForSelector, waitForURL)
 * which wait for a page condition. This one is "slow us down so we look
 * human", not "wait until X is ready". See authoring guide §7.
 */
export declare const politeDelay: (ms: number) => Promise<void>;
/**
 * Run a connector end-to-end. The only entry point connectors should use.
 */
export declare function runConnector(config: RunConnectorConfig): void;
/**
 * Resolve credentials via the configured auth strategy.
 *
 * When `authOptional` is set, a missing credential is a supported state rather
 * than a run-ending failure: the connector authenticates through the owner's
 * browser profile and treats a stored username/password as an optional
 * auto-login shortcut. Present credentials are used exactly as before; absent
 * ones resolve to an empty set WITHOUT ever prompting.
 *
 * Root cause history. 6f6765bbb (2026-08-26) fixed half of this: it stopped a
 * declined prompt from failing the run. But it caught the failure AFTER the
 * `env` strategy had already opened the `credentials` interaction and awaited
 * it — it suppressed the ERROR, not the PROMPT. Live prod run
 * run_1788004675387 showed the remaining half: the run leased and readied a
 * browser surface, then immediately emitted a `credentials` interaction. The
 * repair page put a username/password form in front of the owner, which is
 * unanswerable for a Google-SSO account and blocks the required journey
 * (repair page -> run -> streamed browser -> owner completes SSO there).
 * A scheduled run has nobody to answer it at all.
 *
 * The flag is now threaded into `AuthStrategyContext` so the strategy returns
 * before asking, rather than being talked out of the answer afterwards. The
 * post-hoc catch below is retained deliberately: it still covers a strategy
 * that reaches the missing-credential branch by another route, and it keeps
 * this behavior pinned if an older protocol build is ever installed.
 *
 * Narrowly scoped on purpose: only connectors that opt in are affected, and
 * only the credential question is skipped — an `assist`/`manual_action`
 * interaction from the same run still reaches the owner, which is what the
 * browser login depends on. Every OTHER auth failure
 * (`auth_env_required_missing`, `auth_strategy_unknown`, a strategy's own
 * throw) still fails the run closed, and connectors that never set
 * `authOptional` — every API connector, e.g. github/ynab/notion — keep the
 * unchanged prompt-then-fail-closed behavior rather than proceeding
 * token-less.
 */
export declare function resolveCredentials(auth: AuthConfig | undefined, ctx: {
    sendInteraction: BaseCollectContext["sendInteraction"];
    connectorName: string;
    authOptional: boolean;
}): Promise<Credentials>;
interface BrowserSurfaceAssistanceLifecycleDependencies {
    readonly assist: BaseCollectContext["assist"];
    readonly completeAssistance: BaseCollectContext["completeAssistance"];
    readonly nextAssistanceRequestId: () => string;
    readonly page: Page;
    readonly prepareTarget?: typeof prepareBrowserInteractionTarget;
    readonly unregisterTarget?: typeof unregisterBrowserInteractionTarget;
}
/**
 * Keep the streamed-page target's lifecycle coupled to the structured
 * assistance request. This is deliberately separate from session logic: a
 * failed readiness probe must still terminally close the assistance and free
 * the target before its error reaches the run lifecycle.
 */
export declare function createBrowserSurfaceAssistanceLifecycle({ assist, completeAssistance, nextAssistanceRequestId, page, prepareTarget, unregisterTarget, }: BrowserSurfaceAssistanceLifecycleDependencies): {
    assist: BaseCollectContext["assist"];
    close: () => Promise<void>;
    complete: BaseCollectContext["completeAssistance"];
};
export declare function isReusableBrowserRunPage(page: ReusableBrowserPage): boolean;
export declare function selectBrowserPageForRun(context: Pick<BrowserContext, "newPage" | "pages">, browser: Pick<BrowserConfig, "preservePageOnFailure" | "preservePageOnSuccess">): Promise<Page>;
export declare function shouldCloseBrowserPageAfterRun(browser: Pick<BrowserConfig, "preservePageOnFailure" | "preservePageOnSuccess">, runSucceeded: boolean, env?: NodeJS.ProcessEnv): boolean;
export declare function captureBrowserPage(capture: CaptureSession | null, page: Page, label: string, deadlineMs?: number): Promise<void>;
export declare function closeBrowserContextPagesExcept(context: {
    pages: () => ClosableBrowserPage[];
}, keepPage: ClosableBrowserPage, deadlineMs?: number): Promise<number>;
export declare function closeBrowserPage(page: ClosableBrowserPage | null, deadlineMs?: number): Promise<boolean>;
interface BrowserSurfaceDiagnosticContext {
    browser: BrowserContext["browser"];
    pages?: BrowserContext["pages"];
}
export declare function makeBrowserInteractionKeepalive(args: {
    context: BrowserSurfaceDiagnosticContext;
    diagnostics?: boolean;
    intervalMs?: number;
    progress?: BaseCollectContext["progress"];
    sendInteraction: BaseCollectContext["sendInteraction"];
}): BaseCollectContext["sendInteraction"];
export declare function resolveBrowserRuntimeVisibility(browser: BrowserConfig, name: string, env?: NodeJS.ProcessEnv): BrowserRuntimeVisibility;
export declare function resolveBrowserLaunchSource(visibility: Pick<BrowserRuntimeVisibility, "profileName">, env?: NodeJS.ProcessEnv): BrowserLaunchSource;
export declare function decorateBrowserManualAction(req: InteractionRequest, visibility: BrowserRuntimeVisibility): InteractionRequest;
export interface SessionEstablishWatchdog {
    checkpoint: SessionCheckpointFn;
    /** Run the establishment work under the watchdog; rejects with TerminalError on trip. */
    run: (work: () => Promise<void>) => Promise<void>;
    /** Wrap nonblocking assistance so external owner waits pause the watchdog. */
    wrapAssist: (assist: BaseCollectContext["assist"]) => BaseCollectContext["assist"];
    /** Re-arm the watchdog when a nonblocking assistance wait is resolved/escalated. */
    wrapCompleteAssistance: (completeAssistance: BaseCollectContext["completeAssistance"]) => BaseCollectContext["completeAssistance"];
    /** Wrap a sendInteraction so the watchdog is paused while an interaction is open. */
    wrapSendInteraction: (send: BaseCollectContext["sendInteraction"]) => BaseCollectContext["sendInteraction"];
}
export declare function resolveSessionEstablishWatchdogMs(env?: NodeJS.ProcessEnv): number;
/**
 * Build a session-establishment watchdog. Exposed (with injectable `deadlineMs`,
 * `now`, `pollIntervalMs`, and `onTrip`) so tests can drive it deterministically
 * without real-time sleeps.
 */
export declare function makeSessionEstablishWatchdog(args: {
    capture: CaptureSession | null;
    deadlineMs?: number;
    name: string;
    now?: () => number;
    page: Page;
    pollIntervalMs?: number;
    /** Hook fired exactly once when the watchdog trips, before the run rejects. */
    onTrip?: (info: {
        lastLabel: string | null;
        sinceMs: number;
    }) => void;
    /** Optional durable progress channel so each checkpoint phase reaches the
     *  timeline, not just the opt-in capture directory. */
    progress?: (message: string) => Promise<void> | void;
}): SessionEstablishWatchdog;
interface Tracer {
    checkpoint: (label: string) => Promise<void>;
    markSucceeded: () => void;
    start: () => Promise<void>;
    stop: () => Promise<void>;
}
/**
 * Best-effort check that the underlying browser is still connected.
 * Patchright exposes `context.browser()?.isConnected()`; we tolerate any
 * shape by treating an unknown answer as "connected" so this guard never
 * silently disables a working trace stop.
 */
export declare function isContextDisconnected(context: Pick<BrowserContext, "browser">): boolean;
/**
 * Start/stop Playwright tracing. With raw fixture capture active, traces are
 * flushed as chunks at every fixture checkpoint so a later browser/context
 * closure does not destroy the entire diagnostic artifact.
 *
 * Storage note: traces with screenshots+snapshots+sources can be 20–100 MB per
 * run. To keep the on-disk footprint bounded, written trace chunks are deleted
 * after a clean run (markSucceeded() called before stop()) and retained on
 * failure for post-mortem debugging.
 *
 * CREDENTIAL SAFETY — why a trace is DISCARDED once secrets are registered.
 *
 * A real owner password was recovered from 8 of 14 trace zips in one Venmo
 * run. The bytes sat in the `trace.trace` entry, and because a trace is a ZIP,
 * a plain `grep` over the file found nothing — the leak was invisible to the
 * obvious check.
 *
 * The value does NOT arrive via DOM snapshots. Playwright's action recorder
 * writes each call's PARAMETERS, so `page.fill(selector, password)` is logged
 * as `{"method":"fill","params":{"value":"<password>"}}` plus an echoing
 * `{"type":"log","message":"fill(\"<password>\")"}`. Measured against
 * Playwright 1.62.1: with `snapshots:false, screenshots:false, sources:false`
 * the password still appeared 4 times in `trace.trace`.
 *
 * That rules out the two tempting fixes:
 *   - Tracing options cannot help. `screenshots`/`snapshots`/`sources` are the
 *     only knobs `tracing.start()` has, and none governs action parameters.
 *   - Rewriting the zip afterwards would still write the credential to disk
 *     first, and chunks land at EVERY checkpoint, so the plaintext would sit
 *     in the capture directory for the whole run before any cleanup ran.
 *
 * So a run that touched a credential does not get to keep a trace. Traces are
 * still recorded (an in-flight trace is what makes chunking possible) and are
 * still fully retained for runs that never register a secret — which is every
 * API-only connector and every browser run that reuses a stored session.
 */
export declare function makeTracer(context: BrowserContext, name: string, capture: CaptureSession | null): Tracer;
//# sourceMappingURL=connector-runtime.d.ts.map
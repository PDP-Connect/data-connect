// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser presentation policy, version 1.
 *
 * The policy says how a connector browser is presented before any browser
 * process starts: which engine mode runs, which display it renders on, whether
 * a native window can reach the owner's desktop, and where the owner
 * interacts with it. The process owner (the desktop host, or a local
 * launcher) validates the policy and refuses it before spawn if it is invalid
 * or not executable there.
 *
 * The wire form is shared with the desktop host
 * (`src-tauri/src/commands/browser_presentation.rs`). Both parsers read the
 * same conformance cases in `browser-presentation-policy.fixtures.json` and
 * must give each case the same verdict and error code.
 *
 * An absent policy keeps the legacy behavior: the `headless` flag alone
 * decides the engine mode and the browser uses the inherited display.
 */

export const BROWSER_PRESENTATION_POLICY_VERSION = 1;

export const BROWSER_ENGINE_MODES = ["headed", "headless"] as const;
export const BROWSER_DISPLAY_BACKENDS = [
	"inherited-host",
	"private-xvfb",
	"externally-owned",
] as const;
export const BROWSER_NATIVE_VISIBILITIES = [
	"normal",
	"isolated-display",
	"no-window",
] as const;
export const BROWSER_INTERACTION_PRESENTATIONS = [
	"companion",
	"native",
] as const;
/** v1 has no continuation onto the owner's desktop: display failure fails the launch. */
export const BROWSER_PRESENTATION_FALLBACKS = ["fail-closed"] as const;

export type BrowserEngineMode = (typeof BROWSER_ENGINE_MODES)[number];
export type BrowserDisplayBackend = (typeof BROWSER_DISPLAY_BACKENDS)[number];
export type BrowserNativeVisibility =
	(typeof BROWSER_NATIVE_VISIBILITIES)[number];
export type BrowserInteractionPresentation =
	(typeof BROWSER_INTERACTION_PRESENTATIONS)[number];
export type BrowserPresentationFallback =
	(typeof BROWSER_PRESENTATION_FALLBACKS)[number];

export interface BrowserPresentationPolicy {
	readonly display_backend: BrowserDisplayBackend;
	readonly engine_mode: BrowserEngineMode;
	readonly fallback: BrowserPresentationFallback;
	readonly interaction_presentation: BrowserInteractionPresentation;
	readonly native_visibility: BrowserNativeVisibility;
	readonly version: typeof BROWSER_PRESENTATION_POLICY_VERSION;
}

export type BrowserPresentationPolicyErrorCode =
	| "invalid_combination"
	| "invalid_shape"
	| "unsupported_version";

export class BrowserPresentationPolicyError extends Error {
	readonly code: BrowserPresentationPolicyErrorCode;

	constructor(code: BrowserPresentationPolicyErrorCode, message: string) {
		super(message);
		this.name = "BrowserPresentationPolicyError";
		this.code = code;
	}
}

const FIELDS = [
	"version",
	"engine_mode",
	"display_backend",
	"native_visibility",
	"interaction_presentation",
	"fallback",
] as const;

/**
 * Parse and validate a policy value. The version is checked first, so a
 * newer policy with fields v1 does not know is reported as an unsupported
 * version rather than a malformed v1 policy.
 */
export function parseBrowserPresentationPolicy(
	value: unknown,
): BrowserPresentationPolicy {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new BrowserPresentationPolicyError(
			"invalid_shape",
			"presentation policy must be a JSON object",
		);
	}
	const record = value as Record<string, unknown>;
	const version = record.version;
	if (typeof version !== "number") {
		throw new BrowserPresentationPolicyError(
			"invalid_shape",
			"presentation policy version must be a number",
		);
	}
	if (version !== BROWSER_PRESENTATION_POLICY_VERSION) {
		throw new BrowserPresentationPolicyError(
			"unsupported_version",
			`presentation policy version ${version} is not supported; expected ${BROWSER_PRESENTATION_POLICY_VERSION}`,
		);
	}
	for (const key of Object.keys(record)) {
		if (!(FIELDS as readonly string[]).includes(key)) {
			throw new BrowserPresentationPolicyError(
				"invalid_shape",
				`unknown presentation policy field ${key}`,
			);
		}
	}
	const policy: BrowserPresentationPolicy = {
		display_backend: readEnum(
			record,
			"display_backend",
			BROWSER_DISPLAY_BACKENDS,
		),
		engine_mode: readEnum(record, "engine_mode", BROWSER_ENGINE_MODES),
		fallback: readEnum(record, "fallback", BROWSER_PRESENTATION_FALLBACKS),
		interaction_presentation: readEnum(
			record,
			"interaction_presentation",
			BROWSER_INTERACTION_PRESENTATIONS,
		),
		native_visibility: readEnum(
			record,
			"native_visibility",
			BROWSER_NATIVE_VISIBILITIES,
		),
		version: BROWSER_PRESENTATION_POLICY_VERSION,
	};
	const conflict = presentationPolicyConflict(policy);
	if (conflict) {
		throw new BrowserPresentationPolicyError("invalid_combination", conflict);
	}
	return policy;
}

/** Parse the JSON text of `PDPP_BROWSER_PRESENTATION_POLICY`; blank means no policy. */
export function parseBrowserPresentationPolicyEnv(
	value: string | undefined,
): BrowserPresentationPolicy | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new BrowserPresentationPolicyError(
			"invalid_shape",
			"PDPP_BROWSER_PRESENTATION_POLICY must be a JSON presentation policy",
		);
	}
	return parseBrowserPresentationPolicy(parsed);
}

/**
 * The combination rules. Keep them in step with `conflict()` in
 * `browser_presentation.rs`; the shared fixtures prove both agree.
 */
function presentationPolicyConflict(
	policy: BrowserPresentationPolicy,
): string | null {
	if (policy.engine_mode === "headless") {
		if (policy.display_backend !== "inherited-host") {
			return "a headless browser needs no display, so display_backend must be inherited-host";
		}
		if (policy.native_visibility !== "no-window") {
			return "a headless browser has no native window, so native_visibility must be no-window";
		}
		if (policy.interaction_presentation !== "companion") {
			return "a headless browser can only be reached through the companion";
		}
		return null;
	}
	if (policy.native_visibility === "no-window") {
		return "a headed browser always has a native window";
	}
	if (policy.display_backend === "inherited-host") {
		if (policy.native_visibility !== "normal") {
			return "v1 has no adapter that hides a window on the owner's desktop";
		}
		return null;
	}
	if (policy.native_visibility !== "isolated-display") {
		return `display_backend ${policy.display_backend} renders on an isolated display`;
	}
	if (policy.interaction_presentation !== "companion") {
		return "the owner cannot see an isolated display, so interaction must use the companion";
	}
	return null;
}

/** The legacy headless flag a policy implies, sent alongside it for old hosts. */
export function presentationPolicyHeadless(
	policy: BrowserPresentationPolicy,
): boolean {
	return policy.engine_mode === "headless";
}

function readEnum<const Values extends readonly string[]>(
	record: Record<string, unknown>,
	field: (typeof FIELDS)[number],
	values: Values,
): Values[number] {
	const value = record[field];
	if (typeof value !== "string" || !values.includes(value)) {
		throw new BrowserPresentationPolicyError(
			"invalid_shape",
			`presentation policy ${field} must be one of ${values.join(", ")}`,
		);
	}
	return value as Values[number];
}

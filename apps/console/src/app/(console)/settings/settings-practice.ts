// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { OwnerSessionInventory } from "./owner-sessions-data.ts";
import type { requestReachability } from "./reachability-client.ts";
import { publicError } from "./reachability-errors.ts";

export const settingsPracticeNames = [
	"desktop-fresh",
	"browser-desktop",
	"server",
	"server-address",
	"off",
	"password",
	"choose",
	"turning-on",
	"service-sign-in",
	"typed-step",
	"on-public",
	"on-private",
	"failed-service",
	"failed-configuration",
	"lost-address",
	"off-unconfirmed",
	"sessions-two",
	"sessions-thirteen",
	"recovery-asking",
	"recovery-wrong",
	"recovery-no-password",
	"recovery-shown",
] as const;
export type SettingsPracticeName = (typeof settingsPracticeNames)[number];

// Inputs copy the public projections used by the host, not a second card UI.
export function buildSettingsPractice(
	name: string,
	environment = process.env.NODE_ENV,
) {
	if (
		environment === "production" ||
		!settingsPracticeNames.includes(name as SettingsPracticeName)
	)
		return null;
	const now = Date.now();
	const iso = (offset: number) => new Date(now + offset).toISOString();
	const privateRoute = name === "on-private";
	const providerId = privateRoute
		? "tailscale-private"
		: name === "typed-step"
			? "ngrok-https-edge"
      : name === "service-sign-in" ? "tailscale-funnel" : "localhost-run";
	const provider = {
		providerId,
		label: providerId.startsWith("tailscale-")
			? "Tailscale"
			: providerId === "ngrok-https-edge"
				? "ngrok"
				: "Temporary address",
		reach: privateRoute ? "tailnet" : "internet",
		transport: "https_tunnel",
		availability: { session: { state: "available", reason: "admitted" } },
		configuration: {
			revision: "practice-1",
			actions: [],
			inputRequirements: [],
			values: {},
			credentials: {},
		},
		facts: [],
		prerequisites: providerId.startsWith("tailscale-") ? [{ id: "local-setup", state: "unknown", version: { known: false, reason: "not-observed" }, observedAt: null }] : [],
	};
	const catalog = {
		catalogRevision: "practice-1",
		observedAt: iso(0),
		schemaVersion: 1,
		providers: [
			provider,
			{
				...provider,
				providerId: "ngrok-tls-passthrough",
				label: "ngrok",
				availability: {
					session: { state: "unsupported", reason: "not-installed" },
				},
			},
		],
	};
	const operation = {
		operationId: "practice-operation",
		kind: "start",
		stage: "applying",
		recovery: null,
		failureCode: null as string | null,
	};
	if (name === "failed-service" || name === "failed-configuration")
		Object.assign(operation, {
			stage: "failed",
			failureCode:
				name === "failed-service"
					? "provider_unavailable"
					: "configuration_stale",
		});
	if (name === "lost-address")
		Object.assign(operation, { stage: "unknown-possibly-live" });
	if (name === "off-unconfirmed")
		Object.assign(operation, {
			kind: "stop",
			stage: "failed",
			failureCode: "cleanup_unconfirmed",
			recovery: { available: true, reason: "cleanup_unconfirmed" },
		});
	const hasOperation = [
		"turning-on",
		"failed-service",
		"failed-configuration",
		"lost-address",
		"off-unconfirmed",
	].includes(name);
	const hasSetup = name === "service-sign-in" || name === "typed-step";
	const stepSentence = name === "typed-step" ? "DataConnect keeps this token on this computer." : "Sign in to continue.";
	const action = {
		id: name === "typed-step" ? "auth" : "tailscale-browser",
		kind: name === "typed-step" ? "provide-secret" : "open-url",
		label:
			name === "typed-step"
				? "Provide your ngrok details"
				: "Sign in to Tailscale",
		secretLabel: "ngrok agent authtoken",
		digest: "practice-digest",
		href: "https://login.example.test/sign-in",
		disclosure: { revision: "1", text: stepSentence, links: [] },
    consent: { facts: [], consentFactsDigest: "practice-facts", scope: { kind: "setup", providerId, actionDigest: "practice-digest", actionId: name === "typed-step" ? "auth" : "tailscale-browser", disclosureRevision: "1" }, disclosures: { action: { disclosure: { revision: "1", text: stepSentence, links: [] } } } },
		step: {
			actor: "owner",
			browser: { expiresAt: iso(600_000), pollAfterMs: 2000 },
		},
	};
	const setupView = {
		operationId: "practice-setup",
		revision: 1,
		state: name === "typed-step" ? "authorization-required" : "pending",
		resources: [],
		evidence: { known: false },
		scope: { draftId: "practice-draft", configurationRevision: "practice-1" },
		nextAction: action,
	};
	const route = {
		providerId,
		approvedConsentFactsDigest: "practice-digest",
		handle: { id: "practice-route", generation: 1, kind: "session" },
		origin: "https://maple.example.test",
		published: "https://maple.example.test",
		routeState: "verified",
		state: "usable",
		binding: {
			authority: "host",
			remedy: null,
			target: { known: true, value: "127.0.0.1:37807" },
		},
		hostConfiguration: { target: { known: true, value: "127.0.0.1:37807" } },
		cleanup: { state: "none", nextAction: null },
		expiresAt: { known: true, value: iso(3_600_000) },
		facts: [],
		verification: {
			status: "verified",
			vantage: privateRoute ? "private" : "public",
			observedAt: iso(0),
			validUntil: { known: true, value: iso(3_600_000) },
		},
	};
	const state = {
		routes: name === "off-unconfirmed" ? [{ ...route, cleanup: { state: "unconfirmed", nextAction: null } }] : name.startsWith("on-") ? [route] : [],
    ...(name === "off-unconfirmed" ? { lifecycle: { phase: "stopping", stopRequested: true, cleanup: "unconfirmed", confinement: { known: false }, handle: route.handle } } : {}),
		reasons: {},
		starting: name === "turning-on",
		passwordSet: !["desktop-fresh", "password"].includes(name),
		operations: hasOperation && name !== "off-unconfirmed" ? [operation] : [],
		services: hasSetup
			? [
					{
						providerId,
						providerLabel: name === "typed-step" ? "ngrok" : "Tailscale",
						draftId: "practice-draft",
						usage: "session",
						committed: false,
						setup: {
							operationId: "practice-setup",
							actionId: action.id,
							expectedConfigurationRevision: "practice-1",
						},
					},
				]
			: [],
	};
  const draft = { draftId: "practice-draft", providerId, usage: "session", configuration: provider.configuration };
  const candidate = {
    providerId, display: { label: provider.label }, consentFactsDigest: "practice-facts", facts: [],
    consent: { scope: { kind: "route", query: { usage: { kind: "session" } } }, facts: [], consentFactsDigest: "practice-facts", disclosures: {} },
    disclosures: {},
  };
	const request: typeof requestReachability = async (path, body) => {
		if (path === "/catalog") return { ok: true, data: catalog };
		if (path === "/state") return { ok: true, data: state };
		if (path === "/host-settings")
			return {
				ok: true,
				data: {
					known: true,
					value: {
						password: { known: true, value: true },
						port: { known: true, value: 37807 },
						target: { known: true, value: "127.0.0.1:37807" },
					},
				},
			};
		if (path === "/host-capabilities")
			return { ok: true, data: { session: { known: true, value: true } } };
    if (path === "/drafts" || path.startsWith("/drafts/practice-draft?")) return { ok: true, data: draft };
    if (path === "/drafts/practice-draft/commit") return { ok: true, data: draft.configuration };
    if (path === "/drafts/practice-draft/review") return { ok: true, data: { id: "practice-review", kind: "route", candidate } };
		if (path.startsWith("/setup-operations/"))
			return { ok: true, data: setupView };
		if (path.startsWith("/operations/")) return { ok: true, data: operation };
		// Practice mutations never reach a server or create an external connection.
		if (body) return { ok: false, ...publicError("unsupported") };
		return { ok: true, data: {} };
	};
	const count = name === "sessions-thirteen" ? 13 : 2;
	const inventory: OwnerSessionInventory = {
		enabled: true,
		bearers: [],
		sessions: Array.from({ length: count }, (_, index) => ({
			id: `practice${String(index).padStart(8, "0")}`,
			label: "Chrome on Linux",
			current: index === 1,
			createdAt: Math.floor(now / 1000) - 86400,
			lastSeenAt: Math.floor(now / 1000) - index * 840,
			ipAddress: index ? "192.168.1.20" : "8.8.8.8",
		})),
	};
	const expect =
		name === "password" || name === "desktop-fresh"
			? /Choose your own password/
			: name === "turning-on"
				? /Connecting|Checked this computer/
				: name === "lost-address"
					? /lost track/
					: name === "off-unconfirmed"
						? /may still|lost track/
						: name.startsWith("failed-")
							? /did not turn on/
							: name.startsWith("on-")
								? /Your address|On/
								: hasSetup
									? /Sign in|ngrok/
									: /Off/;
	return {
		name,
		request,
		inventory,
		managedDesktop: !name.startsWith("server"),
		revealProof: name !== "browser-desktop",
		recoveryState: name.startsWith("recovery-")
			? (name.slice("recovery-".length) as "asking" | "wrong" | "no-password" | "shown")
			: undefined,
		passwordSource: name.startsWith("server")
			? ("env" as const)
			: ("desktop" as const),
		passwordSet: state.passwordSet,
		publicAddress:
			name === "server-address" ? "https://maple.example.test" : null,
		expect,
	};
}

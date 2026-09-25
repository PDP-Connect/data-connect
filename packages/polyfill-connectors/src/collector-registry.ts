// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry of connectors that support PDPP local (device-side) collection.
 *
 * This is the single source of truth for *which* connectors participate in
 * local collection and *how* — assembled from each connector's own
 * {@link LocalCollectorDefinition}. It intentionally lives in
 * `@pdpp/polyfill-connectors` (which owns the connectors), not in the generic
 * `@pdpp/local-collector` runtime: the connector defines its collector; the
 * runtime discovers definitions.
 *
 * Browser-bound connectors are intentionally absent: each gets its own
 * publishability review before being added, and the published `@pdpp/local-collector`
 * bundle stays filesystem-class only so the publish stays browser-free.
 */

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";
import { applePhotosCollectorDefinition } from "../connectors/apple_photos/collector-definition.ts";
import { claudeCodeCollectorDefinition } from "../connectors/claude_code/collector-definition.ts";
import { codexCollectorDefinition } from "../connectors/codex/collector-definition.ts";
import { googleMessagesCollectorDefinition } from "../connectors/google_messages/collector-definition.ts";
import { googleTakeoutCollectorDefinition } from "../connectors/google_takeout/collector-definition.ts";
import { imessageCollectorDefinition } from "../connectors/imessage/collector-definition.ts";

export type {
	LocalCollectorBinding,
	LocalCollectorDefinition,
} from "@pdpp/connector-protocol/collector-definition";

/**
 * Every connector definition the published local collector bundles, in the
 * supported public order on a fresh host: Claude Code, then Codex
 * transcripts, then Google Takeout, then iMessage, then Apple Photos, then
 * Google Messages.
 *
 * iMessage reads chat.db via `node:sqlite` (built into Node.js, not a
 * native npm module), so it carries no native compiled dependency and can
 * ship in this bundle like any other filesystem-class connector. Apple
 * Photos carries no native compiled or external subprocess dependency.
 * Google Messages spawns the external `gmcli` binary
 * (github.com/johnlindquist/gmkit, AGPL-3.0) — not bundled/installed by
 * this package, a separate operator-installed prerequisite documented in
 * its manifest and surfaced by the guided setup flow, the same
 * arms-length-subprocess shape this repo's Slack connector already uses
 * for slackdump.
 *
 * Signal is intentionally NOT included here yet. Its connector source
 * lives at `../connectors/signal/`, imported into this canonical registry
 * from pdpp's history, but `data-connect`'s `packages/local-collector`
 * consumer does not vendor it yet (its committed
 * `collector-definitions.generated.ts` snapshot stops at Google Messages).
 * Adding Signal to this registry without a matching data-connect companion
 * change breaks the Cross-Repo Integrity Gate's collector-definitions-
 * snapshot drift check. Per the Move A execution plan §3b, Signal is
 * deferred to a later, separately-gated PR once data-connect support
 * lands — not dropped, just sequenced after this catch-up.
 *
 * Because this registry is what makes a local collector reachable at run
 * time, `manifests/signal.json` correspondingly does not claim
 * `capabilities.proven.local_collector`. The PR that adds Signal here adds
 * that claim back in the same change;
 * `src/proven-local-collector-manifest-honesty.test.ts` pins the pair
 * together in both directions so neither side can move alone.
 */
export const LOCAL_COLLECTOR_DEFINITIONS: readonly LocalCollectorDefinition[] =
	Object.freeze([
		claudeCodeCollectorDefinition,
		codexCollectorDefinition,
		googleTakeoutCollectorDefinition,
		imessageCollectorDefinition,
		applePhotosCollectorDefinition,
		googleMessagesCollectorDefinition,
	]);

/**
 * The default stream set connector `connectorId` declares, for runners that
 * would otherwise restate it.
 *
 * A connector's definition is the single source of truth for what an
 * unscoped run requests, so every runner in this package reads it from here
 * rather than keeping a table of its own: a hand-copied list drifts
 * silently, and a run that omits `coverage_diagnostics` leaves the drained
 * collector on `coverage_unknown`.
 *
 * Throws for an unknown id rather than returning an empty scope — a runner
 * asking for a connector this registry does not carry is a wiring bug, and
 * an empty stream list would surface as a silently empty collection.
 *
 * Connectors with no definition here (browser- or network-bound ones, which
 * the published collector bundle deliberately excludes) declare their own
 * defaults at their only call site.
 */
export function definitionStreams(connectorId: string): readonly string[] {
	const definition = LOCAL_COLLECTOR_DEFINITIONS.find(
		(candidate) => candidate.connector_id === connectorId,
	);
	if (!definition) {
		const known = LOCAL_COLLECTOR_DEFINITIONS.map(
			(candidate) => candidate.connector_id,
		).join(", ");
		throw new Error(
			`no local-collector definition for "${connectorId}" (known: ${known})`,
		);
	}
	return definition.streams;
}

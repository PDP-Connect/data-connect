/**
 * Genuine separate-OS-process participant for the consent-exchange-code
 * server-restart regression
 * (test/security-consent-token-handoff.test.ts, "an exchange code survives
 * a SQLite-backed server restart").
 *
 * The scenario under test is a real server restart: the AS process exits
 * and a new AS process later starts against the SAME on-disk SQLite file,
 * and a consent-exchange code minted before the exit must still redeem
 * after the restart. Running the pre-restart AND post-restart server
 * inside one `node:test` process (two sequential `startServer()`/
 * `closeDb()` cycles against a real, non-`:memory:`, WAL-mode SQLite file
 * within one process, OR even a single such cycle followed by spawning
 * one child process) triggers a `node:test` runner defect: the file hangs
 * forever after all assertions pass, reported as "Promise resolution is
 * still pending but the event loop has already resolved", even though
 * `process.report.getReport().libuv` and `process._getActiveHandles()` are
 * both empty by then — there is no real handle leak, it is the runner's
 * own idle-detection bookkeeping getting confused by real-file WAL-mode
 * SQLite activity in-process. Running BOTH halves of the restart as
 * genuinely separate child processes (this fixture, used twice) keeps the
 * PARENT `node:test` process free of any real-file SQLite activity at
 * all, which reliably avoids the defect — and is also a more faithful
 * model of the actual scenario, since a production restart is a new
 * process too.
 *
 * Protocol (stdio-based, matching
 * test/fixtures/connector-instance-two-process-race-fixture.ts):
 *   1. Starts the reference AS/RS servers against the `dbPath` given on
 *      argv[2], with introspection credentials from argv[3] (JSON).
 *   2. Prints `{"ready":true,"asPort":...}` to stdout.
 *   3. Blocks on stdin for the parent's "go" line, carrying the requested
 *      operation:
 *        {"op":"mint"}                    — registers the fixture Spotify
 *          connector manifest and instance, drives PAR -> review -> HTML
 *          approve, and prints the minted `cex_...` exchange code.
 *        {"op":"exchange","code":"cex_..."} — redeems `code` via
 *          POST /consent/exchange.
 *   4. Prints one final JSON line with the outcome
 *      ({"code":"cex_..."} for "mint", {"status","body"} for "exchange"),
 *      or {"error":...} on a thrown error, then exits 0/1.
 */
import { createInterface } from "node:readline";
import { canonicalConnectorKey } from "../../server/connector-key.ts";
import { startServer } from "../../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../../server/stores/connector-instance-store.ts";

const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";
const EXCHANGE_CODE_RE = /cex_[0-9a-f]{64}/;
const APPROVAL_REVIEW_REVISION_PATTERN =
	/name="approval_review_revision" value="([^"]+)"/;

interface MintGoPayload {
	op: "mint";
	spotifyManifestPath: string;
}

interface ExchangeGoPayload {
	code: string;
	op: "exchange";
}

type GoPayload = ExchangeGoPayload | MintGoPayload;

async function mint(
	asUrl: string,
	spotifyManifestPath: string,
): Promise<string> {
	const spotifyManifest = JSON.parse(
		await (await import("node:fs")).promises.readFile(
			spotifyManifestPath,
			"utf8",
		),
	);

	const registerResp = await fetch(`${asUrl}/connectors`, {
		body: JSON.stringify(spotifyManifest),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (registerResp.status !== 201) {
		throw new Error(
			`register failed (${registerResp.status}): ${await registerResp.text()}`,
		);
	}

	const connectorId = canonicalConnectorKey(spotifyManifest.connector_id);
	if (!connectorId) {
		throw new Error(
			"spotify manifest must resolve to a canonical connector key",
		);
	}
	await createSqliteConnectorInstanceStore().upsert({
		connectorId,
		connectorInstanceId: "cin_security_consent_handoff_spotify",
		createdAt: NOW,
		displayName: "Security Consent Handoff Spotify",
		ownerSubjectId: OWNER_SUBJECT_ID,
		sourceBinding: { account_hint: "security-consent-handoff@example.com" },
		sourceBindingKey: "security-consent-handoff@example.com",
		sourceKind: "account",
		status: "active",
		updatedAt: NOW,
	});

	const initResp = await fetch(`${asUrl}/oauth/par`, {
		body: JSON.stringify({
			authorization_details: [
				{
					access_mode: "continuous",
					purpose_code: "https://pdpp.dev/purpose/personalization",
					purpose_description: "Consent token handoff regression",
					source: { id: spotifyManifest.connector_id, kind: "connector" },
					streams: [{ name: "top_artists", view: "basic" }],
					type: "https://pdpp.dev/data-access",
				},
			],
			client_id: "concert_recommendation_app",
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (initResp.status !== 201) {
		throw new Error(
			`PAR failed (${initResp.status}): ${await initResp.text()}`,
		);
	}
	const initBody = (await initResp.json()) as { request_uri: string };

	const reviewResp = await fetch(`${asUrl}/consent/review`, {
		body: new URLSearchParams({
			request_uri: initBody.request_uri,
			subject_id: OWNER_SUBJECT_ID,
		}).toString(),
		headers: {
			Accept: "text/html",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	const reviewHtml = await reviewResp.text();
	if (reviewResp.status !== 200) {
		throw new Error(`review failed (${reviewResp.status}): ${reviewHtml}`);
	}
	const revisionMatch = reviewHtml.match(APPROVAL_REVIEW_REVISION_PATTERN);
	if (!revisionMatch?.[1]) {
		throw new Error("review HTML did not carry the approval review revision");
	}

	const approveResp = await fetch(`${asUrl}/consent/approve`, {
		body: new URLSearchParams({
			approval_review_revision: revisionMatch[1],
			request_uri: initBody.request_uri,
		}).toString(),
		headers: {
			Accept: "text/html",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	const approveHtml = await approveResp.text();
	if (approveResp.status !== 200) {
		throw new Error(`approve failed (${approveResp.status}): ${approveHtml}`);
	}
	const code = approveHtml.match(EXCHANGE_CODE_RE)?.[0];
	if (!code) {
		throw new Error(
			"HTML approve response did not embed a cex_... exchange code",
		);
	}
	return code;
}

async function main(): Promise<void> {
	const [, , dbPath, introspectionCallerCredentialsArg] = process.argv;
	if (!(dbPath && introspectionCallerCredentialsArg)) {
		throw new Error(
			"consent-handoff-restart-server-fixture requires dbPath as argv[2] and introspection credentials JSON as argv[3]",
		);
	}
	const introspectionCallerCredentials = JSON.parse(
		introspectionCallerCredentialsArg,
	);

	const server = await startServer({
		asPort: 0,
		dbPath,
		introspectionCallerCredentials,
		quiet: true,
		rsPort: 0,
	});
	const asUrl = `http://localhost:${server.asPort}`;

	process.stdout.write(
		`${JSON.stringify({ asPort: server.asPort, ready: true })}\n`,
	);

	const rl = createInterface({ input: process.stdin });
	const goLine = await new Promise<string>((resolve) => {
		rl.once("line", resolve);
	});
	rl.close();
	const go = JSON.parse(goLine) as GoPayload;

	try {
		if (go.op === "mint") {
			const code = await mint(asUrl, go.spotifyManifestPath);
			process.stdout.write(`${JSON.stringify({ code })}\n`);
		} else {
			const response = await fetch(`${asUrl}/consent/exchange`, {
				body: JSON.stringify({ code: go.code }),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
			const body = await response.json();
			process.stdout.write(
				`${JSON.stringify({ body, status: response.status })}\n`,
			);
		}
		process.exitCode = 0;
	} catch (err) {
		process.stdout.write(
			`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`,
		);
		process.exitCode = 1;
	} finally {
		server.asServer.closeAllConnections?.();
		server.rsServer.closeAllConnections?.();
		await new Promise<void>((resolve) =>
			server.asServer.close(() => resolve()),
		);
		await new Promise<void>((resolve) =>
			server.rsServer.close(() => resolve()),
		);
	}
}

await main();

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/connector-install-activation-authority.test.ts. It runs the
// production activation authority against the database named by its
// environment: a SQLite file (PDPP_ACTIVATION_CHILD_DB) or a Postgres test
// database (PDPP_ACTIVATION_CHILD_DATABASE_URL plus a single-use attachment).
//
//   argv[2] = import    getConnectorActivation("gmail"); prints one JSON line
//             publish   publish the next gmail version (digest "c...")
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();

const { initDb } = await import("../../../server/db.ts");
const { initPostgresStorage } = await import(
	"../../../server/postgres-storage.ts"
);
const { getConnectorActivation, publishConnectorActivation } = await import(
	"../../../server/connector-install/activation-authority.ts"
);
const { installRecord } = await import(
	"../../helpers/activation-authority-scenarios.ts"
);
const { installedGmail } = await import(
	"../../helpers/connector-install-gmail-fixture.ts"
);

const databaseUrl = process.env.PDPP_ACTIVATION_CHILD_DATABASE_URL;
if (databaseUrl) {
	initDb(":memory:");
	await initPostgresStorage(
		{ backend: "postgres", databaseUrl },
		{
			testOnlyAlreadyAdmittedChildAttachment: process.env
				.PDPP_ACTIVATION_CHILD_ATTACHMENT as string,
		},
	);
} else {
	initDb(process.env.PDPP_ACTIVATION_CHILD_DB as string);
}

const mode = process.argv[2];
if (mode === "import") {
	const activation = await getConnectorActivation("gmail");
	process.stdout.write(
		`${JSON.stringify({ attemptId: activation?.attemptId, state: activation?.state })}\n`,
	);
} else if (mode === "publish") {
	await publishConnectorActivation(
		installRecord(
			{ ...installedGmail, version: "9.1.0" },
			{ digest: `sha256:${"c".repeat(64)}` },
		),
	);
	process.stdout.write("published\n");
} else {
	throw new Error(`unknown mode ${String(mode)}`);
}
process.exit(0);

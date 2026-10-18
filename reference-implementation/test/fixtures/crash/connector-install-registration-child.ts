// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/connector-install-registration-crash.test.ts. It runs the
// production install service (SQLite install store, production manifest
// registration, lifecycle and install locks) against the SQLite file in
// argv[2]. Only the OCI download is replaced by writing the gmail profile.
//
//   argv[3] = install   install gmail artifact A on an empty database
//             seed      register the shipped gmail manifest, add one
//                       connection, then install artifact A and let its
//                       derived repair finish (the "before" state of an update)
//             update    install artifact B (a newer manifest) over A
//             retry     install artifact A again
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();

const { registerConnector } = await import("../../../server/auth.ts");
const { getDb, initDb } = await import("../../../server/db.ts");
const { GMAIL_INSTALL_DIGEST, gmailInstallService, installedGmail, shippedGmail } = await import(
  "../../helpers/connector-install-gmail-fixture.ts"
);

const UPDATE_DIGEST = `sha256:${"c".repeat(64)}`;

const [dbPath, dataDir, mode] = process.argv.slice(2) as [string, string, string];
process.env.PDPP_DATA_DIR = dataDir;
await initDb(dbPath);

const repairs: Promise<unknown>[] = [];
const service = (artifact?: { digest: string; manifest: Record<string, unknown> }) =>
  gmailInstallService(dataDir, { onRepair: (repair) => repairs.push(repair) }, artifact);

if (mode === "seed") {
  await registerConnector(shippedGmail, { backfillRetrievalIndexes: false });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name,
         source_kind, source_binding_key, created_at, updated_at)
       VALUES('cin_gmail_crash', 'owner', 'gmail', 'Gmail', 'account', 'cin_gmail_crash', ?, ?)`
    )
    .run(now, now);
}
if (mode === "install" || mode === "seed" || mode === "retry") {
  await service().install("gmail", GMAIL_INSTALL_DIGEST);
} else if (mode === "update") {
  await service({
    digest: UPDATE_DIGEST,
    manifest: { ...installedGmail, version: "9.1.0" },
  }).install("gmail", UPDATE_DIGEST);
} else {
  throw new Error(`unknown mode ${mode}`);
}
await Promise.allSettled(repairs);
process.stdout.write("finished\n");
process.exit(0);

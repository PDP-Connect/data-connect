// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { getDb } from "../../server/db.ts";
import { replay, startPermanentAudienceFixture } from "../helpers/mcp-existing-client-session.ts";

const [dbPath, metadataPath] = process.argv.slice(2);
if (!(dbPath && metadataPath)) {
  throw new Error("usage: seed-mcp-audience-migration-fixture <db-path> <metadata-path>");
}

const fixture = await startPermanentAudienceFixture(dbPath);
try {
  const db = getDb();
  const subjectFor = (token: string): string => {
    const row = db.prepare("SELECT subject_id FROM tokens WHERE token_id = ?").get(token) as
      | { subject_id: string }
      | undefined;
    if (!row?.subject_id) throw new Error(`expected token subject for ${token}`);
    return row.subject_id;
  };
  await writeFile(
    metadataPath,
    JSON.stringify({
      asPort: new URL(fixture.asUrl).port,
      client: fixture.client,
      clientCapture: await replay(fixture.rsUrl, fixture.client, "client"),
      clientSubject: subjectFor(fixture.client),
      internalChildren: fixture.internalChildren,
      package: fixture.package,
      packageCapture: await replay(fixture.rsUrl, fixture.package, "package"),
      packageSubject: subjectFor(fixture.package),
      packageId: fixture.packageId,
      rsPort: new URL(fixture.rsUrl).port,
      undecidable: fixture.undecidable,
    })
  );
} finally {
  await fixture.close();
}

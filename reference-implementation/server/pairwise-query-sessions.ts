// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { getDb } from "./db.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.ts";

export async function savePairwiseQueryState(state: unknown): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const json = JSON.stringify(state);
  if (isPostgresStorageBackend()) {
    await postgresQuery("INSERT INTO pairwise_query_sessions(token,state_json) VALUES($1,$2)", [token, json]);
  } else {
    getDb().prepare("INSERT INTO pairwise_query_sessions(token,state_json) VALUES(?,?)").run(token, json);
  }
  return token;
}

export async function loadPairwiseQueryState(token: string): Promise<unknown> {
  const row = isPostgresStorageBackend()
    ? (
        await postgresQuery<{ state_json: string }>("SELECT state_json FROM pairwise_query_sessions WHERE token=$1", [
          token,
        ])
      ).rows[0]
    : getDb()
        .prepare("SELECT state_json FROM pairwise_query_sessions WHERE token=?")
        .get<{ state_json: string }>(token);
  return row ? JSON.parse(row.state_json) : null;
}

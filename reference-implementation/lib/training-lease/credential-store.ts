/**
 * Per-grant public-client lease credentials (lease note L5).
 *
 * A credential chain is bound to one grant, one client and one DPoP key
 * thumbprint (`jkt`). Each renewal presents the current credential and
 * receives its successor:
 *
 * - Each predecessor has at most one successor. The successor is derived
 *   deterministically, HMAC(secret, predecessor), so a retry can be answered
 *   with the same successor without storing any credential in plaintext.
 * - The predecessor is accepted until the successor is first used.
 * - A retry with the same DPoP proof `jti` gets the same successor, even
 *   after the successor was used (L5's idempotent retry).
 * - Any other use of a predecessor after its successor was used is treated
 *   as theft: the chain is revoked and the owner can see it.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import { SqliteDriver } from "../../server/sqlite-driver.ts";

// The repo's single SQLite driver: every connection in a process must come
// from the same package, or same-file locks do not contend.
const Database = SqliteDriver as unknown as typeof BetterSqlite3;
type SqliteDatabase = BetterSqlite3.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lease_credential_chains (
  chain_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  jkt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_reason TEXT,
  revoked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lease_credentials (
  cred_hash TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  successor_hash TEXT,
  first_used_at_ms INTEGER,
  first_proof_jti TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lease_credential_secret (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL
);
`;

export type RenewOutcome =
  | {
      ok: true;
      successor: string;
      grantId: string;
      clientId: string;
      /** True when this answers a repeat of an earlier request. */
      repeat: boolean;
    }
  | {
      ok: false;
      reason:
        | "unknown_credential"
        | "chain_revoked"
        | "key_mismatch"
        | "theft_detected";
    };

export interface ChainView {
  chain_id: string;
  client_id: string;
  status: "active" | "revoked";
  revoked_reason: string | null;
  revoked_at_ms: number | null;
  generations: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export class LeaseCredentialStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => number;
  readonly #secret: Buffer;

  private constructor(db: SqliteDatabase, now: () => number, secret: Buffer) {
    this.#db = db;
    this.#now = now;
    this.#secret = secret;
  }

  static open(opts: {
    storePath: string;
    now: () => number;
  }): LeaseCredentialStore {
    const db = new Database(opts.storePath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    let secret = "";
    db.transaction(() => {
      const row = db
        .prepare("SELECT secret FROM lease_credential_secret WHERE id = 1")
        .get() as { secret: string } | undefined;
      if (row) {
        secret = row.secret;
      } else {
        secret = randomBytes(32).toString("base64url");
        db.prepare(
          "INSERT INTO lease_credential_secret(id, secret) VALUES (1, ?)",
        ).run(secret);
      }
    }).immediate();
    return new LeaseCredentialStore(
      db,
      opts.now,
      Buffer.from(secret, "base64url"),
    );
  }

  close(): void {
    this.#db.close();
  }

  #derive(predecessor: string): string {
    return `plc_${createHmac("sha256", this.#secret).update(`successor|${predecessor}`).digest("base64url")}`;
  }

  /**
   * Start a chain for a grant. The prototype bootstraps with the grant's
   * access token (see the route); a newer bootstrap supersedes older chains.
   */
  bootstrap(input: { grantId: string; clientId: string; jkt: string }): string {
    const credential = `plc_${randomBytes(32).toString("base64url")}`;
    const now = this.#now();
    this.#db
      .transaction(() => {
        this.#db
          .prepare(
            `UPDATE lease_credential_chains SET status = 'revoked', revoked_reason = 'superseded', revoked_at_ms = ?
              WHERE grant_id = ? AND status = 'active'`,
          )
          .run(now, input.grantId);
        const chainId = randomUUID();
        this.#db
          .prepare(
            "INSERT INTO lease_credential_chains(chain_id, grant_id, client_id, jkt, status, created_at_ms) VALUES (?, ?, ?, ?, 'active', ?)",
          )
          .run(chainId, input.grantId, input.clientId, input.jkt, now);
        this.#db
          .prepare(
            "INSERT INTO lease_credentials(cred_hash, chain_id, generation, created_at_ms) VALUES (?, ?, 0, ?)",
          )
          .run(hash(credential), chainId, now);
      })
      .immediate();
    return credential;
  }

  renew(input: {
    credential: string;
    jkt: string;
    proofJti: string;
  }): RenewOutcome {
    const now = this.#now();
    let out: RenewOutcome = { ok: false, reason: "unknown_credential" };
    this.#db
      .transaction(() => {
        const h = hash(input.credential);
        const row = this.#db
          .prepare("SELECT * FROM lease_credentials WHERE cred_hash = ?")
          .get(h) as
          | {
              chain_id: string;
              generation: number;
              successor_hash: string | null;
              first_proof_jti: string | null;
            }
          | undefined;
        if (!row) {
          return;
        }
        const chain = this.#db
          .prepare("SELECT * FROM lease_credential_chains WHERE chain_id = ?")
          .get(row.chain_id) as {
          grant_id: string;
          client_id: string;
          jkt: string;
          status: string;
        };
        if (chain.status !== "active") {
          out = { ok: false, reason: "chain_revoked" };
          return;
        }
        if (chain.jkt !== input.jkt) {
          // Sender constraint: the credential without its key is useless. Not
          // treated as theft, because it proves nothing about the legitimate holder.
          out = { ok: false, reason: "key_mismatch" };
          return;
        }
        const successor = this.#derive(input.credential);
        const base = { grantId: chain.grant_id, clientId: chain.client_id };
        if (row.successor_hash === null) {
          this.#db
            .prepare(
              "INSERT INTO lease_credentials(cred_hash, chain_id, generation, created_at_ms) VALUES (?, ?, ?, ?)",
            )
            .run(hash(successor), row.chain_id, row.generation + 1, now);
          this.#db
            .prepare(
              "UPDATE lease_credentials SET successor_hash = ?, first_used_at_ms = COALESCE(first_used_at_ms, ?), first_proof_jti = ? WHERE cred_hash = ?",
            )
            .run(hash(successor), now, input.proofJti, h);
          out = { ok: true, successor, ...base, repeat: false };
          return;
        }
        if (row.first_proof_jti === input.proofJti) {
          out = { ok: true, successor, ...base, repeat: true };
          return;
        }
        const succ = this.#db
          .prepare(
            "SELECT first_used_at_ms FROM lease_credentials WHERE cred_hash = ?",
          )
          .get(row.successor_hash) as { first_used_at_ms: number | null };
        if (succ.first_used_at_ms === null) {
          // Lost response or a concurrent renewal: the same successor again.
          out = { ok: true, successor, ...base, repeat: true };
          return;
        }
        this.#db
          .prepare(
            "UPDATE lease_credential_chains SET status = 'revoked', revoked_reason = 'theft_detected', revoked_at_ms = ? WHERE chain_id = ?",
          )
          .run(now, row.chain_id);
        out = { ok: false, reason: "theft_detected" };
      })
      .immediate();
    return out;
  }

  /** Owner-visible view of a grant's credential chains. */
  chains(grantId: string): ChainView[] {
    return this.#db
      .prepare(
        `SELECT c.chain_id, c.client_id, c.status, c.revoked_reason, c.revoked_at_ms,
                (SELECT COUNT(*) FROM lease_credentials l WHERE l.chain_id = c.chain_id) AS generations
           FROM lease_credential_chains c WHERE c.grant_id = ? ORDER BY c.created_at_ms`,
      )
      .all(grantId) as ChainView[];
  }
}

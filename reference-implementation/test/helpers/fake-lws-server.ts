import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LwsIdentity } from "../../server/lws/lws-client.ts";

export interface FakeLwsPermission { path: string; read: boolean; write: boolean }
export interface FakeLwsFile { body: Uint8Array; contentType: string; etag: string }
export interface FakeLwsFailure {
  method?: string;
  path?: string;
  kind: "status" | "drop" | "race";
  status?: number;
  body?: Uint8Array;
}
export interface FakeLwsOptions {
  pageSize?: number;
  now?: () => number;
  maxRequestBytes?: number;
}
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Generate a synthetic, in-memory Ed25519 identity, never a production credential. */
export function fakeLwsIdentity(seed: Uint8Array = randomBytes(32)): LwsIdentity {
  if (seed.length !== 32) throw new Error("Expected 32-byte seed");
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der", type: "pkcs8",
  });
  const raw = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  let n = BigInt("0x" + Buffer.concat([Buffer.from([0xed, 1]), raw]).toString("hex"));
  let encoded = "";
  while (n > 0n) {
    encoded = ALPHABET[Number(n % 58n)] + encoded;
    n /= 58n;
  }
  return { did: "did:key:z" + encoded, seed: Uint8Array.from(seed) };
}

function file(body: Uint8Array, contentType: string): FakeLwsFile {
  return { body: Uint8Array.from(body), contentType, etag: '"' + createHash("sha256").update(body).digest("hex") + '"' };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bad JSON object");
  return value as Record<string, unknown>;
}

/**
 * Loopback fake for tasks A–F. Use registerIdentity(identity, folder ACLs), inspect(path),
 * injectFailure({method, path, kind, status?, body?}), and await close() in test cleanup.
 * Listings use {items:[{id,type,format?}]} and Link rel="next".
 * Requests log only method/path (no credentials); pageSize defaults to measured 1000.
 */
export async function startFakeLwsServer(options: FakeLwsOptions = {}) {
  const now = options.now ?? Date.now;
  const pageSize = options.pageSize ?? 1000;
  const maxBytes = options.maxRequestBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("Invalid pageSize");
  const identities = new Map<string, { key: ReturnType<typeof createPublicKey>; permissions: FakeLwsPermission[] }>();
  const tokens = new Map<string, { did: string; expires: number }>();
  const files = new Map<string, FakeLwsFile>();
  const containers = new Set<string>(["/"]);
  const failures: FakeLwsFailure[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  let storageUrl = "";

  const reply = (res: ServerResponse, status: number, value?: unknown) => {
    res.statusCode = status;
    if (value === undefined) { res.end(); return; }
    res.setHeader("content-type", status >= 400 ? "application/problem+json" : "application/json");
    res.end(JSON.stringify(value));
  };
  const challenge = (res: ServerResponse) => {
    res.setHeader("www-authenticate", 'Bearer as_uri="' + storageUrl.slice(0, -1) + '"');
    reply(res, 401, { title: "Authentication required" });
  };
  const read = async (req: IncomingMessage): Promise<Buffer | null> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxBytes) { req.destroy(); return null; }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  };
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", storageUrl);
    const method = req.method ?? "GET";
    requests.push({ method, path: url.pathname + url.search });
    const index = failures.findIndex((failure) =>
      (!failure.method || failure.method === method) &&
      (!failure.path || failure.path === url.pathname));
    const failure = index >= 0 ? failures.splice(index, 1)[0] : undefined;
    if (failure?.kind === "drop") { req.destroy(); return; }
    if (failure?.kind === "status") {
      if (failure.status === 401) challenge(res);
      else reply(res, failure.status ?? 500, { title: "Injected failure" });
      return;
    }
    const body = await read(req);
    if (!body) return;
    if (url.pathname === "/.lws/token" && method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
        reply(res, 400, { title: "Form body required" }); return;
      }
      try {
        const form = new URLSearchParams(body.toString());
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
            form.get("subject_token_type") !== "urn:ietf:params:oauth:token-type:jwt" ||
            form.get("resource") !== storageUrl) throw new Error("Bad exchange");
        // authorization_details is deliberately ignored, matching the measured server.
        const [headerPart, claimsPart, signature, extra] = (form.get("subject_token") ?? "").split(".");
        if (!headerPart || !claimsPart || !signature || extra !== undefined) throw new Error("Bad JWT");
        const header = record(JSON.parse(Buffer.from(headerPart, "base64url").toString()));
        const claims = record(JSON.parse(Buffer.from(claimsPart, "base64url").toString()));
        if (typeof claims.iss !== "string") throw new Error("Bad issuer");
        const identity = identities.get(claims.iss);
        const seconds = Math.floor(now() / 1000);
        if (!identity || header.alg !== "EdDSA" || header.typ !== "JWT" ||
            header.kid !== claims.iss + "#" + claims.iss.slice("did:key:".length) ||
            claims.sub !== claims.iss || claims.client_id !== claims.iss || claims.aud !== storageUrl ||
            typeof claims.iat !== "number" || typeof claims.exp !== "number" ||
            !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
            claims.iat > seconds + 5 || claims.exp <= seconds || claims.exp <= claims.iat ||
            !verify(null, Buffer.from(headerPart + "." + claimsPart), identity.key, Buffer.from(signature, "base64url"))) {
          throw new Error("Invalid credential signature or claims");
        }
        const token = randomUUID();
        tokens.set(token, { did: claims.iss, expires: now() + 300_000 });
        reply(res, 200, { access_token: token, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 300 });
      } catch {
        reply(res, 401, { title: "Invalid credential" });
      }
      return;
    }
    const token = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!token || token.expires <= now()) { challenge(res); return; }
    const permissions = identities.get(token.did)?.permissions ?? [];
    const writing = method === "PUT" || method === "DELETE";
    const allowed = permissions.some((permission) =>
      (url.pathname === permission.path || url.pathname.startsWith(permission.path)) &&
      (writing ? permission.write : permission.read));
    if (!allowed) { reply(res, 404, { title: "Not found" }); return; }
    const path = url.pathname;
    if (method === "GET" && containers.has(path)) {
      if (req.headers.accept !== "application/lws+json") {
        reply(res, 406, { title: "LWS listing required" }); return;
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) { reply(res, 400); return; }
      const children = [
        ...[...containers].filter((p) => p !== path && p.startsWith(path) && !p.slice(path.length).replace(/\/$/, "").includes("/"))
          .map((p) => ({ id: new URL(p, storageUrl).href, type: ["http://www.w3.org/ns/ldp#Container"] })),
        ...[...files].filter(([p]) => p.startsWith(path) && !p.slice(path.length).includes("/"))
          .map(([p, value]) => ({ id: new URL(p, storageUrl).href, type: ["http://www.w3.org/ns/ldp#Resource"], format: value.contentType })),
      ].sort((a, b) => a.id.localeCompare(b.id));
      res.setHeader("content-type", "application/lws+json");
      if (offset + pageSize < children.length) res.setHeader("link", "<" + path + "?offset=" + (offset + pageSize) + '>; rel="next"');
      res.end(JSON.stringify({ items: children.slice(offset, offset + pageSize) }));
      return;
    }
    if (method === "PUT" && path.endsWith("/")) {
      if (!req.headers.link?.includes('http://www.w3.org/ns/ldp#Container')) { reply(res, 400); return; }
      if (containers.has(path)) { reply(res, 412); return; }
      containers.add(path);
      reply(res, 201);
      return;
    }
    if (failure?.kind === "race") files.set(path, file(failure.body ?? Buffer.from("concurrent winner"), "application/octet-stream"));
    const existing = files.get(path);
    if (method === "GET") {
      if (!existing) { reply(res, 404, { title: "Not found" }); return; }
      res.setHeader("content-type", existing.contentType);
      res.setHeader("etag", existing.etag);
      res.end(Buffer.from(existing.body));
      return;
    }
    if (method === "PUT" || method === "DELETE") {
      const match = req.headers["if-match"];
      const absent = req.headers["if-none-match"];
      if ((absent === "*" && existing) ||
          (match && (!existing || (match !== "*" && match !== existing.etag && match !== "W/" + existing.etag)))) {
        reply(res, 412); return;
      }
      if (existing && !match && absent !== "*") { reply(res, 428); return; }
      if (method === "DELETE") {
        if (!existing) { reply(res, 404, { title: "Not found" }); return; }
        files.delete(path); reply(res, 204); return;
      }
      const value = file(body, req.headers["content-type"] ?? "application/octet-stream");
      files.set(path, value);
      res.setHeader("etag", value.etag);
      reply(res, existing ? 204 : 201);
      return;
    }
    reply(res, 405);
  };
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) reply(res, 500, { title: "Fake server error" });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  storageUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/";
  return {
    storageUrl,
    requests,
    registerIdentity(identity: LwsIdentity, permissions: FakeLwsPermission[]): void {
      if (fakeLwsIdentity(identity.seed).did !== identity.did) throw new Error("DID/seed mismatch");
      const key = createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), identity.seed]),
        format: "der", type: "pkcs8",
      });
      for (const permission of permissions) {
        if (!permission.path.startsWith("/") || !permission.path.endsWith("/")) throw new Error("ACL folder must start/end with /");
      }
      identities.set(identity.did, { key: createPublicKey(key), permissions: permissions.map((p) => ({ ...p })) });
    },
    inspect(path: string): FakeLwsFile | undefined {
      const value = files.get(path);
      return value ? { ...value, body: Uint8Array.from(value.body) } : undefined;
    },
    injectFailure(failure: FakeLwsFailure): void { failures.push({ ...failure }); },
    revokeTokens(): void { tokens.clear(); },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";

export interface LwsIdentity { did: string; seed: Uint8Array }
export interface LwsClientOptions {
  storageUrl: string;
  identity: LwsIdentity;
  fetch?: typeof fetch;
  maxRequestBytes?: number;
  now?: () => number;
}
export class LwsPermissionError extends Error {}
export class LwsPreconditionFailed extends Error {
  readonly url: string;
  constructor(url: string) {
    super("LWS precondition failed: " + url);
    this.name = "LwsPreconditionFailed";
    this.url = url;
  }
}
export interface LwsFile { etag: string; contentType: string | null; body: Uint8Array }

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type ListingItem = { id: string; type: string[]; format?: string };
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function multibase(bytes: Uint8Array): string {
  let number = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let text = "";
  while (number > 0n) {
    text = BASE58[Number(number % 58n)] + text;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = "1" + text;
  }
  return "z" + text;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid LWS JSON object");
  }
  return value as Record<string, unknown>;
}

function etag(response: Response): string {
  const value = response.headers.get("etag");
  if (!value || value.startsWith("W/")) throw new Error("Missing or weak LWS ETag");
  return value;
}

export class LwsClient {
  private readonly root: URL;
  private readonly identity: LwsIdentity;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly key: ReturnType<typeof createPrivateKey>;
  private readonly created = new Set<string>();
  private cached: { value: string; expires: number } | undefined;
  private pending: Promise<string> | undefined;
  private authorizationServer: URL | undefined;

  constructor(options: LwsClientOptions) {
    this.root = new URL(options.storageUrl);
    if (!["http:", "https:"].includes(this.root.protocol) || this.root.username ||
        this.root.password || this.root.search || this.root.hash || !this.root.pathname.endsWith("/")) {
      throw new Error("storageUrl must be an HTTP(S) root with a trailing slash");
    }
    if (options.identity.seed.length !== 32) throw new Error("Expected a 32-byte Ed25519 seed");
    this.identity = { did: options.identity.did, seed: Uint8Array.from(options.identity.seed) };
    this.key = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), this.identity.seed]),
      format: "der", type: "pkcs8",
    });
    const publicDer = createPublicKey(this.key).export({ format: "der", type: "spki" });
    const expected = "did:key:" + multibase(Buffer.concat([Buffer.from([0xed, 0x01]), publicDer.subarray(-32)]));
    if (this.identity.did !== expected) throw new Error("DID does not match Ed25519 seed");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxRequestBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Invalid maxRequestBytes");
  }

  private url(path: string): URL {
    if (path.includes("\\") || path.includes("?") || path.includes("#") ||
        path.split("/").some((part) => [".", ".."].includes(decodeURIComponent(part)))) {
      throw new Error("Invalid LWS relative path");
    }
    const url = new URL(path.replace(/^\/+/, ""), this.root);
    this.checkUrl(url);
    return url;
  }

  private checkUrl(url: URL): void {
    if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname) ||
        url.username || url.password || url.hash) throw new Error("LWS URL escapes storage root");
  }

  // Exactly three retries after the first attempt. 412 and ordinary 4xx never retry.
  private async send(url: URL, init: FetchInit): Promise<Response> {
    for (let retry = 0; ; retry++) {
      let response: Response;
      try {
        response = await this.fetcher(url, { ...init, redirect: "error" });
        // Reading the body here also catches a dropped connection after headers.
        const body = await response.arrayBuffer();
        response = new Response([204, 205, 304].includes(response.status) ? null : body, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      } catch (error) {
        if (retry === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** retry));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && retry < 3) {
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** retry));
        continue;
      }
      return response;
    }
  }

  private discover(response: Response): void {
    const challenge = response.headers.get("www-authenticate") ?? "";
    const match = /\bas_uri\s*=\s*"([^"]+)"/i.exec(challenge);
    if (!match?.[1]) throw new LwsPermissionError("LWS 401 has no as_uri challenge");
    const server = new URL(match[1], this.root);
    if (!["http:", "https:"].includes(server.protocol) || server.username ||
        server.password || server.search || server.hash) throw new Error("Invalid LWS authorization server");
    this.authorizationServer = server;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expires - this.now() > 60_000) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.obtainToken();
    try { return await this.pending; }
    finally { this.pending = undefined; }
  }

  private async obtainToken(): Promise<string> {
    if (!this.authorizationServer) {
      const response = await this.send(this.root, { method: "GET" });
      if (response.status !== 401) throw new LwsPermissionError("Expected LWS authentication challenge");
      this.discover(response);
    }
    const now = Math.floor(this.now() / 1000);
    const part = this.identity.did.slice("did:key:".length);
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: this.identity.did + "#" + part })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      iss: this.identity.did, sub: this.identity.did, client_id: this.identity.did,
      aud: this.root.href, iat: now, exp: now + 300,
    })).toString("base64url");
    const input = header + "." + claims;
    const jwt = input + "." + sign(null, Buffer.from(input), this.key).toString("base64url");
    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE, subject_token: jwt, subject_token_type: JWT_TYPE, resource: this.root.href,
    });
    if (Buffer.byteLength(form.toString()) > this.maxBytes) throw new Error("LWS request exceeds maxRequestBytes");
    const server = this.authorizationServer;
    if (!server) throw new Error("Missing authorization server");
    const tokenUrl = new URL(server.href.replace(/\/$/, "") + "/.lws/token");
    const response = await this.send(tokenUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    if (response.status === 401 || response.status === 403) throw new LwsPermissionError("LWS token request refused");
    if (!response.ok) throw new Error("LWS token request failed: " + response.status);
    const value = object(await response.json());
    if (typeof value.access_token !== "string" || !value.access_token ||
        value.token_type !== "Bearer" || typeof value.expires_in !== "number" ||
        !Number.isFinite(value.expires_in) || value.expires_in <= 0) throw new Error("Invalid LWS token response");
    this.cached = { value: value.access_token, expires: this.now() + value.expires_in * 1000 };
    return this.cached.value;
  }

  private async request(url: URL, init: FetchInit): Promise<Response> {
    const original = await this.token();
    let response = await this.send(url, {
      ...init, headers: { ...init.headers, authorization: "Bearer " + original },
    });
    if (response.status === 401) {
      this.discover(response);
      if (this.cached?.value === original) this.cached = undefined;
      const fresh = await this.token();
      response = await this.send(url, {
        ...init, headers: { ...init.headers, authorization: "Bearer " + fresh },
      });
    }
    if (response.status === 401 || response.status === 403 ||
        (response.status === 404 && [...this.created].some((folder) => url.pathname.startsWith(folder)))) {
      throw new LwsPermissionError("LWS permission lost: " + url.href);
    }
    if (response.status === 412) throw new LwsPreconditionFailed(url.href);
    if (!response.ok && response.status !== 404) throw new Error("LWS request failed: " + response.status);
    return response;
  }

  async get(path: string): Promise<LwsFile | null> {
    const response = await this.request(this.url(path), { method: "GET" });
    if (response.status === 404) return null;
    return { etag: etag(response), contentType: response.headers.get("content-type"), body: new Uint8Array(await response.arrayBuffer()) };
  }

  private async put(path: string, body: Uint8Array, contentType: string, condition: Record<string, string>): Promise<string> {
    if (body.byteLength > this.maxBytes) throw new Error("LWS request exceeds maxRequestBytes");
    const response = await this.request(this.url(path), {
      method: "PUT", headers: { ...condition, "content-type": contentType }, body: Buffer.from(body),
    });
    const expectedStatus = condition["if-none-match"] === "*" ? 201 : 204;
    if (response.status !== expectedStatus) throw new Error("Unexpected LWS PUT status: " + response.status);
    return etag(response);
  }

  putIfAbsent(path: string, body: Uint8Array, contentType: string): Promise<string> {
    return this.put(path, body, contentType, { "if-none-match": "*" });
  }
  putIfMatch(path: string, body: Uint8Array, contentType: string, tag: string): Promise<string> {
    return this.put(path, body, contentType, { "if-match": tag });
  }
  async deleteIfMatch(path: string, tag: string): Promise<void> {
    const response = await this.request(this.url(path), { method: "DELETE", headers: { "if-match": tag } });
    if (response.status !== 204) throw new Error("Unexpected LWS DELETE status: " + response.status);
  }
  async ensureContainer(path: string): Promise<void> {
    if (!path.endsWith("/")) throw new Error("Container path must end with /");
    const url = this.url(path);
    try {
      const response = await this.request(url, {
        method: "PUT", headers: { link: '<http://www.w3.org/ns/ldp#Container>; rel="type"', "if-none-match": "*" },
      });
      if (![201, 204].includes(response.status)) throw new Error("Unexpected container status: " + response.status);
      this.created.add(url.pathname);
    } catch (error) {
      if (!(error instanceof LwsPreconditionFailed)) throw error;
      // Do not turn a collision with a non-container into a successful create.
      const response = await this.request(url, { method: "GET", headers: { accept: "application/lws+json" } });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/lws+json")) throw error;
    }
  }

  async *list(containerPath: string): AsyncIterable<ListingItem> {
    if (!containerPath.endsWith("/")) throw new Error("Container path must end with /");
    let next: URL | undefined = this.url(containerPath);
    const visited = new Set<string>();
    while (next) {
      this.checkUrl(next);
      if (visited.has(next.href)) throw new Error("LWS pagination cycle");
      visited.add(next.href);
      const response = await this.request(next, { method: "GET", headers: { accept: "application/lws+json" } });
      if (response.status === 404) throw new Error("LWS container not found");
      const value = object(await response.json());
      const members: unknown = value.items ?? value.contains;
      if (!Array.isArray(members)) throw new Error("Invalid LWS listing members");
      for (const member of members) {
        const item = object(member);
        if (typeof item.id !== "string" || !Array.isArray(item.type) ||
            !item.type.every((type: unknown) => typeof type === "string") ||
            (item.format !== undefined && typeof item.format !== "string")) throw new Error("Invalid LWS listing item");
        yield { id: item.id, type: item.type as string[], ...(typeof item.format === "string" ? { format: item.format } : {}) };
      }
      const link = response.headers.get("link") ?? "";
      const target = /<([^>]+)>\s*;\s*rel\s*=\s*"next"/i.exec(link)?.[1];
      next = target ? new URL(target, next) : undefined;
    }
  }

  async probeConditionalRequests(scratchContainer: string): Promise<void> {
    await this.ensureContainer(scratchContainer);
    const path = scratchContainer + "probe-" + randomUUID();
    let current: string | undefined;
    try {
      const first = await this.putIfAbsent(path, Buffer.from("first"), "text/plain");
      current = first;
      try {
        await this.putIfAbsent(path, Buffer.from("collision"), "text/plain");
        throw new Error("LWS ignored If-None-Match");
      } catch (error) { if (!(error instanceof LwsPreconditionFailed)) throw error; }
      const unguarded = await this.send(this.url(path), {
        method: "PUT", headers: { authorization: "Bearer " + await this.token() }, body: Buffer.from("unguarded"),
      });
      if (unguarded.status !== 428) throw new Error("LWS did not require If-Match for replacement");
      current = await this.putIfMatch(path, Buffer.from("second"), "text/plain", first);
      if (current === first) throw new Error("LWS ETag did not change");
      try {
        await this.putIfMatch(path, Buffer.from("stale"), "text/plain", first);
        throw new Error("LWS ignored stale If-Match");
      } catch (error) { if (!(error instanceof LwsPreconditionFailed)) throw error; }
      try {
        await this.deleteIfMatch(path, first);
        throw new Error("LWS ignored stale DELETE If-Match");
      } catch (error) { if (!(error instanceof LwsPreconditionFailed)) throw error; }
      await this.deleteIfMatch(path, current);
      current = undefined;
      try {
        await this.putIfMatch(path, Buffer.from("missing"), "text/plain", "*");
        throw new Error("LWS ignored If-Match on missing file");
      } catch (error) { if (!(error instanceof LwsPreconditionFailed)) throw error; }
    } finally {
      if (current) {
        // Best effort only: never overwrite or delete an unexpected concurrent winner.
        try { await this.deleteIfMatch(path, current); } catch { /* preserve probe failure */ }
      }
    }
  }
}

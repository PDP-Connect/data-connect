// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Minimal JSON-RPC client for the chain reads and the one write (the escrow
// deposit) this demo does. The URL is gated by loadConfig like the gateway's.

import type { FetchLike } from "../../reminder-service/lib/oauth.ts";

export class JsonRpc {
  private id = 0;
  private readonly fetchImpl: FetchLike;
  private readonly url: string;

  constructor(url: string, fetchImpl?: FetchLike) {
    this.url = url;
    this.fetchImpl = fetchImpl ?? ((u, init) => fetch(u, init));
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.id += 1;
    const resp = await this.fetchImpl(this.url, {
      body: JSON.stringify({ id: this.id, jsonrpc: "2.0", method, params }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await resp.json()) as { error?: { message?: string }; result?: T };
    if (json.error) {
      throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    return json.result as T;
  }
}

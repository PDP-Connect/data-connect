// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Idempotent registration on the data-gateway: the builder once, then per
// child its server, its data point (version 1) and its grant. Each step is
// skipped when local state already has its id; when state was lost, a 409
// from the gateway is resolved by reading the existing row back. Nothing
// here needs gas from us: the gateway's relayer settles every row on chain.

import type { Hex } from "viem";
import type { MokshaConfig } from "./config.ts";
import type { GatewayClient, GatewayGrant } from "./gateway.ts";
import type { MokshaKeys } from "./keys.ts";
import type { ChildState, MokshaState } from "./state.ts";
import { childDataHash, computeDataPointId, METADATA_HASH } from "./typed-data.ts";

export class RegistrationError extends Error {
  readonly response: unknown;
  readonly status: number;
  constructor(step: string, status: number, response: unknown) {
    const detail = (response as { error?: string } | null)?.error ?? JSON.stringify(response);
    super(`${step} failed: HTTP ${status} ${detail}`);
    this.status = status;
    this.response = response;
  }
}

export const BUILDER_APP_URL = "";

export class Registrar {
  private readonly config: MokshaConfig;
  private readonly gateway: GatewayClient;
  private readonly inFlight = new Map<string, Promise<ChildState>>();
  private readonly keys: MokshaKeys;
  private readonly log: (line: Record<string, unknown>) => void;
  private builderInFlight: Promise<string> | null = null;
  private readonly state: MokshaState;

  constructor(opts: {
    config: MokshaConfig;
    gateway: GatewayClient;
    keys: MokshaKeys;
    log?: (line: Record<string, unknown>) => void;
    state: MokshaState;
  }) {
    this.config = opts.config;
    this.gateway = opts.gateway;
    this.keys = opts.keys;
    this.state = opts.state;
    this.log = opts.log ?? (() => {});
  }

  /** builderId (bytes32) of the reminder service. */
  ensureBuilder(): Promise<string> {
    const known = this.state.data.builder?.builderId;
    if (known) {
      return Promise.resolve(known);
    }
    this.builderInFlight ??= this.registerBuilder().finally(() => {
      this.builderInFlight = null;
    });
    return this.builderInFlight;
  }

  private async registerBuilder(): Promise<string> {
    const builder = this.keys.builder;
    const res = await this.gateway.registerBuilder(builder, builder, BUILDER_APP_URL);
    let builderId: string | undefined;
    if (res.status === 201) {
      builderId = res.body.builderId;
    } else if (res.status === 409) {
      const existing = await this.gateway.getBuilder(builder.address);
      if (existing.status !== 200 || !existing.body.data) {
        throw new RegistrationError("builder lookup after 409", existing.status, existing.body);
      }
      builderId = existing.body.data.id;
    } else {
      throw new RegistrationError("POST /v1/builders", res.status, res.body);
    }
    if (!builderId) {
      throw new RegistrationError("POST /v1/builders (no builderId)", res.status, res.body);
    }
    this.state.data.builder = { address: builder.address, builderId, registeredAt: this.state.nowIso() };
    this.state.save();
    this.log({ builderId, event: "builder_registered", status: res.status });
    return builderId;
  }

  /**
   * The hook: server, data point and grant for one child, before its first
   * paid read. Safe to call on every read; it returns at once when done.
   */
  ensureChild(childId: string): Promise<ChildState> {
    const existing = this.state.data.children[childId];
    if (existing?.registeredAt) {
      return Promise.resolve(existing);
    }
    let p = this.inFlight.get(childId);
    if (!p) {
      p = this.registerChild(childId).finally(() => this.inFlight.delete(childId));
      this.inFlight.set(childId, p);
    }
    return p;
  }

  private childState(childId: string): ChildState {
    let c = this.state.data.children[childId];
    if (!c) {
      const known = Object.keys(this.state.data.children).length;
      if (known >= this.config.maxChildren) {
        throw new Error(`child cap reached (${this.config.maxChildren}, VACUNA_MOKSHA_MAX_CHILDREN); not registering ${childId}`);
      }
      c = {
        childId,
        dataPointId: null,
        dataVersion: null,
        grantChain: null,
        grantId: null,
        grantPaid: false,
        grantPaymentReadId: null,
        grantVersion: null,
        ownerAddress: this.keys.childOwner(childId).address,
        registeredAt: null,
        serverAddress: this.keys.childServer(childId).address,
        serverId: null,
      };
      this.state.data.children[childId] = c;
      this.state.save();
    }
    return c;
  }

  private async registerChild(childId: string): Promise<ChildState> {
    const builderId = await this.ensureBuilder();
    const c = this.childState(childId);
    const owner = this.keys.childOwner(childId);
    const server = this.keys.childServer(childId);

    if (!c.serverId) {
      const res = await this.gateway.registerServer(owner, server, this.config.serverUrl);
      if (res.status === 201 && res.body.serverId) {
        c.serverId = res.body.serverId;
      } else if (res.status === 409) {
        const got = await this.gateway.getServer(server.address);
        const d = got.body.data;
        if (got.status !== 200 || !d || d.ownerAddress.toLowerCase() !== owner.address.toLowerCase() || d.revokedAt) {
          throw new RegistrationError(`server lookup for ${childId} after 409`, got.status, got.body);
        }
        c.serverId = d.id;
      } else {
        throw new RegistrationError(`POST /v1/servers for ${childId}`, res.status, res.body);
      }
      this.state.save();
      this.log({ child: childId, event: "server_registered", serverId: c.serverId, status: res.status });
    }

    if (!c.dataVersion) {
      const dataPointId = computeDataPointId(owner.address, this.config.scope);
      const res = await this.gateway.addData(server, {
        dataHash: childDataHash(this.config.scope, childId),
        expectedVersion: 1n,
        metadataHash: METADATA_HASH,
        ownerAddress: owner.address,
        scope: this.config.scope,
      });
      if (res.status === 201) {
        c.dataPointId = res.body.dataPointId ?? dataPointId;
        c.dataVersion = "1";
      } else if (res.status === 409) {
        const got = await this.gateway.getDataPoint(dataPointId);
        if (got.status !== 200 || !got.body.data) {
          throw new RegistrationError(`data point lookup for ${childId} after 409`, got.status, got.body);
        }
        c.dataPointId = got.body.data.id;
        c.dataVersion = got.body.data.expectedVersion;
      } else {
        throw new RegistrationError(`POST /v1/data for ${childId}`, res.status, res.body);
      }
      this.state.save();
      this.log({ child: childId, dataPointId: c.dataPointId, event: "data_point_registered", status: res.status });
    }

    if (!c.grantId) {
      let grant = await this.findGrant(c);
      if (!grant || grant.revokedAt) {
        const version = grant ? BigInt(grant.grantVersion) + 1n : 1n;
        const res = await this.gateway.registerGrant(owner, {
          expiresAt: 0n,
          grantVersion: version,
          granteeId: builderId as Hex,
          scopes: [this.config.scope],
        });
        if (res.status !== 201 && res.status !== 200 && res.status !== 409) {
          throw new RegistrationError(`POST /v1/grants for ${childId}`, res.status, res.body);
        }
        this.log({ child: childId, event: "grant_registered", grantId: res.body.grantId ?? null, status: res.status });
        grant = await this.findGrant(c);
        if (!grant) {
          throw new RegistrationError(`grant lookup for ${childId}`, res.status, res.body);
        }
      }
      if (!grant.scopes.includes(this.config.scope)) {
        throw new Error(`existing grant ${grant.id} for ${childId} does not cover ${this.config.scope}`);
      }
      c.grantId = grant.id;
      this.applyGrant(c, grant);
    }

    c.registeredAt = this.state.nowIso();
    this.state.save();
    return c;
  }

  private async findGrant(c: ChildState): Promise<GatewayGrant | null> {
    const res = await this.gateway.listGrants(c.ownerAddress, this.keys.builder.address);
    if (res.status !== 200) {
      throw new RegistrationError(`GET /v1/grants for ${c.childId}`, res.status, res.body);
    }
    return res.body.data?.grants?.[0] ?? null;
  }

  private applyGrant(c: ChildState, g: GatewayGrant): void {
    c.grantVersion = g.grantVersion;
    c.grantPaid = g.paymentStatus === "paid";
    c.grantChain = { paymentStatus: g.paymentStatus, settleTxHash: g.settleTxHash, status: g.status };
    this.state.save();
  }

  /** Re-reads a registered child's grant (status, payment, settle tx). */
  async refreshGrant(childId: string): Promise<ChildState | null> {
    const c = this.state.data.children[childId];
    if (!c?.grantId) {
      return null;
    }
    const g = await this.findGrant(c);
    if (g) {
      this.applyGrant(c, g);
    }
    return c;
  }
}

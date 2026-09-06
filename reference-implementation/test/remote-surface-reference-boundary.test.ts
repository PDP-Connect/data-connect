// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type TestContext, test } from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";

const REGEXP_1 = /run\.stream_session_opened/;
const REGEXP_2 = /run\.stream_session_resolved/;
const REGEXP_3 = /@opendatalabs\/remote-surface/;
const REGEXP_4 = /@opendatalabs\/remote-surface/;
const REGEXP_5 = /@opendatalabs\/remote-surface/;
const REGEXP_6 = /streaming-target/;
const REGEXP_7 = /resolveStreamingRegistrationFromEnv/;
const REGEXP_8 = /PDPP_STREAMING_REGISTRATION_TOKEN/;
const REGEXP_12 = /from ['"]\.\/protocol-wire\.ts['"]/;
const REGEXP_13 = /@opendatalabs\/remote-surface/;
const REGEXP_14 = /\/_ref\/runs\/:runId\/run-interaction-stream/;
const REGEXP_15 = /from ['"]@opendatalabs\/remote-surface\/server['"]/;
const REGEXP_16 = /\/_ref\/run-interaction-streams\/:token\/events/;
const REGEXP_17 = /object: ["']run_interaction_stream_session["']/;
const REGEXP_18 = /run\.stream_session_requested/;

type LeasesModule = typeof import("@opendatalabs/remote-surface/leases");

function read(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function retainedIdleSurface(overrides: Partial<BrowserSurface> = {}): BrowserSurface {
  return {
    backend: "neko",
    cdp_url: "http://neko:9222",
    connector_id: "retained-connector",
    created_at: "2026-07-22T12:00:00.000Z",
    health: "ready",
    last_used_at: "2026-07-22T12:00:00.000Z",
    profile_key: "retained-profile",
    retained: true,
    stream_base_url: "http://neko:8080",
    surface_id: "retained_surface",
    ...overrides,
  };
}

async function loadLeaseManager(t: TestContext): Promise<LeasesModule | null> {
  try {
    // biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
    return await import("@opendatalabs/remote-surface/leases");
  } catch {
    t.skip("@opendatalabs/remote-surface not installed; skipping installed-package retention assertion");
    return null;
  }
}

function createRetainedSurfaceManager(leases: LeasesModule) {
  return new leases.BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 60_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["retained-connector", "background-connector"]),
      priorityRanks: leases.DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode: "dynamic",
    },
    initialSurfaces: [retainedIdleSurface()],
    now: () => new Date("2026-07-22T12:10:00.000Z"),
  });
}

test("reference streaming routes adapt package session APIs while owning the PDPP wire shape and preserving _ref ownership", () => {
  const sessionsShim = read("reference-implementation/server/streaming/sessions.ts");
  const routes = read("reference-implementation/server/streaming/routes.ts");
  const protocolWire = read("reference-implementation/server/streaming/protocol-wire.ts");

  // The package's SESSION store is still consumed through the sessions shim,
  // which translates the host-neutral package API into the reference's
  // snake_case (_ref/run_id/interaction_id) contract.
  assert.match(sessionsShim, REGEXP_15);

  // Post-extraction the package's protocol export dropped its PDPP-shaped wire
  // parsers (they were host-specific). PDPP now OWNS its wire shapes locally in
  // protocol-wire.ts, and routes.ts consumes that local module — not the
  // package protocol. protocol-wire.ts must not reach back into the package.
  assert.match(routes, REGEXP_12);
  assert.doesNotMatch(protocolWire, REGEXP_13, "protocol-wire.ts is reference-owned; it must not import the package");

  // _ref route ownership + event-name contract are unchanged.
  assert.match(routes, REGEXP_14);
  assert.match(routes, REGEXP_16);
  assert.match(routes, REGEXP_17);
  assert.match(routes, REGEXP_18);
  assert.match(routes, REGEXP_1);
  assert.match(routes, REGEXP_2);
});

test("run-target registry and connector handoff remain reference-owned host orchestration", () => {
  const registry = read("reference-implementation/server/streaming/run-target-registry.ts");
  // Read from the installed @pdpp/polyfill-connectors package (not the
  // repo-root packages/polyfill-connectors/ vendoring-trick copy, which RI no
  // longer imports): both source files' content is what these assertions
  // check, and the package copy is the one actually reachable/loaded at
  // runtime. Both browser-handoff and streaming-target-registration are
  // already-blessed exports, shipped compiled — reading the .js sibling
  // (not the .ts, which data-connectors#68 stopped shipping) since the
  // import/reference patterns these assertions check survive compilation
  // unchanged (verified: same matches/doesNotMatch results either way).
  const handoff = readFileSync(
    new URL("../../node_modules/@pdpp/polyfill-connectors/src/browser-handoff.js", import.meta.url),
    "utf8"
  );
  const registration = readFileSync(
    new URL("../../node_modules/@pdpp/polyfill-connectors/src/streaming-target-registration.js", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(registry, REGEXP_3);
  assert.doesNotMatch(handoff, REGEXP_4);
  assert.doesNotMatch(registration, REGEXP_5);
  assert.match(registry, REGEXP_6);
  assert.match(handoff, REGEXP_7);
  assert.match(registration, REGEXP_8);
});

// This file previously also asserted (in a test named "dynamic n.eko
// allocation seams use package leases while Docker lifecycle stays
// reference-owned") that `docker-compose.neko.yml` at the repo root
// declares the neko service and that PDPP's allocator owns the Docker
// lifecycle -- a pdpp-repo-root deployment-config invariant. That compose
// file (and `docker/neko/*`) has not been ported into this repo's own
// `deploy/` tree (PR #43 explicitly scoped the Dockerfile port only, not
// neko/compose orchestration -- that's an undecided deployment-architecture
// question, not something to invent here). Removed the compose-file
// assertion; the lease-store/`@opendatalabs/remote-surface` consumer
// assertion in this file's other tests is unaffected and stays.

test("installed remote-surface excludes retained surfaces from idle-TTL reap", async (t) => {
  const leases = await loadLeaseManager(t);
  if (!leases) {
    return;
  }

  const manager = createRetainedSurfaceManager(leases);
  const stopped: unknown[] = [];
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface() {
      throw new Error("not exercised by this test");
    },
    getSurfaceStatus() {
      throw new Error("not exercised by this test");
    },
    listSurfaces() {
      throw new Error("not exercised by this test");
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async stopSurface(request) {
      stopped.push(request);
      return retainedIdleSurface({ health: "stopping" });
    },
  };

  const idleResult = await manager.cleanupIdleSurfaces(allocator);
  assert.deepEqual(idleResult.stopped, [], "retained surface must not be idle-TTL reaped");
  assert.deepEqual(stopped, [], "idle-TTL must not call the allocator for a retained surface");
});

test("installed remote-surface excludes retained surfaces from capacity-pressure reap", async (t) => {
  const leases = await loadLeaseManager(t);
  if (!leases) {
    return;
  }

  const manager = createRetainedSurfaceManager(leases);

  const waiting = manager.acquire({
    connectorId: "background-connector",
    priorityClass: "background",
    profileKey: "background-profile",
    runId: "background_run",
  });
  assert.equal(waiting.lease.status, "waiting_for_browser_surface");
  assert.equal(waiting.lease.wait_reason, "capacity_full");
  assert.equal(
    manager.planCapacityPressureReclaim(waiting.lease.lease_id),
    undefined,
    "capacity pressure must leave a retained idle surface alone"
  );
});

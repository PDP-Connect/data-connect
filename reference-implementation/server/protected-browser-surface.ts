// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  BrowserSurface,
  BrowserSurfaceAllocator,
  BrowserSurfaceLeaseManager,
} from "@opendatalabs/remote-surface/leases";
import {
  BrowserBindingOwnerActionRequired,
  BrowserBindingPlacementRefused,
  refuseBindingControl,
} from "../runtime/binding-control.ts";
import type { ControllerOptions } from "../runtime/controller.ts";
import type { BrowserBindingAdmissionOptions, createBrowserBindingAdmission } from "./browser-binding-admission.ts";
import { newBrowserBindingApprovalExpiry } from "./browser-binding-lifetime.ts";

type Admission = ReturnType<typeof createBrowserBindingAdmission>;
type Preparation = Awaited<ReturnType<Admission["prepareRun"]>>;
interface BoundRun {
  activation?: ReturnType<Admission["activateRun"]>;
  cleanup?: Promise<"stopped" | "not_acquired"> | undefined;
  readonly connectionId: string;
  readonly deadline: number;
  handoffFencingToken?: number;
  readonly leaseId: string;
  readonly prepared: Promise<Preparation>;
  readonly profileKey: string;
  readonly runId: string;
  stopped: boolean;
  readonly surfaceId: string;
}

/** The lease owns scheduling/fencing. This adapter only maps its public aliases
 * to exact admitted resources; neither aliases nor service credentials approve access. */
export function protectedBrowserSurfaceControllerOptions(
  admission: Admission,
  options: BrowserBindingAdmissionOptions,
  manager: BrowserSurfaceLeaseManager,
  readinessTimeoutMs: number
): Pick<
  ControllerOptions,
  "browserSurfaceAllocator" | "beforeBrowserSurfaceLeaseEnsure" | "protectedBrowserSurfaceLifecycle"
> {
  const lifecycle = options.syncLifecycle;
  if (manager.config.surfaceMode !== "dynamic" || !lifecycle) {
    refuseBindingControl();
  }
  newBrowserBindingApprovalExpiry(lifecycle, Date.now());
  const expectedManifests = new Map<string, unknown>();
  const runs = new Map<string, BoundRun>();
  const aliases = new Map<string, BoundRun>();
  const budget = Math.min(readinessTimeoutMs, options.allocator.timeoutMs);
  const lookup = (surfaceId: string) => {
    const run = aliases.get(surfaceId);
    if (!run || run.stopped) {
      return refuseBindingControl();
    }
    return run;
  };
  const status = async (run: BoundRun, freshPolicy = false): Promise<BrowserSurface> => {
    const prepared = await run.prepared;
    const actual = await admission.statusRun(run.connectionId, run.runId, freshPolicy);
    const lease = manager.getLease(run.leaseId);
    if (
      run.stopped ||
      !lease ||
      lease.run_id !== run.runId ||
      lease.surface_id !== run.surfaceId ||
      !["starting_surface", "leased"].includes(lease.status) ||
      (run.handoffFencingToken !== undefined && lease.fencing_token !== run.handoffFencingToken) ||
      aliases.get(run.surfaceId) !== run ||
      actual.container_id !== prepared.reservation.resource.containerId ||
      actual.browser_generation_hash !== prepared.reservation.resource.generation
    ) {
      refuseBindingControl();
    }
    return {
      ...actual,
      profile_key: run.profileKey,
      surface_id: run.surfaceId,
      surface_subject_id: run.connectionId,
    } as unknown as BrowserSurface;
  };
  const release = async (runId: string, reconcile = false) => {
    const run = runs.get(runId);
    if (!run) {
      expectedManifests.delete(runId);
      return "not_acquired" as const;
    }
    run.stopped = true;
    if (reconcile && run.cleanup) {
      await run.cleanup.catch(() => {
        run.cleanup = undefined;
      });
    }
    run.cleanup ??= (async () => {
      try {
        await run.prepared;
      } catch (error) {
        if (!(error instanceof BrowserBindingPlacementRefused)) {
          throw error;
        }
        aliases.delete(run.surfaceId);
        return "not_acquired" as const;
      }
      try {
        await admission.stopRun(run.connectionId, runId, Date.now() + options.allocator.timeoutMs);
      } finally {
        // Stop owns remote start/stop fencing. Join the local request as well,
        // so an unresolved activation cannot outlive reported cleanup.
        await run.activation?.catch(() => undefined);
      }
      aliases.delete(run.surfaceId);
      expectedManifests.delete(runId);
      return "stopped" as const;
    })();
    return await run.cleanup;
  };
  const allocator: BrowserSurfaceAllocator = {
    async ensureSurface(request) {
      const run = lookup(request.surfaceId);
      const prepared = await run.prepared;
      if (run.stopped || aliases.get(run.surfaceId) !== run) {
        refuseBindingControl();
      }
      if (!prepared.approved) {
        throw new BrowserBindingOwnerActionRequired({
          connectionId: run.connectionId,
          kind: "confirm_browser_access",
          proposalId: prepared.proposal.proposalId,
        });
      }
      if (!run.activation) {
        // Mark dispatch once, including failed/ambiguous transports. No retry start.
        run.activation = Promise.resolve().then(() => {
          if (run.stopped || aliases.get(run.surfaceId) !== run) {
            refuseBindingControl();
          }
          return admission.activateRun(run.connectionId, { deadline: run.deadline, runId: run.runId });
        });
      }
      await run.activation;
      if (run.stopped || aliases.get(run.surfaceId) !== run) {
        refuseBindingControl();
      }
      return await status(run, true);
    },
    async getSurfaceStatus(surfaceId) {
      const run = aliases.get(surfaceId);
      if (!run?.activation || run.stopped) {
        return null;
      }
      await run.activation;
      return run.stopped ? null : await status(run);
    },
    listSurfaces() {
      return Promise.resolve([]);
    },
    async stopSurface(request) {
      await release(lookup(request.surfaceId).runId);
      return null;
    },
  };
  return {
    async beforeBrowserSurfaceLeaseEnsure({ connectionId, runId, surfaceId }) {
      if (!connectionId) {
        refuseBindingControl();
      }
      let run = runs.get(runId);
      if (!run) {
        if (aliases.has(surfaceId)) {
          refuseBindingControl();
        }
        const deadline = Date.now() + budget;
        const profileKey = manager.getSurface(surfaceId)?.profile_key;
        if (!profileKey) {
          refuseBindingControl();
        }
        const lease = manager.listLeases().find((item) => item.run_id === runId && item.surface_id === surfaceId);
        if (!lease) {
          refuseBindingControl();
        }
        run = {
          connectionId,
          deadline,

          leaseId: lease.lease_id,
          prepared: admission.prepareRun({
            connectionId,
            deadline,
            expectedManifest: expectedManifests.get(runId),
            ...lifecycle,
            runId,
          }),
          profileKey,
          runId,
          stopped: false,
          surfaceId,
        };
        runs.set(runId, run);
        aliases.set(surfaceId, run);
      }
      if (run.stopped || run.connectionId !== connectionId || run.surfaceId !== surfaceId) {
        refuseBindingControl();
      }
      const prepared = await run.prepared;
      if (!prepared.approved) {
        throw new BrowserBindingOwnerActionRequired({
          connectionId,
          kind: "confirm_browser_access",
          proposalId: prepared.proposal.proposalId,
        });
      }
    },
    browserSurfaceAllocator: allocator,
    protectedBrowserSurfaceLifecycle: {
      async admit({ connectionId, runId, manifest }) {
        await admission.assertRunManifest(connectionId, runId, manifest);
        expectedManifests.set(runId, structuredClone(manifest));
      },
      async handoff({ runId, surfaceId, signal }) {
        const run = lookup(surfaceId);
        const lease = manager.listLeases().find((item) => item.run_id === runId && item.surface_id === surfaceId);
        if (
          !lease ||
          lease.lease_id !== run.leaseId ||
          (run.handoffFencingToken !== undefined && lease.fencing_token !== run.handoffFencingToken) ||
          lease.status !== "leased" ||
          run.runId !== runId ||
          signal.aborted
        ) {
          refuseBindingControl();
        }
        const fencingToken = lease.fencing_token;
        const actual = await status(run, true);
        const authority = await admission.getRunAuthority(run.connectionId, runId, true);
        const current = manager.getLease(lease.lease_id);
        if (
          signal.aborted ||
          actual.health !== "ready" ||
          current?.status !== "leased" ||
          current.fencing_token !== fencingToken ||
          current.surface_id !== surfaceId ||
          manager.getSurface(surfaceId)?.active_lease_id !== lease.lease_id ||
          manager.getSurface(surfaceId)?.container_id !== actual.container_id ||
          manager.getSurface(surfaceId)?.cdp_url !== actual.cdp_url
        ) {
          refuseBindingControl();
        }
        run.handoffFencingToken = fencingToken;
        return authority;
      },
      release,
      async resolvePlacementFailure(runId) {
        const run = runs.get(runId);
        if (run && !run.stopped) {
          await admission.assertRunPolicy(run.connectionId, runId);
        }
      },
      retainedState: () => ({ aliases: aliases.size, manifests: expectedManifests.size, runs: runs.size }),
      async retire(runId) {
        const run = runs.get(runId);
        if (run && (!run.stopped || aliases.has(run.surfaceId))) {
          refuseBindingControl();
        }
        if (run) {
          const preparation = await run.prepared.catch((error: unknown) => {
            if (!(error instanceof BrowserBindingPlacementRefused)) {
              throw error;
            }
            return null;
          });
          if (preparation) {
            await admission.disposeRun(preparation.reservation, runId);
          }
        }
        runs.delete(runId);
        expectedManifests.delete(runId);
      },
    },
  };
}

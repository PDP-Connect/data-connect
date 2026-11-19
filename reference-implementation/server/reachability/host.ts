// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostCapabilities, Usage } from "@tnunamak/gozar";
import { isLoopbackBindHost } from "../reachability-contract.ts";
import type { OwnerReachabilityContext } from "../routes/owner-reachability.ts";
import { createCredentialCipher, resolveCredentialEncryptionKey, type CredentialCipher } from "../stores/credential-encryption.ts";
import { ReachabilityError } from "./approvals.ts";
import { startDesktopReachability, requireUsableSocketHome } from "./desktop-host.ts";
import { createReachabilityService } from "./factory.ts";
import { loadHostIdentity } from "./identity.ts";
import { createHostSecretBackend } from "./secret-backend.ts";
import { createSealedFileSecretBackend } from "./sealed-file-secret-backend.ts";

/** What the process that hosts remote access injects into the server. */
export type StartedReachability = Pick<OwnerReachabilityContext, "passwordSet" | "service" | "statePaths" | "usage"> & {
  /** Answers the service challenge on the resource-server listener. Absent where another process answers it. */
  serviceVerifier?: (req: unknown, res: unknown) => boolean;
};

type Row = {
  capabilities: Record<
    "installer.execute" | "privilege.elevate" | "runtime.attached" | "runtime.durable" | "secrets.backend",
    boolean
  >;
  usage: ReadonlySet<Usage["kind"]>;
};

// What differs between the processes that run this server. The browser never
// chooses any of it. The desktop row lives in desktop-host.ts: its settings
// bridge, supervised console and key custody belong to the desktop supervisor.
// The server row is for a headless process with no supervisor: a container or a
// service that owns its data directory.
const SERVER_ROW: Row = {
  capabilities: {
    // The public API has no installer executor; the image carries what the
    // providers need. False reads as "denied by this host".
    "installer.execute": false,
    // The server user has no elevation channel.
    "privilege.elevate": false,
    // The server holds attached leases for its whole life, and the data volume
    // lets durable records survive a restart.
    "runtime.attached": true,
    "runtime.durable": true,
    // The sealed-file backend is always the one in use. A missing or wrong key
    // is a state that `presence` reports, and a returning key clears a lock.
    "secrets.backend": true,
  },
  // A session route has no owner-visible lifetime control in this host.
  usage: new Set<Usage["kind"]>(["attached", "durable"]),
};
const DURABLE_ROUTE_ID = "owner-route";

export type ReachabilityHostInput = {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  bindHost: string;
  /** The resource-server port the route's traffic reaches. */
  rsPort: number;
  owner: string;
  passwordConfigured: boolean;
  /** "server" asks for the headless row where no desktop supervisor is present. */
  profile?: "server" | undefined;
};

/**
 * Picks the host row for this process. A desktop supervisor selects the desktop
 * row; the server row starts only when the caller asks for it, so a process that
 * embeds the server (a test, a tool) does not start a route host by accident.
 */
export async function startHostReachability(input: ReachabilityHostInput): Promise<StartedReachability | undefined> {
  if (input.env.PDPP_MANAGED_DESKTOP_HOST === "1") {
    return startDesktopReachability({
      bindHost: input.bindHost,
      dataDir: input.dataDir,
      owner: input.owner,
      passwordConfigured: input.passwordConfigured,
    });
  }
  return input.profile === "server" ? startServerReachability(input) : undefined;
}

// Resolves the key on every call so a mount that returns unlocks the backend.
// The same key value gives the same cipher object: the backend caches what it
// learns per cipher, so a poll does not pay the key derivation again.
function cipherSource(env: NodeJS.ProcessEnv): () => CredentialCipher | null {
  let last: { key: string; cipher: CredentialCipher } | null = null;
  return () => {
    try {
      const key = resolveCredentialEncryptionKey(env);
      if (!key) {
        return null;
      }
      if (last?.key !== key) {
        last = { cipher: createCredentialCipher(key), key };
      }
      return last.cipher;
    } catch {
      return null;
    }
  };
}

export async function startServerReachability(input: ReachabilityHostInput): Promise<StartedReachability | undefined> {
  if (!(Number.isInteger(input.rsPort) && input.rsPort > 0)) {
    // A route needs a fixed target. An ephemeral port is not one.
    return undefined;
  }
  const { createServiceVerifier } = await import("@tnunamak/gozar");
  const { dataDir, env } = input;
  const identity = loadHostIdentity(join(dataDir, "reachability"));
  const home = join(dataDir, "reachability-home");
  mkdirSync(home, { mode: 0o700, recursive: true });
  const hostCapabilities: HostCapabilities = Object.fromEntries(
    Object.entries(SERVER_ROW.capabilities).map(([id, value]) => [id, { known: true, value }] as const)
  );
  const service = await createReachabilityService(
    {
      hostCapabilities,
      identity,
      secretBackend: createHostSecretBackend(
        createSealedFileSecretBackend(join(dataDir, "reachability-secrets"), cipherSource(env))
      ),
    },
    {
      // A route change never rebinds this server's own listener, so there is no
      // connection of the owner's for it to cut off.
      recoverAtBoot: true,
      acknowledgeDisconnect: async () => undefined,
      prepare: async () => requireUsableSocketHome(home),
      query: {
        home,
        owner: input.owner,
        requirements: {
          address: "any",
          payloadAccess: "allow-provider",
          protocols: [],
          reach: "internet",
          setup: "allow",
          transport: "https",
        },
        schemaVersion: 1,
        target: `127.0.0.1:${input.rsPort}`,
      },
    }
  );
  // Where the listener binds is the one fact the lifecycle needs about confinement.
  service.observeHostConfinement({ known: true, value: isLoopbackBindHost(input.bindHost) });
  return {
    service,
    serviceVerifier: createServiceVerifier(),
    usage: (kind) => {
      if (kind === "attached" && SERVER_ROW.usage.has("attached")) {
        return { kind: "attached" };
      }
      if (kind === "durable" && SERVER_ROW.usage.has("durable")) {
        return { kind: "durable", routeId: DURABLE_ROUTE_ID };
      }
      throw new ReachabilityError("invalid_input");
    },
  };
}

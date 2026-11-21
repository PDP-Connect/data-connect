// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostCapabilities } from "@tnunamak/gozar";
import { ownerPasswordOwnerSet } from "../owner-password-owner-set.ts";
import { offRemoteAccessConfig } from "../remote-access-config.ts";
import { createRemoteAccessConfigStore } from "../remote-access-store.ts";
import { isCredentialEncryptionConfigured } from "../stores/credential-encryption.ts";
import type { OwnerReachabilityContext } from "../routes/owner-reachability.ts";
import { ReachabilityError } from "./approvals.ts";
import { consoleChallengeHeader, consoleProof, consoleProofHeader, consoleProofPath, launcherPid } from "./console-proof.ts";
import { createReachabilityService } from "./factory.ts";
import type { HostSettingsBridge } from "./host-settings.ts";
import { fixStatePaths, inspectStatePaths } from "./state-paths.ts";
import { createHostSecretBackend, createSealedSecretBackend } from "./secret-backend.ts";

function known<T>(value: T) {
  return { known: true as const, value };
}

const unknown = { known: false as const, reason: "supervised-console-unavailable" };

type Lease = { pid: number; owner_pid: number; owner_started_at_ticks: number; port: number };
async function desktopLease(dataDir: string, label: "console" | "reference-implementation"): Promise<Lease> {
  const raw = JSON.parse(await readFile(join(dirname(dataDir), "run", `${label}.json`), "utf8")) as Lease & { label: string };
  if (raw.label !== label || !Number.isSafeInteger(raw.pid) || raw.pid < 1 ||
      !Number.isSafeInteger(raw.owner_pid) || raw.owner_pid < 1 || !Number.isSafeInteger(raw.owner_started_at_ticks) ||
      raw.owner_started_at_ticks <= 0 || !Number.isSafeInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
    throw new ReachabilityError("host_supervisor_unavailable");
  }
  return raw;
}

async function observedConsole(dataDir: string, proofKey: string): Promise<Lease> {
  const [reference, console] = await Promise.all([
    desktopLease(dataDir, "reference-implementation"),
    desktopLease(dataDir, "console"),
  ]);
  // Both leases name launcher processes. Each launcher is the direct
  // parent of the Node server it supervises.
  if (reference.pid !== launcherPid() || console.owner_pid !== reference.owner_pid ||
      console.owner_started_at_ticks !== reference.owner_started_at_ticks) {
    throw new ReachabilityError("host_supervisor_unavailable");
  }
  const challenge = randomBytes(32).toString("hex");
  const response = await fetch(`http://127.0.0.1:${console.port}${consoleProofPath}`, {
    cache: "no-store",
    headers: { [consoleChallengeHeader]: challenge },
    redirect: "error",
    signal: AbortSignal.timeout(2000),
  });
  const proof = response.headers.get(consoleProofHeader);
  if (response.status !== 204 || !proof || !/^[0-9a-f]{64}$/.test(proof) ||
      !timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(consoleProof(proofKey, challenge, console.pid, console.port), "hex"))) {
    await response.body?.cancel();
    throw new ReachabilityError("host_supervisor_unavailable");
  }
  return console;
}

// Gozar binds a Unix socket named `resolver-<12 hex>.sock` directly under its
// home. Linux limits an AF_UNIX path (sun_path is 108 bytes with its NUL), and
// Gozar's own control-socket check uses 103. A longer path makes the bind fail
// with EINVAL after review, which the SDK hides as an unexpected fault and which
// leaves an uncertain route. Reject it before any provider is contacted.
const RESOLVER_SOCKET_NAME_BYTES = "resolver-".length + 12 + ".sock".length;
const MAX_SOCKET_PATH_BYTES = 103;
export function requireUsableSocketHome(home: string): void {
  if (Buffer.byteLength(home) + 1 + RESOLVER_SOCKET_NAME_BYTES > MAX_SOCKET_PATH_BYTES) {
    throw new ReachabilityError("host_path_too_long");
  }
}

export async function startDesktopReachability(input: {
  dataDir: string;
  bindHost: string;
  owner: string;
  passwordConfigured: boolean;
}): Promise<Pick<OwnerReachabilityContext, "passwordSet" | "service" | "statePaths" | "usage"> | undefined> {
  const proofKey = process.env.PDPP_OWNER_CREDENTIAL_REVEAL_PROOF;
  if (process.env.PDPP_MANAGED_DESKTOP_HOST !== "1" || input.bindHost !== "127.0.0.1" || !proofKey) return;
  const dataDir = await realpath(input.dataDir);
  const reference = await desktopLease(dataDir, "reference-implementation").catch(() => null);
  if (reference?.pid !== launcherPid()) return;
  const home = join(dataDir, "reachability");
  const passwordReady = async () => input.passwordConfigured && await ownerPasswordOwnerSet(dataDir);
  const observe = () => observedConsole(dataDir, proofKey).catch(() => null);
  const config = createRemoteAccessConfigStore(dataDir);
  const read: HostSettingsBridge["read"] = async () => {
    const [saved, listener, password] = await Promise.all([config.load(), observe(), passwordReady()]);
    return {
      revision: createHash("sha256").update(JSON.stringify([
        saved.posture, saved.console_port ?? null, listener?.pid ?? null, listener?.port ?? null,
      ])).digest("hex"),
      mode: saved.posture === "off" ? "off" : saved.posture === "my_devices_only" ? "lan" : "route",
      password: known(password),
      confinement: listener ? known(true) : unknown,
      port: listener ? known(listener.port) : unknown,
      target: listener ? known(`127.0.0.1:${listener.port}`) : unknown,
    };
  };
  const hostSettings: HostSettingsBridge = {
    read,
    async apply({ expectedRevision, mode, port }) {
      if (mode !== "off") throw new ReachabilityError("unsupported");
      const existing = await read();
      if (existing.revision !== expectedRevision) throw new ReachabilityError("configuration_stale");
      const saved = await config.load();
      if (saved.posture === "off" && (saved.console_port ?? null) === port) return existing;
      // The desktop's existing config watcher owns the stack restart. Return
      // only what this running process can still observe.
      await config.save({ ...offRemoteAccessConfig(), ...(port === null ? {} : { console_port: port }) });
      return read();
    },
  };
  const hostCapabilities: HostCapabilities = {
    "installer.execute": known(false),
    "privilege.elevate": known(false),
    "runtime.attached": known(true),
    "runtime.durable": known(false),
    "secrets.backend": known(isCredentialEncryptionConfigured()),
  };
  const service = await createReachabilityService({
    identity: { instanceId: createHash("sha256").update(dataDir).digest("hex"), bootId: randomUUID() },
    hostCapabilities,
    secretBackend: createHostSecretBackend(createSealedSecretBackend(join(home, "custody"))),
  }, {
    hostSettings,
    query: {
      schemaVersion: 1, home, owner: input.owner,
      requirements: { reach: "this-device", transport: "any", payloadAccess: "allow-provider", address: "any", setup: "allow", protocols: [] },
      target: "",
    },
    prepare: async () => {
      requireUsableSocketHome(home);
      if (!await passwordReady()) throw new ReachabilityError("owner_password_required");
      if ((await config.load()).posture !== "off") throw new ReachabilityError("host_policy_denied");
    },
    currentTarget: async () => {
      if (!await passwordReady()) throw new ReachabilityError("owner_password_required");
      if ((await config.load()).posture !== "off") throw new ReachabilityError("host_policy_denied");
      const listener = await observe();
      if (!listener) throw new ReachabilityError("host_supervisor_unavailable");
      return `127.0.0.1:${listener.port}`;
    },
    acknowledgeDisconnect: async (acknowledged) => {
      if (!acknowledged) throw new ReachabilityError("remote_disconnect_acknowledgment_required");
    },
  });
  return {
    service,
    statePaths: { inspect: () => inspectStatePaths(home, dataDir), fix: () => fixStatePaths(home, dataDir) },
    passwordSet: passwordReady,
    usage(kind) {
      if (kind === "attached") return { kind };
      if (kind === "session") return { kind, lifetimeMs: 3_600_000 };
      throw new ReachabilityError("host_runtime_unavailable");
    },
  };
}

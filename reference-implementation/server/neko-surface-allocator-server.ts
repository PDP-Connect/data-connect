// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  bindingResourceReference,
  type BindingResourceReference,
  type BindingResourceCleanupReceipt,
} from "../runtime/binding-resource-reference.ts";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rmdir, stat, unlink } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readBrowserBindingRuntimeConfig } from "./browser-binding-runtime-config.ts";
import {
  BROWSER_SURFACE_BACKEND_NEKO,
  type BrowserSurface,
  type BrowserSurfaceHealth,
  type EnsureBrowserSurfaceRequest,
  type StopBrowserSurfaceRequest,
  // biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
} from "@opendatalabs/remote-surface/leases";

import {
  BINDING_CONTROL_PREFIX,
  type BindingActivationContext,
  type BindingControlTarget,
  bindingPermit,
  controlAuthenticated,
  postBindingControl,
  readControlBody,
  validateControlTarget,
} from "../runtime/binding-control.ts";
import { canonicalBindingJson } from "./stores/binding-json.ts";

const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_LABEL_NAMESPACE = "org.pdpp.reference.neko";
// Applied automatically by Docker Compose itself to every container it
// creates (never written by this allocator) — a trustworthy, non-spoofable
// signal of which Compose project actually created a container, used only
// to scope legacy-container adoption to this allocator's own project.
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const DEFAULT_CONTAINER_HTTP_PORT = 8080;
const DEFAULT_CONTAINER_CDP_PORT = 9223;
const DEFAULT_NEKO_HEALTH_PATH = "/neko/health";
const DEFAULT_CDP_VERSION_PATH = "/json/version";
const DEFAULT_ALLOCATOR_HOST = "0.0.0.0";
const DEFAULT_ALLOCATOR_PORT = 7331;
const DEFAULT_NEKO_PROFILE_UID = 1000;
const DEFAULT_NEKO_PROFILE_GID = 1000;
const PROFILE_DIRECTORY_MODE = 0o700;
const PERMISSION_BITS = 0o7777;
const PROBE_PREFIX = ".pdpp-allocator-probe-";
const LEADING_SLASH_RE = /^\//;
const TRAILING_SLASHES_RE = /\/+$/;
const DOCKER_HTTP_404_RE = /\bHTTP 404\b/;
const RESERVATION_SCOPE_RE = /^[a-zA-Z0-9_.:@-]{1,256}$/;
const RESERVATION_IMAGE_RE = /^sha256:[a-f0-9]{64}$/;
const DOCKER_PORT_BIND_RE =
  /\b(address already in use|port is already allocated|failed to bind host port|driver failed programming external connectivity)\b/i;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface DockerContainerSummary {
  readonly Id: string;
  readonly Labels?: Record<string, string>;
  readonly Names?: readonly string[];
  readonly Ports?: readonly DockerPortSummary[];
  readonly State?: string;
}

interface DockerPortSummary {
  readonly PrivatePort?: number;
  readonly PublicPort?: number;
  readonly Type?: string;
}

interface DockerContainerInspect {
  readonly Config?: {
    readonly Labels?: Record<string, string>;
  };
  readonly Id: string;
  readonly Name?: string;
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, readonly DockerPortBinding[] | null>;
    readonly Networks?: Record<string, { readonly IPAddress?: string } | undefined>;
  };
  readonly State?: {
    readonly Running?: boolean;
    readonly Status?: string;
    readonly Health?: {
      readonly Status?: string;
      readonly FailingStreak?: number;
    };
  };
}

interface DockerPortBinding {
  readonly HostIp?: string;
  readonly HostPort?: string;
}

export interface DockerEngineTransport {
  requestJson: (path: string, init?: DockerEngineRequestInit) => Promise<unknown>;
}

export interface DockerEngineRequestInit {
  readonly body?: unknown;
  readonly method?: string;
  readonly okStatuses?: readonly number[];
  readonly query?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
}

// dev and ino are bigint: 64-bit inode numbers above 2^53 collapse to the same
// JS number, which would make "is this the same directory" unsound.
export interface ProfileDirectoryStat {
  readonly dev: bigint;
  readonly gid: number;
  readonly ino: bigint;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
}

/** An open directory (O_DIRECTORY | O_NOFOLLOW); every call acts on that inode. */
export interface ProfileDirectoryHandle {
  chmod: (mode: number) => Promise<void>;
  chown: (uid: number, gid: number) => Promise<void>;
  close: () => Promise<void>;
  stat: () => Promise<ProfileDirectoryStat>;
}

/**
 * The allocator's only contact with profile storage.
 *
 * Trust contract: the profile root and every ancestor of it are written only
 * by the operator and the allocator. The root path may traverse symlinks (it is
 * operator configuration, resolved once per `stat`); entries below the root are
 * never followed: `openDirectory` refuses a symlink in the last component. Docker
 * resolves the bind-mount host path by name when the browser container is
 * created, so the final identity check in `#prepareProfileDirectory` narrows,
 * but cannot close, a swap by someone who can already write into the root.
 *
 * `mkdir` is deliberately non-recursive. Node 24.19's recursive mkdir loops
 * forever (millions of mkdir/statx syscalls, one pinned CPU) when an ancestor
 * is a directory that was unlinked while still open — the state of a
 * bind-mounted profile root whose host directory was deleted. A non-recursive
 * mkdir fails with ENOENT immediately in that state.
 */
export interface ProfileFilesystem {
  mkdir: (path: string, options: { mode: number }) => Promise<void>;
  openDirectory: (path: string) => Promise<ProfileDirectoryHandle>;
  rmdir: (path: string) => Promise<void>;
  /** `follow: true` resolves symlinks (profile root only); `false` is lstat. */
  stat: (path: string, options: { follow: boolean }) => Promise<ProfileDirectoryStat>;
  unlink: (path: string) => Promise<void>;
  /** Exclusive create (fails on EEXIST), write, fsync, close. */
  writeNewFile: (path: string, data: string) => Promise<void>;
}

interface ProfileRootIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface NekoSurfaceAllocatorServerOptions {
  /** Service-internal trust boundary. Must resolve fresh owner policy and durably
   * persist the run-bound before-egress authority record, or throw. No default.
   * A test callback is not product authorization. Never expose this via HTTP.
   */
  readonly authorizeAndRecordBindingActivation?: (reservation: PreparedNekoReservation) => Promise<void>;
  /** Default absent. Distinct operator service identity; never owner consent. */
  readonly bindingControl?: {
    readonly credential: string;
    readonly authorizer: BindingControlTarget;
  };
  readonly cdpBaseUrlTemplate: string;
  readonly cdpVersionPath?: string;
  readonly containerCdpPort?: number;
  readonly containerHttpPort?: number;
  // Every container this allocator instance creates, lists, or otherwise
  // manages MUST carry this exact deployment identity in addition to the
  // owner label. Required — deliberately with NO default value — because a
  // shared literal default (even "production") lets two independently
  // configured allocator instances on the same Docker host collide and
  // mutate each other's containers purely by omission, which is exactly how
  // a throwaway smoke instance was able to enumerate and reconfigure network
  // attachments on live production containers.
  //
  // Deliberately the SAME identity as the Compose project name
  // (COMPOSE_PROJECT_NAME) this allocator instance is running under — not a
  // second, independently-configured "production identity" concept. This is
  // what lets #isOwnedByThisDeployment safely recognize genuinely
  // unnamespaced legacy containers (created before this concept existed)
  // unconditionally, by cross-checking against Docker Compose's own
  // `com.docker.compose.project` label, rather than needing a separate
  // opt-in flag that could be misconfigured. See #listOwnedContainers and
  // #ownedLabels.
  readonly deploymentId: string;
  readonly docker?: DockerEngineTransport;
  readonly dockerSocketPath?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly fetchImpl?: FetchLike;
  readonly image: string;
  readonly labelNamespace?: string;
  readonly legacyNetwork?: string;
  readonly listenHost?: string;
  readonly listenPort?: number;
  readonly nekoHealthPath?: string;
  readonly network: string;
  readonly now?: () => Date;
  readonly profileFilesystem?: ProfileFilesystem;
  readonly profileOwnerGid?: number;
  readonly profileOwnerUid?: number;
  readonly profileRoot: string;
  readonly streamBaseUrlTemplate: string;
  readonly webrtcHostPortEnd: number;
  readonly webrtcHostPortStart: number;
}

function deriveWindowSettleEndpoint(cdpUrl: string): string {
  try {
    return new URL("/pdpp/window-settle", cdpUrl).toString();
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
    throw new NekoSurfaceAllocatorServiceError(
      "readiness_failed",
      "managed n.eko surface has an invalid CDP URL for its window-settle endpoint",
      { cause }
    );
  }
}

interface ResourceNames {
  readonly containerName: string;
  readonly profileHash: string;
  readonly profilePath: string;
  readonly profileSlug: string;
}

interface HostPortOccupancy {
  readonly reclaimable: Map<number, Set<string>>;
  readonly used: Set<number>;
}

interface SurfaceRequest extends EnsureBrowserSurfaceRequest {
  readonly accountKey?: string;
  readonly surfaceSubjectId?: string;
}

export class DockerEngineHttpClient implements DockerEngineTransport {
  readonly #socketPath: string;

  constructor(options: { socketPath?: string } = {}) {
    this.#socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET_PATH;
  }

  requestJson(path: string, init: DockerEngineRequestInit = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const query = new URLSearchParams(init.query ?? {});
    const requestPath = query.size > 0 ? `${path}?${query.toString()}` : path;
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const okStatuses = new Set(init.okStatuses ?? [200]);

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          headers:
            body === undefined
              ? undefined
              : { "content-length": Buffer.byteLength(body), "content-type": "application/json" },
          method,
          path: requestPath,
          socketPath: this.#socketPath,
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          if (init.signal) {
            res.on("error", reject);
          }
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const payload = Buffer.concat(chunks).toString("utf8");
            if (!okStatuses.has(res.statusCode ?? 0)) {
              const suffix = payload.length === 0 ? "" : `: ${payload.slice(0, 500)}`;
              reject(
                new NekoSurfaceAllocatorServiceError(
                  "docker_http_error",
                  `Docker ${method} ${path} returned HTTP ${String(res.statusCode)}${suffix}`
                )
              );
              return;
            }
            if (payload.length === 0) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(payload) as unknown);
            } catch (cause) {
              reject(
                new NekoSurfaceAllocatorServiceError(
                  "docker_malformed_response",
                  `Docker ${method} ${path} returned invalid JSON`,
                  { cause }
                )
              );
            }
          });
        }
      );
      req.on("error", (cause) =>
        reject(
          new NekoSurfaceAllocatorServiceError("docker_request_failed", `Docker ${method} ${path} failed`, { cause })
        )
      );
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}

export class NekoSurfaceAllocatorServiceError extends Error {
  readonly code:
    | "bad_request"
    | "docker_http_error"
    | "docker_malformed_response"
    | "docker_request_failed"
    | "foreign_resource"
    | "image_missing"
    | "not_found"
    | "port_capacity_exhausted"
    | "profile_path_invalid"
    | "profile_storage_unavailable"
    | "readiness_failed"
    | "reservation_refused";

  constructor(code: NekoSurfaceAllocatorServiceError["code"], message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NekoSurfaceAllocatorServiceError";
    this.code = code;
  }
}

export interface NekoBindingScope {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly instanceKey: string;
  readonly ownerId: string;
}

/** Sanitized facts only. Resource generation is deliberately separate from the
 * stable access contract; neither is an approval or a confinement attestation.
 */
export interface PreparedNekoReservation {
  readonly access: {
    readonly identity: string;
    readonly revision: string;
    readonly imageId: string;
    readonly networkId: string;
    readonly networkName: string;
    readonly purpose: "Prepare an isolated browser profile for connector collection";
    readonly consequentialActions: readonly string[];
    readonly profileIdentity: string;
    readonly launchConfigurationRevision: string;
    readonly mechanism: "neko-docker-reservation";
    readonly mechanismVersion: "1";
    readonly requestedOrigins: readonly string[];
    readonly effectiveReach: "unrestricted browser navigation and connections on configured Docker network after activation";
    readonly remainingAmbientAccess: readonly string[];
    readonly channels: readonly { readonly name: string; readonly coverage: "not_observable" }[];
  };
  readonly expiresAt: number;
  readonly phase: "PREPARED";
  readonly reservationId: string;
  readonly resource: {
    readonly allocatorId: string;
    readonly deploymentId: string;
    readonly bindingScopeIdentity: string;
    readonly profileIdentity: string;
    readonly containerId: string;
    readonly generation: string;
    readonly configurationRevision: string;
  };
  readonly scope: NekoBindingScope;
}

interface NekoReservationState {
  context?: BindingActivationContext;
  descriptor: PreparedNekoReservation;
  networkRevision: string;
  profilePath: string;
  profileRevision: string;
  rootIdentity: ProfileRootIdentity;
  start?: Promise<void>;
  startUnverified?: boolean;
  state: "prepared" | "authorizing" | "starting" | "active" | "cancelled" | "failed" | "stopped";
  stop?: Promise<void> | undefined;
  stopRequested?: boolean;
}

function reservationRefused(): never {
  throw new NekoSurfaceAllocatorServiceError("reservation_refused", "n.eko reservation refused");
}

function reservationConfigurationRevision(value: Record<string, unknown>): string {
  const { Config, HostConfig, Image, Mounts } = value;
  if (!isRecord(Config) || !isRecord(HostConfig) || typeof Image !== "string") reservationRefused();
  return reservationHash({ Config, HostConfig, Image, Mounts });
}

function reservationHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (typeof item === "bigint") {
      return item.toString();
    }
    if (Array.isArray(item)) {
      return item.map(canonical);
    }
    if (isRecord(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort((a, b) => a.localeCompare(b))
          .map((key) => [key, canonical(item[key])])
      );
    }
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function freezeReservation<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      freezeReservation(item);
    }
    Object.freeze(value);
  }
  return value;
}

function parseNekoPreparation(
  input: NekoBindingScope & {
    readonly expiresAt: number;
    readonly requestedOrigins: readonly string[];
  },
  now: number
): { scope: NekoBindingScope; origins: string[]; expiresAt: number } {
  const scope = {
    connectionId: input.connectionId,
    connectorId: input.connectorId,
    instanceKey: input.instanceKey,
    ownerId: input.ownerId,
  };
  for (const value of Object.values(scope)) {
    if (typeof value !== "string" || !RESERVATION_SCOPE_RE.test(value)) {
      reservationRefused();
    }
  }
  const { expiresAt } = input;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    !Array.isArray(input.requestedOrigins) ||
    input.requestedOrigins.length > 128
  ) {
    reservationRefused();
  }
  const origins = [...input.requestedOrigins];
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== origin) {
      reservationRefused();
    }
  }
  return { expiresAt, origins, scope };
}

export class NekoSurfaceAllocatorService {
  readonly #options: Required<
    Pick<
      NekoSurfaceAllocatorServerOptions,
      | "containerCdpPort"
      | "containerHttpPort"
      | "fetchImpl"
      | "labelNamespace"
      | "nekoHealthPath"
      | "profileFilesystem"
      | "profileOwnerGid"
      | "profileOwnerUid"
      | "cdpVersionPath"
      | "now"
    >
  > &
    Omit<
      NekoSurfaceAllocatorServerOptions,
      | "containerCdpPort"
      | "containerHttpPort"
      | "fetchImpl"
      | "labelNamespace"
      | "nekoHealthPath"
      | "profileFilesystem"
      | "profileOwnerGid"
      | "profileOwnerUid"
      | "cdpVersionPath"
      | "now"
    >;
  readonly #docker: DockerEngineTransport;
  readonly #bindingSignal = new AsyncLocalStorage<AbortSignal>();
  #storageCheck: Promise<ProfileRootIdentity> | null = null;
  readonly #reservations = new Map<string, NekoReservationState>();
  readonly #reservedScopes = new Set<string>();

  constructor(options: NekoSurfaceAllocatorServerOptions) {
    assertAllocatorOptions(options);
    if (options.bindingControl) {
      validateControlTarget(options.bindingControl.authorizer);
      if (!controlAuthenticated(`Bearer ${options.bindingControl.credential}`, options.bindingControl.credential)) {
        reservationRefused();
      }
    }
    this.#options = {
      ...options,
      cdpVersionPath: options.cdpVersionPath ?? DEFAULT_CDP_VERSION_PATH,
      containerCdpPort: options.containerCdpPort ?? DEFAULT_CONTAINER_CDP_PORT,
      containerHttpPort: options.containerHttpPort ?? DEFAULT_CONTAINER_HTTP_PORT,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      labelNamespace: options.labelNamespace ?? DEFAULT_LABEL_NAMESPACE,
      nekoHealthPath: options.nekoHealthPath ?? DEFAULT_NEKO_HEALTH_PATH,
      now: options.now ?? (() => new Date()),
      profileFilesystem: options.profileFilesystem ?? nodeProfileFilesystem,
      profileOwnerGid: options.profileOwnerGid ?? DEFAULT_NEKO_PROFILE_GID,
      profileOwnerUid: options.profileOwnerUid ?? DEFAULT_NEKO_PROFILE_UID,
    };
    const docker =
      options.docker ??
      new DockerEngineHttpClient(
        options.dockerSocketPath === undefined ? {} : { socketPath: options.dockerSocketPath }
      );
    this.#docker = {
      requestJson: (path, init = {}) =>
        docker.requestJson(path, {
          ...init,
          ...(this.#bindingSignal.getStore() ? { signal: this.#bindingSignal.getStore() } : {}),
        }),
    };
  }

  /** Stopped-resource preparation. This does not call ensureSurface, start, readiness,
   * network creation/migration, or port reclamation. Expiry is trusted policy input.
   */
  async prepareBindingSurface(
    input: NekoBindingScope & {
      readonly expiresAt: number;
      readonly requestedOrigins: readonly string[];
    }
  ): Promise<PreparedNekoReservation> {
    const { scope, origins, expiresAt } = parseNekoPreparation(input, this.#options.now().getTime());
    const identity = reservationHash([this.#options.deploymentId, scope]);
    if (this.#reservedScopes.has(identity)) {
      reservationRefused();
    }
    this.#reservedScopes.add(identity);
    // Keep the scope claimed on failure: an uncertain create must never be
    // silently replaced. Restart also fails closed on the retained name.
    const reservationId = randomUUID();
    const request = { connectorId: scope.connectorId, profileKey: identity, surfaceId: `prepared-${identity}` };
    const names = {
      ...this.#resourceNames(request),
      profilePath: `${this.#options.profileRoot.replace(TRAILING_SLASHES_RE, "")}/prepared-${identity}`,
    };
    const root = await this.#statProfileRoot();
    const rootIdentity = { dev: root.dev, ino: root.ino };
    const allocatorId = await this.#reservationAllocatorId();
    const imageId = await this.#reservationImageId();
    const network = await this.#reservationNetwork();
    const existing = await this.#findOwnedContainer(request.surfaceId);
    if (existing !== null) {
      reservationRefused();
    }
    const containers = await this.#listOwnedContainers();
    const used = new Set(containers.flatMap((item) => [...summaryHostPorts(item, this.#options.labelNamespace)]));
    let port = this.#options.webrtcHostPortStart;
    while (used.has(port) && port <= this.#options.webrtcHostPortEnd) {
      port += 1;
    }
    if (port > this.#options.webrtcHostPortEnd) {
      reservationRefused();
    }
    // A reserved leaf has a separate namespace from legacy profiles. Existing
    // leaves are inspected only, never repaired/chowned or read for contents.
    const fs = this.#options.profileFilesystem;
    try {
      await fs.mkdir(names.profilePath, { mode: PROFILE_DIRECTORY_MODE });
      await this.#prepareProfileDirectory(names.profilePath, rootIdentity);
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") {
        throw cause;
      }
    }
    const profileRevision = await this.#reservationProfile(names.profilePath, rootIdentity);
    const labels = {
      ...this.#labelsForRequest(request, names, port),
      [`${this.#options.labelNamespace}.profile_identity`]: reservationHash([identity, profileRevision]),
      [`${this.#options.labelNamespace}.reservation`]: reservationId,
      [`${this.#options.labelNamespace}.binding_scope`]: identity,
    };
    const body = {
      Env: this.#containerEnv(request, port),
      ExposedPorts: {
        [`${this.#options.containerHttpPort}/tcp`]: {},
        [`${this.#options.containerCdpPort}/tcp`]: {},
        [`${port}/tcp`]: {},
        [`${port}/udp`]: {},
      },
      Healthcheck: this.#containerHealthcheck(),
      HostConfig: {
        Binds: [`${names.profilePath}:/home/user/.config/chromium`],
        LogConfig: { Config: { "max-file": "5", "max-size": "10m" }, Type: "json-file" },
        NetworkMode: this.#options.network,
        PortBindings: {
          [`${port}/tcp`]: [{ HostIp: "", HostPort: String(port) }],
          [`${port}/udp`]: [{ HostIp: "", HostPort: String(port) }],
        },
      },
      Hostname: names.containerName,
      Image: imageId,
      Labels: labels,
    };
    const created = await this.#docker.requestJson("/containers/create", {
      body,
      method: "POST",
      okStatuses: [201],
      query: { name: names.containerName },
    });
    const containerId = readCreatedContainerId(created);
    const inspect = await this.#reservationInspect(containerId, reservationId, identity);
    if (
      inspect.Image !== imageId ||
      !isRecord(inspect.HostConfig) ||
      !isRecord(inspect.Config) ||
      inspect.HostConfig.NetworkMode !== this.#options.network ||
      reservationHash(inspect.HostConfig.Binds) !== reservationHash(body.HostConfig.Binds) ||
      !isRecord(inspect.NetworkSettings) ||
      !isRecord(inspect.NetworkSettings.Networks) ||
      Object.keys(inspect.NetworkSettings.Networks).length !== 1 ||
      !(this.#options.network in inspect.NetworkSettings.Networks)
    ) {
      reservationRefused();
    }
    const { Labels: _labels, ...actualConfig } = inspect.Config;
    const launchConfigurationRevision = reservationHash({
      Config: actualConfig,
      HostConfig: inspect.HostConfig,
      Image: inspect.Image,
      Mounts: inspect.Mounts,
    });
    // Docker merges image defaults into Config. Check all supplied settings
    // against inspect, and bind those resolved defaults into the access revision.
    const actualEnv = inspect.Config.Env;
    if (
      !(Array.isArray(actualEnv) && body.Env.every((entry) => actualEnv.includes(entry))) ||
      reservationHash(inspect.HostConfig.PortBindings) !== reservationHash(body.HostConfig.PortBindings) ||
      reservationHash(inspect.Config.Healthcheck) !== reservationHash(body.Healthcheck)
    ) {
      reservationRefused();
    }
    const access = {
      channels: ["browser.navigate", "browser.connect"].map((name) => ({ coverage: "not_observable" as const, name })),
      consequentialActions: [
        "Navigate and authenticate to sites",
        "Read and modify browser profile data",
        "Send requests to routable network destinations",
      ],
      effectiveReach:
        "unrestricted browser navigation and connections on configured Docker network after activation" as const,
      identity,
      imageId,
      launchConfigurationRevision,
      mechanism: "neko-docker-reservation" as const,
      mechanismVersion: "1" as const,
      networkId: String(network.Id),
      networkName: this.#options.network,
      profileIdentity: reservationHash([identity, profileRevision]),
      purpose: "Prepare an isolated browser profile for connector collection" as const,
      remainingAmbientAccess: [
        "No forced egress boundary or browser origin guard",
        "Docker network peers, DNS and routable public/private destinations",
        "Chromium profile read/write; image defaults and configured private environment",
        "Published WebRTC TCP/UDP host port; network-peer HTTP/CDP access after activation",
      ],
      requestedOrigins: origins,
      revision: reservationHash([imageId, network, profileRevision, launchConfigurationRevision, origins]),
    };
    const descriptor = freezeReservation({
      access,
      expiresAt,
      phase: "PREPARED" as const,
      reservationId,
      resource: {
        configurationRevision: reservationConfigurationRevision(inspect),
        allocatorId,
        deploymentId: this.#options.deploymentId,
        bindingScopeIdentity: identity,
        profileIdentity: access.profileIdentity,
        containerId,
        generation: reservationHash([containerId, inspect.Created]),
      },
      scope,
    });
    const record: NekoReservationState = {
      descriptor,
      networkRevision: reservationHash(network),
      profilePath: names.profilePath,
      profileRevision,
      rootIdentity,
      state: "prepared",
    };
    this.#reservations.set(reservationId, record);
    await this.#revalidateReservation(record);
    return descriptor;
  }

  /** Removal fences a delayed start: Engine starts exact IDs and removed IDs cannot be recreated.
   * No reservation map, current approval, profile filesystem, or name lookup is needed.
   * This assumes the configured daemon is authoritative; privileged outside writers are not confined.
   */
  async recoverStoppedResource(
    input: BindingResourceReference,
    deadline: number
  ): Promise<BindingResourceCleanupReceipt> {
    const reference = bindingResourceReference(input);
    if (reference.deploymentId !== this.#options.deploymentId || !Number.isFinite(deadline) || deadline <= Date.now())
      reservationRefused();
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())));
    return await this.#bindingSignal.run(signal, async () => {
      if (reference.allocatorId !== (await this.#reservationAllocatorId())) reservationRefused();
      const path = `/containers/${encodeURIComponent(reference.containerId)}`;
      const absent = Symbol("authoritative404");
      const inspect = async (): Promise<unknown> => {
        try {
          return await this.#docker.requestJson(`${path}/json`);
        } catch (error) {
          // Match transport status framing, never a diagnostic body's incidental "HTTP 404".
          const prefix = `Docker GET ${path}/json returned HTTP 404`;
          if (
            error instanceof NekoSurfaceAllocatorServiceError &&
            error.code === "docker_http_error" &&
            (error.message === prefix || error.message.startsWith(`${prefix}:`))
          )
            return absent;
          throw error;
        }
      };
      const value = await inspect();
      if (value !== absent) {
        if (
          !(isRecord(value) && isRecord(value.Config) && isRecord(value.Config.Labels)) ||
          value.Id !== reference.containerId ||
          typeof value.Created !== "string" ||
          reservationHash([value.Id, value.Created]) !== reference.generation ||
          reservationConfigurationRevision(value) !== reference.configurationRevision ||
          value.Config.Labels[`${this.#options.labelNamespace}.owner`] !== "pdpp-reference" ||
          value.Config.Labels[`${this.#options.labelNamespace}.deployment_id`] !== reference.deploymentId ||
          value.Config.Labels[`${this.#options.labelNamespace}.reservation`] !== reference.reservationId ||
          value.Config.Labels[`${this.#options.labelNamespace}.binding_scope`] !== reference.bindingScopeIdentity ||
          value.Config.Labels[`${this.#options.labelNamespace}.profile_identity`] !== reference.profileIdentity ||
          reference.bindingScopeIdentity !==
            reservationHash([
              reference.deploymentId,
              {
                connectionId: reference.connectionId,
                connectorId: reference.connectorId,
                instanceKey: reference.instanceKey,
                ownerId: reference.ownerId,
              },
            ])
        )
          reservationRefused();
        // Dedicated path: 409 is a refusal, never proof. Preserve bind mounts and volumes.
        await this.#docker.requestJson(path, {
          method: "DELETE",
          okStatuses: [204, 404],
          query: { force: "true", v: "false" },
        });
        if ((await inspect()) !== absent) reservationRefused();
      }
      if (signal.aborted || Date.now() >= deadline) reservationRefused();
      const retained = this.#reservations.get(reference.reservationId);
      if (
        retained &&
        retained.descriptor.resource.containerId === reference.containerId &&
        retained.descriptor.resource.generation === reference.generation
      ) {
        retained.stopRequested = true;
        retained.state = "stopped";
      }
      // Durable receipt must be committed by the caller before any acquisition hold is released.
      return Object.freeze({ version: 1, reference, disposition: "removed" });
    });
  }

  async readBindingReservation(reservationId: string, scope: NekoBindingScope): Promise<PreparedNekoReservation> {
    const record = this.#bindingReservation(reservationId, scope);
    if (record.state !== "prepared") {
      reservationRefused();
    }
    await this.#revalidateReservation(record);
    if (record.state !== "prepared") {
      reservationRefused();
    }
    return record.descriptor;
  }

  /** Local trusted callback or configured authenticated control exchange.
   * Neither path starts until durable authorization succeeds.
   */
  async activateBindingReservation(
    reservationId: string,
    scope: NekoBindingScope,
    context?: BindingActivationContext,
    signal?: AbortSignal
  ): Promise<{ containerId: string }> {
    const record = this.#bindingReservation(reservationId, scope);
    if (record.state !== "prepared") {
      reservationRefused();
    }
    if (context) {
      record.context = context;
    }
    record.state = "authorizing";
    try {
      await this.#revalidateReservation(record);
      if (this.#options.bindingControl) {
        if (!(context?.runId && Number.isFinite(context.deadline))) {
          reservationRefused();
        }
        await this.#authorizeControl(record.descriptor, context, "authorize");
      } else {
        const authorize = this.#options.authorizeAndRecordBindingActivation;
        if (authorize === undefined) {
          reservationRefused();
        }
        await authorize(record.descriptor);
      }
      await this.#revalidateReservation(record);
      if (this.#options.bindingControl && context) {
        await this.#authorizeControl(record.descriptor, context, "check");
      }
      if (record.descriptor.expiresAt <= this.#options.now().getTime() || (context && context.deadline <= Date.now())) {
        reservationRefused();
      }
      // Cancellation during either await must win before dispatching start.
      if (record.state !== "authorizing" || signal?.aborted) {
        reservationRefused();
      }
      record.state = "starting";
      record.start = this.#startContainer(record.descriptor.resource.containerId);
      try {
        await record.start;
      } catch (error) {
        record.startUnverified = true;
        throw error;
      }
      if (record.stopRequested || signal?.aborted) {
        // Start has settled: a stop requested during dispatch must win.
        await this.stopBindingReservation(reservationId, scope);
        reservationRefused();
      }
      record.state = "active";
      return { containerId: record.descriptor.resource.containerId };
    } catch (cause) {
      this.#failReservation(record);
      throw cause;
    }
  }

  async #authorizeControl(
    reservation: PreparedNekoReservation,
    context: BindingActivationContext,
    action: "authorize" | "check" | "observe"
  ): Promise<void> {
    const control = this.#options.bindingControl;
    if (!control) {
      reservationRefused();
    }
    const permit = await postBindingControl(
      control.authorizer,
      action,
      { reservation, ...context },
      Math.min(context.deadline, reservation.expiresAt)
    );
    if (canonicalBindingJson(permit) !== canonicalBindingJson(bindingPermit(reservation, context))) {
      reservationRefused();
    }
  }

  /** Protected transport only; body scope is a lookup, never an authorization. */
  async handleBindingControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return await this.#bindingSignal.run(
      AbortSignal.timeout(this.#options.bindingControl?.authorizer.timeoutMs ?? 30_000),
      () => this.#handleBindingControl(req, res)
    );
  }

  async #handleBindingControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const control = this.#options.bindingControl;
    res.setHeader("Cache-Control", "no-store");
    if (!control) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!controlAuthenticated(req.headers.authorization, control.credential)) {
      sendJson(res, 401, { error: "control_unauthorized" });
      return;
    }
    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    req.setTimeout(30_000, () => req.destroy());
    try {
      if (req.method !== "POST") {
        reservationRefused();
      }
      const body = await readControlBody(req);
      if (
        !isRecord(body) ||
        typeof body.deadline !== "number" ||
        !Number.isFinite(body.deadline) ||
        body.deadline <= Date.now() ||
        body.deadline - Date.now() > 30_000
      ) {
        reservationRefused();
      }
      const parentSignal = this.#bindingSignal.getStore();
      const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(body.deadline - Date.now())));
      this.#bindingSignal.enterWith(parentSignal ? AbortSignal.any([parentSignal, deadlineSignal]) : deadlineSignal);
      const action = req.url?.slice(`${BINDING_CONTROL_PREFIX}/`.length);
      if (action === "prepare") {
        sendJson(
          res,
          200,
          await this.prepareBindingSurface(
            body.input as Parameters<NekoSurfaceAllocatorService["prepareBindingSurface"]>[0]
          )
        );
        return;
      }
      if (action === "recover") {
        sendJson(res, 200, await this.recoverStoppedResource(bindingResourceReference(body.reference), body.deadline));
        return;
      }
      if (typeof body.reservationId !== "string" || !isRecord(body.scope)) {
        reservationRefused();
      }
      const scope = body.scope as unknown as NekoBindingScope;
      if (action === "read") {
        sendJson(res, 200, await this.readBindingReservation(body.reservationId, scope));
      } else if (action === "activate" && typeof body.runId === "string") {
        sendJson(
          res,
          200,
          await this.activateBindingReservation(
            body.reservationId,
            scope,
            { deadline: body.deadline, runId: body.runId },
            disconnected.signal
          )
        );
      } else if (action === "status" && typeof body.runId === "string") {
        sendJson(
          res,
          200,
          await this.activeBindingStatus(body.reservationId, scope, { deadline: body.deadline, runId: body.runId })
        );
      } else if (action === "stop") {
        await this.stopBindingReservation(body.reservationId, scope);
        sendJson(res, 200, { reservationId: body.reservationId, stopped: true });
      } else if (action === "dispose") {
        this.disposeBindingReservation(body.reservationId, scope);
        sendJson(res, 200, { disposed: true, reservationId: body.reservationId });
      } else if (action === "cancel") {
        await this.cancelBindingReservation(body.reservationId, scope);
        sendJson(res, 200, { cancelled: true });
      } else {
        reservationRefused();
      }
    } catch {
      sendJson(res, 409, { error: "binding_control_refused" });
    }
  }

  async cancelBindingReservation(reservationId: string, scope: NekoBindingScope): Promise<void> {
    const record = this.#bindingReservation(reservationId, scope);
    if (["starting", "active", "cancelled"].includes(record.state)) {
      reservationRefused();
    }
    record.state = "cancelled";
    // Never force/remove an active container; never remove a profile. Changed
    // resources remain stopped for explicit operator review, not adoption/recovery.
    await this.#revalidateReservation(record, true);
    await this.#docker.requestJson(`/containers/${encodeURIComponent(record.descriptor.resource.containerId)}`, {
      method: "DELETE",
      okStatuses: [204],
      query: { force: "false", v: "false" },
    });
    await this.#verifyBindingResourceAbsent(record.descriptor.resource.containerId);
    this.#reservations.delete(reservationId);
    this.#reservedScopes.delete(record.descriptor.access.identity);
  }

  /** Access reduction uses immutable ownership only: no policy, image, network
   * or profile availability is needed to close the exact old resource. */
  get retainedBindingReservationCount(): number {
    return this.#reservations.size;
  }

  /** Only discards stopped bookkeeping, never touches Engine resources. Unknown
   * IDs are idempotent here; that is not a stopped/removed attestation. */
  disposeBindingReservation(reservationId: string, scope: NekoBindingScope): void {
    if (!this.#reservations.has(reservationId)) {
      return;
    }
    const record = this.#bindingReservation(reservationId, scope);
    if (record.state !== "stopped") {
      reservationRefused();
    }
    this.#reservations.delete(reservationId);
    this.#reservedScopes.delete(record.descriptor.access.identity);
  }

  async stopBindingReservation(reservationId: string, scope: NekoBindingScope): Promise<void> {
    const record = this.#bindingReservation(reservationId, scope);
    record.stopRequested = true;
    if (record.state === "stopped") {
      return;
    }
    if (record.stop) {
      return await record.stop;
    }
    const stop = async () => {
      if (record.start) {
        await record.start.catch(() => undefined);
      }
      const inspect = await this.#ownedBindingInspect(record);
      if ((inspect.State as Record<string, unknown>).Running === true) {
        await this.#docker.requestJson(
          `/containers/${encodeURIComponent(record.descriptor.resource.containerId)}/stop`,
          { method: "POST", okStatuses: [204, 304] }
        );
      }
      const after = await this.#ownedBindingInspect(record);
      if ((after.State as Record<string, unknown>).Running !== false) {
        reservationRefused();
      }
      // A failed start acknowledgment can still represent a daemon-side start
      // in flight. Even a subsequent stopped observation cannot prove closure.
      if (record.startUnverified) {
        reservationRefused();
      }
      await this.#docker.requestJson(`/containers/${encodeURIComponent(record.descriptor.resource.containerId)}`, {
        method: "DELETE",
        okStatuses: [204],
        query: { force: "false", v: "false" },
      });
      await this.#verifyBindingResourceAbsent(record.descriptor.resource.containerId);
      record.state = "stopped";
      // Keep the stable scope held until caller commits its durable receipt, then disposes.
    };
    record.stop = stop();
    try {
      await record.stop;
    } catch (error) {
      record.state = "failed";
      // A new explicit stop may re-inspect this exact immutable handle. Never
      // retry ambiguous start dispatch or adopt a resource by scope alone.
      if (!record.startUnverified) {
        record.stop = undefined;
      }
      throw error;
    }
  }

  async #verifyBindingResourceAbsent(id: string): Promise<void> {
    const path = `/containers/${encodeURIComponent(id)}/json`;
    try {
      await this.#docker.requestJson(path);
    } catch (error) {
      const prefix = `Docker GET ${path} returned HTTP 404`;
      if (
        error instanceof NekoSurfaceAllocatorServiceError &&
        error.code === "docker_http_error" &&
        (error.message === prefix || error.message.startsWith(`${prefix}:`))
      )
        return;
      throw error;
    }
    reservationRefused();
  }

  async #ownedBindingInspect(record: NekoReservationState): Promise<Record<string, unknown>> {
    const d = record.descriptor;
    const value = await this.#docker.requestJson(`/containers/${encodeURIComponent(d.resource.containerId)}/json`);
    if (
      !(isRecord(value) && isRecord(value.Config) && isRecord(value.Config.Labels) && isRecord(value.State)) ||
      value.Id !== d.resource.containerId ||
      reservationHash([value.Id, value.Created]) !== d.resource.generation ||
      reservationConfigurationRevision(value) !== d.resource.configurationRevision ||
      value.Config.Labels[`${this.#options.labelNamespace}.reservation`] !== d.reservationId ||
      value.Config.Labels[`${this.#options.labelNamespace}.binding_scope`] !== d.access.identity ||
      value.Config.Labels[`${this.#options.labelNamespace}.deployment_id`] !== this.#options.deploymentId ||
      value.Config.Labels[`${this.#options.labelNamespace}.owner`] !== "pdpp-reference"
    ) {
      reservationRefused();
    }
    return value;
  }

  async activeBindingStatus(reservationId: string, scope: NekoBindingScope, context: BindingActivationContext) {
    const record = this.#bindingReservation(reservationId, scope);
    if (record.state !== "active" || record.stopRequested || record.context?.runId !== context.runId) {
      reservationRefused();
    }
    await this.#authorizeControl(record.descriptor, context, "observe");
    const inspect = await this.#ownedBindingInspect(record);
    if ((inspect.State as Record<string, unknown>).Running !== true || !isRecord(inspect.Config)) {
      reservationRefused();
    }
    const { Labels: _labels, ...config } = inspect.Config;
    if (
      reservationHash({
        Config: config,
        HostConfig: inspect.HostConfig,
        Image: inspect.Image,
        Mounts: inspect.Mounts,
      }) !== record.descriptor.access.launchConfigurationRevision
    ) {
      reservationRefused();
    }
    // Do not invoke legacy readiness, which can migrate networks. Protected
    // status observes the authorized resource and never repairs its access.
    const surface = await this.#surfaceFromInspect(inspect as unknown as DockerContainerInspect, {
      readiness: { health: "starting", reason: "binding_readiness" },
    });
    const neko = await probeUrl(
      this.#options.fetchImpl,
      new URL(this.#options.nekoHealthPath, surface.stream_base_url),
      this.#bindingSignal.getStore()
    );
    const cdp = await probeJson(
      this.#options.fetchImpl,
      joinUrlPath(surface.cdp_url, this.#options.cdpVersionPath),
      this.#bindingSignal.getStore()
    );
    const final = await this.#ownedBindingInspect(record);
    await this.#authorizeControl(record.descriptor, context, "observe");
    if (
      (final.State as Record<string, unknown>).Running !== true ||
      record.state !== "active" ||
      record.stopRequested
    ) {
      reservationRefused();
    }
    return {
      reservationId,
      resource: record.descriptor.resource,
      surface: {
        ...surface,
        browser_generation_hash: record.descriptor.resource.generation,
        health: neko && cdp.ok && looksLikeChromiumVersion(cdp.value) ? "ready" : "starting",
      },
    };
  }

  #failReservation(record: NekoReservationState): void {
    if (!record.stopRequested && record.state !== "stopped") {
      record.state = "failed";
    }
  }

  #bindingReservation(id: string, scope: NekoBindingScope): NekoReservationState {
    const record = this.#reservations.get(id);
    if (record === undefined || reservationHash(scope) !== reservationHash(record.descriptor.scope)) {
      reservationRefused();
    }
    return record;
  }

  async #reservationAllocatorId(): Promise<string> {
    const info = await this.#docker.requestJson("/info");
    if (!isRecord(info) || typeof info.ID !== "string" || !info.ID || info.ID.length > 256) reservationRefused();
    return reservationHash([this.#options.labelNamespace, info.ID]);
  }

  async #reservationImageId(): Promise<string> {
    const image = await this.#docker.requestJson(`/images/${encodeURIComponent(this.#options.image)}/json`);
    if (!isRecord(image) || typeof image.Id !== "string" || !RESERVATION_IMAGE_RE.test(image.Id)) {
      reservationRefused();
    }
    return image.Id;
  }

  async #reservationNetwork(): Promise<Record<string, unknown>> {
    const value = await this.#docker.requestJson(`/networks/${encodeURIComponent(this.#options.network)}`);
    if (!isRecord(value) || typeof value.Id !== "string" || value.Id.length === 0) {
      reservationRefused();
    }
    const { Id, Driver, Internal, EnableIPv6, IPAM, Options, Labels, Scope } = value;
    return { Driver, EnableIPv6, Id, Internal, IPAM, Labels, Options, Scope };
  }

  async #reservationProfile(path: string, root: ProfileRootIdentity): Promise<string> {
    await this.#assertProfileRootUnchanged(root);
    const value = await this.#options.profileFilesystem.stat(path, { follow: false });
    this.#assertBrowserOwnedPrivateDirectory(value, path);
    // Directory entry count changes during normal Chromium profile writes.
    const { nlink: _nlink, ...identity } = value;
    return reservationHash(identity);
  }

  async #reservationInspect(id: string, generation: string, identity: string): Promise<Record<string, unknown>> {
    const value = await this.#docker.requestJson(`/containers/${encodeURIComponent(id)}/json`);
    if (
      !(isRecord(value) && isRecord(value.Config) && isRecord(value.Config.Labels) && isRecord(value.State)) ||
      value.Id !== id ||
      typeof value.Created !== "string" ||
      !Number.isFinite(Date.parse(value.Created)) ||
      value.State.Running !== false ||
      value.State.Status !== "created" ||
      value.Config.Labels[`${this.#options.labelNamespace}.reservation`] !== generation ||
      value.Config.Labels[`${this.#options.labelNamespace}.binding_scope`] !== identity ||
      value.Config.Labels[`${this.#options.labelNamespace}.deployment_id`] !== this.#options.deploymentId ||
      value.Config.Labels[`${this.#options.labelNamespace}.owner`] !== "pdpp-reference"
    ) {
      reservationRefused();
    }
    const { Id, Created, Image, Name, Config, HostConfig, Mounts, NetworkSettings, State, RestartCount } = value;
    return { Config, Created, HostConfig, Id, Image, Mounts, Name, NetworkSettings, RestartCount, State };
  }

  async #revalidateReservation(record: NekoReservationState, cleanup = false): Promise<void> {
    const { descriptor } = record;
    if (
      !cleanup &&
      (record.stopRequested || record.state === "cancelled" || descriptor.expiresAt <= this.#options.now().getTime())
    ) {
      reservationRefused();
    }
    const inspect = await this.#reservationInspect(
      descriptor.resource.containerId,
      descriptor.reservationId,
      descriptor.access.identity
    );
    if (
      reservationConfigurationRevision(inspect) !== descriptor.resource.configurationRevision ||
      (await this.#reservationImageId()) !== descriptor.access.imageId ||
      reservationHash(await this.#reservationNetwork()) !== record.networkRevision ||
      (await this.#reservationProfile(record.profilePath, record.rootIdentity)) !== record.profileRevision
    ) {
      reservationRefused();
    }
    if (
      !cleanup &&
      (record.stopRequested || record.state === "cancelled" || descriptor.expiresAt <= this.#options.now().getTime())
    ) {
      reservationRefused();
    }
  }

  async ensureSurface(request: SurfaceRequest): Promise<BrowserSurface> {
    assertSurfaceRequest(request);
    // Before ANY Docker mutation (remove, start, port reclaim, network
    // migration, create): with unusable storage, replacing an existing
    // surface would destroy a working container and then fail to rebuild it.
    const rootIdentity = await this.assertProfileStorageReady();
    const existing = await this.#findOwnedContainer(request.surfaceId);
    if (existing !== null) {
      this.#refuseReservedContainer(existing);
      this.#assertContainerMatchesRequest(existing, request);
      if (isInspectRunning(existing)) {
        // A running container is not automatically trustworthy. Docker's own
        // healthcheck (neko HTTP + CDP /json/version + supervisorctl chromium)
        // is debounced past the StartPeriod, so `State.Health.Status` of
        // "unhealthy" means the browser surface has been wedged long enough to
        // fail its retries — not merely cold-starting. Returning that carcass
        // would hand the next acquire a dead CDP socket and, because the
        // surface never exits, no later boot reconcile or idle sweep would ever
        // recycle it. Replace it now, exactly as we replace an exited carcass.
        // The host profile bind mount survives container removal, so this is
        // non-destructive for owner-visible state.
        //
        // We intentionally key on Docker's healthcheck verdict, NOT the
        // allocator's own single-shot #readiness() probe: a freshly launched
        // container legitimately reports cdp_unready ("starting") while
        // Chromium boots, and replacing on that signal would cause a boot loop.
        // "unhealthy" only appears after StartPeriod + failing retries.
        if (isInspectUnhealthy(existing)) {
          // Replacing needs the image: check it before destroying anything.
          await this.assertImageReady();
          await this.#removeContainer(existing.Id);
        } else {
          await this.#migrateContainerNetworkIfNeeded(existing.Id);
          return this.#surfaceFromInspect(await this.#inspectContainer(existing.Id), { request });
        }
      } else if (this.#isReplaceableExitedContainer(existing)) {
        // An exited container is not safe to "start again" — its previous run
        // may have lost its network attachment, left the profile in a half-
        // initialized state, or hit a crash loop. Replacing it is cheaper
        // than re-binding clients to a dead CDP socket and is the only way
        // an allocator-aware boot reconcile can make progress when prior
        // surfaces were OOM/network-evicted across restarts.
        await this.assertImageReady();
        await this.#removeContainer(existing.Id);
      } else {
        await this.#startContainer(existing.Id);
        await this.#migrateContainerNetworkIfNeeded(existing.Id);
        return this.#surfaceFromInspect(await this.#inspectContainer(existing.Id), { request });
      }
    }

    if (existing === null) {
      // Before port reclamation, which removes stopped containers.
      await this.assertImageReady();
    }
    const skippedPorts = new Set<number>();
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const port = await this.#allocateHostPort(skippedPorts);
      const names = this.#resourceNames(request);
      await this.#prepareProfileDirectory(names.profilePath, rootIdentity);
      const labels = this.#labelsForRequest(request, names, port);
      const created = await this.#docker
        .requestJson("/containers/create", {
          body: {
            Env: this.#containerEnv(request, port),
            ExposedPorts: {
              [`${String(this.#options.containerHttpPort)}/tcp`]: {},
              [`${String(this.#options.containerCdpPort)}/tcp`]: {},
              [`${String(port)}/tcp`]: {},
              [`${String(port)}/udp`]: {},
            },
            Healthcheck: this.#containerHealthcheck(),
            HostConfig: {
              Binds: [`${names.profilePath}:/home/user/.config/chromium`],
              // Docker takes these option values as strings only.
              LogConfig: { Config: { "max-file": "5", "max-size": "10m" }, Type: "json-file" },
              NetworkMode: this.#options.network,
              PortBindings: {
                [`${String(port)}/tcp`]: [{ HostPort: String(port) }],
                [`${String(port)}/udp`]: [{ HostPort: String(port) }],
              },
            },
            Image: this.#options.image,
            Labels: labels,
          },
          method: "POST",
          okStatuses: [201],
          query: { name: names.containerName },
        })
        .catch(async (cause: unknown) => {
          // A create 404 can also name a missing network; inspect the image
          // and replace the create error only when the image is missing, so
          // unrelated (or inspect-time) Docker failures keep the create error.
          if (isDockerNotFoundError(cause)) {
            try {
              await this.assertImageReady();
            } catch (inspectError) {
              if (inspectError instanceof NekoSurfaceAllocatorServiceError && inspectError.code === "image_missing") {
                throw inspectError;
              }
            }
          }
          throw cause;
        });
      const containerId = readCreatedContainerId(created);
      try {
        await this.#startContainer(containerId);
      } catch (error) {
        await this.#removeContainer(containerId);
        if (isDockerPortBindError(error)) {
          skippedPorts.add(port);
          continue;
        }
        throw error;
      }
      return this.#surfaceFromInspect(await this.#inspectContainer(containerId), { request });
    }
  }

  async getSurfaceStatus(surfaceId: string): Promise<BrowserSurface | null> {
    assertNonEmpty(surfaceId, "surface_id");
    const inspect = await this.#findOwnedContainer(surfaceId);
    if (inspect === null) {
      return null;
    }
    this.#refuseReservedContainer(inspect);
    const surface = await this.#surfaceFromInspect(inspect);
    if (!advertisesEnsureReplacement(inspect)) {
      return surface;
    }
    return { ...surface, allocator_metadata: { ...surface.allocator_metadata, ensure_disposition: "replace" } };
  }

  async stopSurface(request: StopBrowserSurfaceRequest): Promise<BrowserSurface | null> {
    assertNonEmpty(request.surfaceId, "surface_id");
    const inspect = await this.#findOwnedContainer(request.surfaceId);
    if (inspect === null) {
      return null;
    }
    this.#refuseReservedContainer(inspect);
    await this.#docker.requestJson(`/containers/${encodeURIComponent(inspect.Id)}/stop`, {
      method: "POST",
      okStatuses: [204, 304, 404],
    });
    // `surface_failed` carries explicit evidence from the controller that the
    // container's CDP socket was dead. The next acquire MUST get a brand new
    // container, not the same exited carcass. Remove it now; profile storage
    // lives on the host bind mount and survives. Other stop reasons (idle TTL,
    // capacity pressure, operator) leave the container in place so it can be
    // restarted cheaply.
    // Stopping above is always allowed, even with broken storage: it only
    // reduces active work. Removal is a destructive mutation and is skipped
    // (the stopped container is reported as it is) while storage is unusable.
    if (request.reason === "surface_failed" && (await this.#storageAllowsMutation())) {
      try {
        await this.#removeContainer(inspect.Id);
      } catch (cause) {
        if (!isDockerNotFoundError(cause)) {
          throw cause;
        }
      }
      return this.#surfaceFromInspect(inspect, {
        allowLabelHostPort: true,
        readiness: { health: "stopping", reason: "container_removed" },
      });
    }
    try {
      return this.#surfaceFromInspect(await this.#inspectContainer(inspect.Id), {
        allowLabelHostPort: true,
      });
    } catch (cause) {
      if (!isDockerNotFoundError(cause)) {
        throw cause;
      }
      return this.#surfaceFromInspect(inspect, {
        allowLabelHostPort: true,
        readiness: { health: "stopping", reason: "container_removed" },
      });
    }
  }

  async listSurfaces(): Promise<BrowserSurface[]> {
    const containers = await this.#listOwnedContainers();
    const surfaces = await Promise.all(
      containers
        .filter((container) => container.Labels?.[`${this.#options.labelNamespace}.reservation`] === undefined)
        .map((container) => this.#surfaceFromInspectId(container.Id))
    );
    return surfaces.sort((a, b) => a.surface_id.localeCompare(b.surface_id));
  }

  async #surfaceFromInspectId(containerId: string): Promise<BrowserSurface> {
    return this.#surfaceFromInspect(await this.#inspectContainer(containerId));
  }

  async #surfaceFromInspect(
    inspect: DockerContainerInspect,
    options: {
      readonly allowLabelHostPort?: boolean;
      readonly readiness?: { readonly health: BrowserSurfaceHealth; readonly reason: string };
      readonly request?: SurfaceRequest;
    } = {}
  ): Promise<BrowserSurface> {
    const labels = this.#ownedLabels(inspect);
    const surfaceId = labels[`${this.#options.labelNamespace}.surface_id`];
    const profileKey = labels[`${this.#options.labelNamespace}.profile_key`];
    const connectorId = labels[`${this.#options.labelNamespace}.connector_id`];
    if (surfaceId === undefined || profileKey === undefined || connectorId === undefined) {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "managed container is missing required PDPP labels"
      );
    }
    const hostPort = readHostPort(inspect, Number(labels[`${this.#options.labelNamespace}.webrtc_host_port`]), {
      allowLabelFallback: options.allowLabelHostPort === true || !isInspectRunning(inspect),
    });
    const containerName = inspect.Name?.replace(LEADING_SLASH_RE, "") ?? "";
    const cdpUrl = this.#expandTemplate(this.#options.cdpBaseUrlTemplate, surfaceId, hostPort, containerName);
    const streamBaseUrl = this.#expandTemplate(this.#options.streamBaseUrlTemplate, surfaceId, hostPort, containerName);
    const windowSettleEndpoint = deriveWindowSettleEndpoint(cdpUrl);
    const readiness = options.readiness ?? (await this.#readiness({ cdpUrl, inspect, streamBaseUrl }));
    const now = this.#options.now().toISOString();
    const accountKey = options.request?.accountKey ?? labels[`${this.#options.labelNamespace}.account_key`];
    const surfaceSubjectId =
      options.request?.surfaceSubjectId ?? labels[`${this.#options.labelNamespace}.surface_subject_id`];
    const surface: BrowserSurface & { readonly window_settle_endpoint: string } = {
      allocator_metadata: {
        container_name: containerName,
        host_port: String(hostPort),
        image: this.#options.image,
        network: this.#options.network,
        profile_path: labels[`${this.#options.labelNamespace}.profile_path`] ?? "",
        profile_slug: labels[`${this.#options.labelNamespace}.profile_slug`] ?? "",
        readiness: readiness.reason,
        resource_owner: "pdpp-reference",
        window_settle_endpoint: windowSettleEndpoint,
      },
      backend: BROWSER_SURFACE_BACKEND_NEKO,
      cdp_url: cdpUrl,
      connector_id: connectorId,
      container_id: inspect.Id,
      created_at: labels[`${this.#options.labelNamespace}.created_at`] ?? now,
      health: readiness.health,
      last_used_at: now,
      profile_key: profileKey,
      stream_base_url: streamBaseUrl,
      surface_id: surfaceId,
      window_settle_endpoint: windowSettleEndpoint,
    };
    if (surfaceSubjectId !== undefined) {
      return {
        ...surface,
        ...(accountKey === undefined ? {} : { account_key: accountKey }),
        surface_subject_id: surfaceSubjectId,
      };
    }
    if (accountKey !== undefined) {
      return { ...surface, account_key: accountKey };
    }
    return surface;
  }

  async #readiness(input: {
    inspect: DockerContainerInspect;
    cdpUrl: string;
    streamBaseUrl: string;
  }): Promise<{ health: BrowserSurfaceHealth; reason: string }> {
    if (!isInspectRunning(input.inspect)) {
      return { health: "stopping", reason: "container_not_running" };
    }
    // Always re-run the migration step, not only when the expected network
    // is missing: `ensureSurface`'s own call to #migrateContainerNetworkIfNeeded
    // may already have attached the expected network while its reachability
    // probe still failed, in which case the legacy network is deliberately
    // left attached (see #migrateContainerNetworkIfNeeded). If this check
    // only looked at `hasNetwork`, that attach-succeeded/reachability-failed
    // case would fall straight through to the normal neko/CDP probes below,
    // which resolve by container name and could silently succeed via the
    // still-attached legacy network — reporting "ready" for a container
    // whose expected-network path was never actually proven to work. A
    // legacy container is still fully reachable on its old network while
    // this runs — reporting "starting" rather than "unhealthy" keeps the
    // caller's lease alive instead of failing it over a condition the
    // allocator itself can fix.
    if ((await this.#migrateContainerNetworkIfNeeded(input.inspect.Id)) === "pending") {
      return { health: "starting", reason: "legacy_network_migration_pending" };
    }
    const nekoReady = await probeUrl(
      this.#options.fetchImpl,
      new URL(this.#options.nekoHealthPath, input.streamBaseUrl)
    );
    if (!nekoReady) {
      return { health: "starting", reason: "neko_http_unready" };
    }
    const cdpVersion = await probeJson(
      this.#options.fetchImpl,
      joinUrlPath(input.cdpUrl, this.#options.cdpVersionPath)
    );
    if (!cdpVersion.ok) {
      return { health: "starting", reason: "cdp_unready" };
    }
    if (!looksLikeChromiumVersion(cdpVersion.value)) {
      return { health: "unhealthy", reason: "chromium_unhealthy" };
    }
    return { health: "ready", reason: "ready" };
  }

  async #findOwnedContainer(surfaceId: string): Promise<DockerContainerInspect | null> {
    const containers = await this.#listOwnedContainers();
    const matches = containers.filter(
      (container) => container.Labels?.[`${this.#options.labelNamespace}.surface_id`] === surfaceId
    );
    if (matches.length === 0) {
      return null;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const first = matches[0];
    if (first === undefined) {
      return null;
    }
    return this.#inspectContainer(first.Id);
  }

  /**
   * Docker's `/containers/json` label filter only ANDs `key=value` terms —
   * it cannot express "deployment_id is absent", which the adoption path
   * needs. So this fetches every generic-owner container across the whole
   * Docker host (as before) and narrows to this deployment's own containers
   * in JS via #isOwnedByThisDeployment, which is the actual isolation
   * boundary: it is what stops one allocator instance from ever enumerating
   * — and therefore ever mutating the network attachments of — a container
   * that belongs to a different, unrelated deployment on the same host.
   * This is the fix for the incident where a throwaway smoke instance
   * enumerated and reconfigured live production containers purely because
   * both shared the same generic `owner=pdpp-reference` label with no
   * further identity to distinguish them.
   */
  async #listOwnedContainers(): Promise<DockerContainerSummary[]> {
    const filters = JSON.stringify({ label: [`${this.#options.labelNamespace}.owner=pdpp-reference`] });
    const value = await this.#docker.requestJson("/containers/json", { query: { all: "true", filters } });
    if (!Array.isArray(value)) {
      throw new NekoSurfaceAllocatorServiceError("docker_malformed_response", "Docker container list was not an array");
    }
    return value.map(parseContainerSummary).filter((container) => this.#isOwnedByThisDeployment(container.Labels));
  }

  /**
   * True only for: (a) a container explicitly labeled with this exact
   * deployment id, or (b) a container carrying the generic owner label,
   * with NO deployment_id label at all (pre-existing containers created
   * before this concept existed), AND whose Compose-assigned
   * `com.docker.compose.project` label — set by Docker Compose itself, never
   * by this allocator, so it cannot be spoofed by our own label-writing code
   * — exactly equals this instance's `deploymentId`. A container belonging
   * to any OTHER deployment id, or any other Compose project, is never
   * eligible under any circumstance.
   *
   * `deploymentId` is deliberately the same identity as the Compose project
   * name (not a second, independently-configured "production identity"
   * concept) — see readNekoSurfaceAllocatorOptionsFromEnv. This is what
   * makes legacy-container recognition safe to run unconditionally, with no
   * opt-in flag: a throwaway/smoke instance's Compose project is, by
   * construction, never the same string as the real deployment's, so it can
   * never legacy-adopt a container it didn't create — the same guarantee an
   * explicit flag would have provided, without the footgun of an operator
   * forgetting to set it and permanently stranding an unlabeled legacy
   * container (Docker labels are immutable after creation — there is no
   * Engine API to add a label to a running container, so recognition must
   * come from something already on the container, not a flag on us).
   *
   * This is a pure, re-derived-every-call decision, never persisted: every
   * listing pass re-evaluates it fresh from the container's actual current
   * labels plus this instance's live config.
   */
  #isOwnedByThisDeployment(labels: Record<string, string> | undefined): boolean {
    const deploymentId = labels?.[`${this.#options.labelNamespace}.deployment_id`];
    if (deploymentId === this.#options.deploymentId) {
      return true;
    }
    if (deploymentId !== undefined) {
      return false;
    }
    return labels?.[COMPOSE_PROJECT_LABEL] === this.#options.deploymentId;
  }

  async #inspectContainer(containerId: string): Promise<DockerContainerInspect> {
    const value = await this.#docker.requestJson(`/containers/${encodeURIComponent(containerId)}/json`);
    return parseContainerInspect(value, this.#options.labelNamespace);
  }

  async #startContainer(containerId: string): Promise<void> {
    await this.#docker.requestJson(`/containers/${encodeURIComponent(containerId)}/start`, {
      method: "POST",
      okStatuses: [204, 304],
    });
  }

  async #removeContainer(containerId: string): Promise<void> {
    await this.#docker.requestJson(`/containers/${encodeURIComponent(containerId)}`, {
      method: "DELETE",
      okStatuses: [204, 404, 409],
      query: { force: "true", v: "false" },
    });
  }

  async assertImageReady(): Promise<void> {
    try {
      await this.#docker.requestJson(`/images/${encodeURIComponent(this.#options.image)}/json`);
    } catch (cause) {
      if (!isDockerNotFoundError(cause)) {
        throw cause;
      }
      throw new NekoSurfaceAllocatorServiceError(
        "image_missing",
        `n.eko container image is missing: ${this.#options.image}`,
        { cause }
      );
    }
  }

  /**
   * Dynamic surfaces must sit on a network Compose does not own, so an
   * ordinary `docker compose down` (which unconditionally tears down every
   * network the project itself created) cannot break their reachability.
   * Ensuring the network here — inspect-then-create, tolerating a 409 from a
   * concurrent creator (e.g. a redeploy script racing an allocator restart)
   * — makes the allocator self-sufficient rather than silently depending on
   * an external script always running first.
   */
  async ensureNetworkExists(): Promise<void> {
    try {
      await this.#docker.requestJson(`/networks/${encodeURIComponent(this.#options.network)}`);
      return;
    } catch (cause) {
      if (!isDockerNotFoundError(cause)) {
        throw cause;
      }
    }
    await this.#docker.requestJson("/networks/create", {
      body: { CheckDuplicate: true, Driver: "bridge", Name: this.#options.network },
      method: "POST",
      okStatuses: [201, 409],
    });
  }

  /**
   * Existing surfaces created before this allocator started managing an
   * externally-owned network are still attached only to whatever network
   * they were created on (Compose's implicit default network, in the
   * pre-migration deploy). Once the expected network becomes
   * `this.#options.network`, such a container would otherwise be flagged
   * `missing_expected_network` by #readiness — a live-safe in-place
   * migration here (attach the expected network, verify attachment AND
   * reachability, then detach the legacy one) keeps the same container/CDP
   * session alive instead of letting a caller replace it and lose the
   * credential-bearing browser process.
   *
   * Idempotent and best-effort: called on every access to an already-running
   * or just-(re)started owned container, so a partial migration (e.g. attach
   * succeeded but the process crashed before detach) is simply retried on
   * the next access. A failure here NEVER causes the container to be
   * removed or replaced — the returned state tells #readiness to keep
   * reporting the container as not-yet-ready
   * ("starting"/"legacy_network_migration_pending") rather than "unhealthy",
   * so callers do not fail the lease over a migration that is itself still
   * possible to retry.
   *
   * Returns "migrated" only once the expected network is BOTH attached and,
   * whenever a legacy network is still attached, proven reachable by direct
   * IP probe — i.e. only once it is safe for #readiness to trust the normal
   * neko/CDP probes (which resolve by container name and could otherwise
   * silently succeed via a still-attached legacy network, masking a broken
   * expected-network path). Returns "pending" for every other case: no
   * legacy network configured is the only way "attached but unprobed" can
   * still count as migrated, since there is then no other path the normal
   * probes could be silently riding.
   */
  // Guard for Docker mutations reached outside ensureSurface's early guard
  // (network attach/detach from status/list, surface_failed removal). Unusable
  // storage means "skip the mutation", never "throw": the read-only caller
  // still gets an answer and nothing is changed.
  async #storageAllowsMutation(): Promise<boolean> {
    try {
      await this.assertProfileStorageReady();
      return true;
    } catch {
      return false;
    }
  }

  async #migrateContainerNetworkIfNeeded(containerId: string): Promise<"migrated" | "pending"> {
    let inspect = await this.#inspectContainer(containerId);
    if (!hasNetwork(inspect, this.#options.network)) {
      // Only an actual attach is a mutation; an already-migrated container is
      // inspected without any filesystem work.
      if (!(await this.#storageAllowsMutation())) {
        return "pending";
      }
      try {
        await this.#connectContainerToNetwork(this.#options.network, containerId);
      } catch {
        // Leave the container exactly as it was; #readiness will report the
        // bounded "migration pending/unavailable" state until a later access
        // (or an operator fixing the underlying Docker issue) allows it to
        // succeed.
        return "pending";
      }
      inspect = await this.#inspectContainer(containerId);
      if (!hasNetwork(inspect, this.#options.network)) {
        return "pending";
      }
    }
    // The attach half may already be done from a prior access (this method
    // is idempotent and re-run on every access) while a legacy detach
    // attempt still failed and needs retrying — so the detach check runs
    // independently of whether an attach just happened above.
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const legacyNetwork = this.#options.legacyNetwork;
    if (legacyNetwork === undefined || legacyNetwork === this.#options.network) {
      return "migrated";
    }
    if (!hasNetwork(inspect, legacyNetwork)) {
      return "migrated";
    }
    // `hasNetwork` above only proves Docker created the endpoint — it says
    // nothing about whether the container is actually reachable OVER that
    // network path yet. Detaching legacy before confirming that would risk
    // cutting the only working path to a container whose expected-network
    // endpoint exists but isn't functional (e.g. the neko/CDP process is
    // still binding, or the bridge is still initializing). Probe the
    // container directly by its IP address ON the expected network — not by
    // container-name DNS, which this allocator (attached to both networks)
    // could resolve via either network and would prove nothing
    // network-specific — before ever detaching the legacy network.
    if (!(await this.#isReachableOnExpectedNetwork(inspect))) {
      return "pending";
    }
    if (!(await this.#storageAllowsMutation())) {
      return "pending";
    }
    try {
      await this.#disconnectContainerFromNetwork(legacyNetwork, containerId);
    } catch {
      // The container is already reachable on the expected network at this
      // point (verified above), so a failed legacy detach is not a
      // durability problem for the live surface — only a cleanup step that
      // can be retried on the next access. Never surface this as replacing
      // or dropping the container.
    }
    return "migrated";
  }

  /**
   * Bounded, non-recursive reachability check used only to gate the legacy
   * network detach in #migrateContainerNetworkIfNeeded. Deliberately does
   * NOT call #readiness (which itself calls
   * #migrateContainerNetworkIfNeeded) — this probes the neko HTTP health
   * endpoint directly against the container's IP address on
   * `this.#options.network`, read straight from Docker's own inspect
   * response, so a positive result can only mean the expected-network path
   * specifically is working, never the legacy path.
   */
  #isReachableOnExpectedNetwork(inspect: DockerContainerInspect): Promise<boolean> {
    const ip = inspect.NetworkSettings?.Networks?.[this.#options.network]?.IPAddress;
    if (ip === undefined || ip.length === 0) {
      return Promise.resolve(false);
    }
    const url = new URL(this.#options.nekoHealthPath, `http://${ip}:${String(this.#options.containerHttpPort)}`);
    return probeUrl(this.#options.fetchImpl, url);
  }

  async #connectContainerToNetwork(network: string, containerId: string): Promise<void> {
    await this.#docker.requestJson(`/networks/${encodeURIComponent(network)}/connect`, {
      body: { Container: containerId },
      method: "POST",
      // 403 here means Docker already considers the container attached
      // (e.g. a concurrent migration attempt won the race) — treat that
      // exactly like success, matching the create-then-tolerate-conflict
      // idiom used by ensureNetworkExists.
      okStatuses: [200, 201, 204, 403],
    });
  }

  async #disconnectContainerFromNetwork(network: string, containerId: string): Promise<void> {
    await this.#docker.requestJson(`/networks/${encodeURIComponent(network)}/disconnect`, {
      body: { Container: containerId, Force: false },
      method: "POST",
      okStatuses: [200, 204, 404],
    });
  }

  #isReplaceableExitedContainer(inspect: DockerContainerInspect): boolean {
    // Any non-running owned container is treated as a replaceable carcass.
    // We intentionally do not try to discriminate "clean shutdown" from
    // "crashed" because the only safe operation against a stale container
    // whose CDP/network state we cannot verify is to remove and recreate.
    // Profile storage lives on the host bind mount and survives container
    // removal, so this is non-destructive for owner-visible state.
    return inspect.State?.Running !== true && inspect.State?.Status !== "running";
  }

  /**
   * Fails unless the profile root can actually host profiles: it is a live
   * directory and a probe directory can be created in it, chowned to the
   * browser uid:gid, written (fsync'd) and removed. `stat` and `access` alone
   * cannot see ENOSPC, a read-only mount, or a filesystem that ignores
   * ownership. Also the readiness check (startup and GET /readyz), run again
   * at the top of every ensureSurface because startup readiness is not
   * permanent.
   *
   * `nlink === 0` means the directory was unlinked while still open (the
   * bind-mounted root's host directory was deleted or its cleanup-managed
   * parent was swept). Every path below it then fails or loops until the
   * mount is recreated, so name that state explicitly.
   *
   * Permissions: the root only has to be usable by the allocator process; the
   * browser container mounts the profile leaf, not the root. A write by the
   * allocator therefore proves nothing about the browser user, which is why
   * the probe and each profile leaf are also verified to be owned by the
   * configured uid:gid with mode 0700. A read-only Docker mount of the leaf
   * cannot be detected from here.
   *
   * Returns the root's (dev, ino) so later steps can detect replacement.
   */
  assertProfileStorageReady(): Promise<ProfileRootIdentity> {
    // One in-flight check shared by overlapping callers, so concurrent
    // requests (or a stalled filesystem) cannot fan out into N probes. No
    // cache: the entry is dropped the moment the check settles, success or
    // failure, and leaf preparation re-checks the root identity itself.
    if (this.#storageCheck !== null) {
      return this.#storageCheck;
    }
    const check = this.#checkProfileStorage();
    this.#storageCheck = check;
    const release = (): void => {
      if (this.#storageCheck === check) {
        this.#storageCheck = null;
      }
    };
    // Both handlers: the derived promise never rejects, so no unhandled
    // rejection; callers still observe `check` itself.
    check.then(release, release);
    return check;
  }

  async #checkProfileStorage(): Promise<ProfileRootIdentity> {
    const before = await this.#statProfileRoot();
    await this.#probeProfileRoot();
    const after = await this.#statProfileRoot();
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw profileStorageError(`profile root ${this.#options.profileRoot} was replaced while it was being checked`);
    }
    return { dev: after.dev, ino: after.ino };
  }

  async #statProfileRoot(): Promise<ProfileDirectoryStat> {
    const root = this.#options.profileRoot;
    let rootStat: ProfileDirectoryStat;
    try {
      rootStat = await this.#options.profileFilesystem.stat(root, { follow: true });
    } catch (cause) {
      throw profileStorageError(`profile root ${root} is not usable (${errnoCode(cause)})`, cause);
    }
    if (!rootStat.isDirectory) {
      throw profileStorageError(`profile root ${root} is not a directory`);
    }
    if (rootStat.nlink === 0) {
      throw profileStorageError(
        `profile root ${root} has been unlinked (deleted while still mounted); recreate the host directory, then restart the allocator and any browser container that mounts it`
      );
    }
    return rootStat;
  }

  async #probeProfileRoot(): Promise<void> {
    const root = this.#options.profileRoot.replace(TRAILING_SLASHES_RE, "");
    const fs = this.#options.profileFilesystem;
    // Unique, nonrecursive, and only ever removed by this call: never touches
    // an existing profile's contents.
    const probeDir = `${root}/${PROBE_PREFIX}${String(process.pid)}-${randomUUID()}`;
    const probeFile = `${probeDir}/probe`;
    let stage = "create";
    let dirCreated = false;
    let fileMayExist = false;
    let handle: ProfileDirectoryHandle | undefined;
    let failure: unknown;
    try {
      await fs.mkdir(probeDir, { mode: PROFILE_DIRECTORY_MODE });
      dirCreated = true;
      stage = "open";
      handle = await fs.openDirectory(probeDir);
      stage = "chown";
      await handle.chown(this.#options.profileOwnerUid, this.#options.profileOwnerGid);
      await handle.chmod(PROFILE_DIRECTORY_MODE);
      stage = "ownership";
      this.#assertBrowserOwnedPrivateDirectory(await handle.stat(), probeDir);
      stage = "write";
      fileMayExist = true;
      await fs.writeNewFile(probeFile, "pdpp-allocator-probe\n");
    } catch (cause) {
      failure = cause;
    }
    const cleanupFailures: string[] = [];
    const attempt = async (what: string, action: () => Promise<void>, ignoreMissing: boolean): Promise<void> => {
      try {
        await action();
      } catch (cause) {
        if (!(ignoreMissing && errnoCode(cause) === "ENOENT")) {
          cleanupFailures.push(`${what} (${errnoCode(cause)})`);
        }
      }
    };
    if (handle !== undefined) {
      await attempt("close probe handle", () => handle.close(), false);
    }
    if (fileMayExist) {
      await attempt("remove probe file", () => fs.unlink(probeFile), true);
    }
    if (dirCreated) {
      await attempt("remove probe directory", () => fs.rmdir(probeDir), true);
    }
    const leftover =
      cleanupFailures.length === 0 ? "" : `; cleanup failed: ${cleanupFailures.join(", ")} (${probeDir})`;
    if (failure !== undefined) {
      const detail = failure instanceof NekoSurfaceAllocatorServiceError ? failure.message : errnoCode(failure);
      throw profileStorageError(
        `profile root ${this.#options.profileRoot} failed its write probe at ${stage} (${detail})${leftover}`,
        failure
      );
    }
    if (cleanupFailures.length > 0) {
      throw profileStorageError(`profile root ${this.#options.profileRoot} probe left residue${leftover}`);
    }
  }

  #assertBrowserOwnedPrivateDirectory(directory: ProfileDirectoryStat, path: string): void {
    const { profileOwnerGid: gid, profileOwnerUid: uid } = this.#options;
    if (!directory.isDirectory || directory.isSymbolicLink || directory.nlink === 0) {
      throw profileStorageError(`${path} is not a live directory`);
    }
    if (directory.uid !== uid || directory.gid !== gid) {
      throw profileStorageError(
        `${path} is owned by ${String(directory.uid)}:${String(directory.gid)}, expected ${String(uid)}:${String(gid)}`
      );
    }
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX mode bits are masked with & to isolate the permission field from the file-type bits.
    if ((directory.mode & PERMISSION_BITS) !== PROFILE_DIRECTORY_MODE) {
      // biome-ignore lint/suspicious/noBitwiseOperators: same permission-bit mask as the check above, for the reported value.
      throw profileStorageError(`${path} has mode ${(directory.mode & PERMISSION_BITS).toString(8)}, expected 700`);
    }
  }

  async #assertProfileRootUnchanged(identity: ProfileRootIdentity): Promise<void> {
    const current = await this.#statProfileRoot();
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw profileStorageError(`profile root ${this.#options.profileRoot} was replaced during allocation`);
    }
  }

  async #prepareProfileDirectory(profilePath: string, rootIdentity: ProfileRootIdentity): Promise<void> {
    const fs = this.#options.profileFilesystem;
    await this.#assertProfileRootUnchanged(rootIdentity);
    // Non-recursive: the root was just validated, so only the final component
    // can be missing. EEXIST is the normal path for an existing profile and
    // for a concurrent request that created it first.
    try {
      await fs.mkdir(profilePath, { mode: PROFILE_DIRECTORY_MODE });
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") {
        throw profileStorageError(`cannot create profile directory ${profilePath} (${errnoCode(cause)})`, cause);
      }
    }
    // Open the leaf once (O_DIRECTORY | O_NOFOLLOW) and do every check and
    // change through that handle, so a swap after the open cannot redirect
    // chown/chmod to another inode. A symlink or file at the path never opens.
    let handle: ProfileDirectoryHandle;
    try {
      handle = await fs.openDirectory(profilePath);
    } catch (cause) {
      const code = errnoCode(cause);
      if (code === "ELOOP" || code === "ENOTDIR") {
        // biome-ignore lint/style/useErrorCause: the cause is passed in the options argument, which the constructor forwards to Error as { cause }; the rule assumes Error's (message, options) order, which this class does not use because `code` comes first.
        throw new NekoSurfaceAllocatorServiceError(
          "profile_path_invalid",
          `profile path ${profilePath} exists but is not a plain directory`,
          { cause }
        );
      }
      throw profileStorageError(`cannot open profile directory ${profilePath} (${code})`, cause);
    }
    try {
      await handle.chown(this.#options.profileOwnerUid, this.#options.profileOwnerGid);
      await handle.chmod(PROFILE_DIRECTORY_MODE);
      const opened = await handle.stat();
      this.#assertBrowserOwnedPrivateDirectory(opened, profilePath);
      // Final identity recheck, immediately before the caller asks Docker to
      // bind this path: the name must still refer to the inode we prepared and
      // the root must still be the one we validated.
      const named = await fs.stat(profilePath, { follow: false });
      if (named.isSymbolicLink || named.dev !== opened.dev || named.ino !== opened.ino) {
        throw new NekoSurfaceAllocatorServiceError(
          "profile_path_invalid",
          `profile path ${profilePath} was replaced while it was being prepared`
        );
      }
      await this.#assertProfileRootUnchanged(rootIdentity);
    } finally {
      // A close failure on a read-only directory fd carries no information
      // worth masking the real error for.
      await handle.close().catch(() => undefined);
    }
  }

  async #allocateHostPort(skippedPorts: ReadonlySet<number> = new Set()): Promise<number> {
    const containers = await this.#listOwnedContainers();
    const occupancy = collectHostPortOccupancy(containers, this.#options.labelNamespace);
    for (const container of containers) {
      if (container.Labels?.[`${this.#options.labelNamespace}.reservation`] !== undefined) {
        for (const port of summaryHostPorts(container, this.#options.labelNamespace)) {
          occupancy.used.add(port);
        }
      }
    }
    for (let port = this.#options.webrtcHostPortStart; port <= this.#options.webrtcHostPortEnd; port += 1) {
      if (occupancy.used.has(port) || skippedPorts.has(port)) {
        continue;
      }
      for (const containerId of occupancy.reclaimable.get(port) ?? []) {
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        await this.#removeContainer(containerId);
      }
      return port;
    }
    throw new NekoSurfaceAllocatorServiceError(
      "port_capacity_exhausted",
      "no configured n.eko WebRTC host ports are available"
    );
  }

  #refuseReservedContainer(inspect: DockerContainerInspect): void {
    if (inspect.Config?.Labels?.[`${this.#options.labelNamespace}.reservation`] !== undefined) {
      reservationRefused();
    }
  }

  #assertContainerMatchesRequest(inspect: DockerContainerInspect, request: SurfaceRequest): void {
    const labels = this.#ownedLabels(inspect);
    if (
      labels[`${this.#options.labelNamespace}.profile_key`] !== request.profileKey ||
      labels[`${this.#options.labelNamespace}.connector_id`] !== request.connectorId
    ) {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "surface id is already owned by a different profile or connector"
      );
    }
  }

  #ownedLabels(inspect: DockerContainerInspect): Record<string, string> {
    const labels = inspect.Config?.Labels ?? {};
    if (labels[`${this.#options.labelNamespace}.owner`] !== "pdpp-reference") {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "Docker resource is not owned by the PDPP reference allocator"
      );
    }
    // Deployment-scoped, not just owner-scoped: a container with the generic
    // owner label but a DIFFERENT deployment_id, or no deployment_id from a
    // different Compose project, belongs to another allocator instance and
    // must be treated as foreign, never read or acted on by this one.
    if (!this.#isOwnedByThisDeployment(labels)) {
      throw new NekoSurfaceAllocatorServiceError(
        "foreign_resource",
        "Docker resource belongs to a different allocator deployment"
      );
    }
    return labels;
  }

  #resourceNames(request: SurfaceRequest): ResourceNames {
    const profileHash = createHash("sha256").update(request.profileKey).digest("hex").slice(0, 16);
    const surfaceHash = createHash("sha256").update(request.surfaceId).digest("hex").slice(0, 16);
    const profileSlug = `${sanitizeResourceSegment(request.connectorId)}-${profileHash}`;
    return {
      containerName: `pdpp-neko-${sanitizeResourceSegment(request.connectorId)}-${surfaceHash}`,
      profileHash,
      profilePath: `${this.#options.profileRoot.replace(TRAILING_SLASHES_RE, "")}/${profileSlug}`,
      profileSlug,
    };
  }

  #labelsForRequest(request: SurfaceRequest, names: ResourceNames, webrtcHostPort: number): Record<string, string> {
    const labels: Record<string, string> = {
      [`${this.#options.labelNamespace}.owner`]: "pdpp-reference",
      [`${this.#options.labelNamespace}.deployment_id`]: this.#options.deploymentId,
      [`${this.#options.labelNamespace}.backend`]: BROWSER_SURFACE_BACKEND_NEKO,
      [`${this.#options.labelNamespace}.surface_id`]: request.surfaceId,
      [`${this.#options.labelNamespace}.connector_id`]: request.connectorId,
      [`${this.#options.labelNamespace}.profile_key`]: request.profileKey,
      [`${this.#options.labelNamespace}.profile_hash`]: names.profileHash,
      [`${this.#options.labelNamespace}.profile_slug`]: names.profileSlug,
      [`${this.#options.labelNamespace}.profile_path`]: names.profilePath,
      [`${this.#options.labelNamespace}.webrtc_host_port`]: String(webrtcHostPort),
      [`${this.#options.labelNamespace}.created_at`]: this.#options.now().toISOString(),
    };
    if (request.surfaceSubjectId !== undefined) {
      labels[`${this.#options.labelNamespace}.surface_subject_id`] = request.surfaceSubjectId;
    }
    if (request.accountKey !== undefined) {
      labels[`${this.#options.labelNamespace}.account_key`] = request.accountKey;
    }
    return labels;
  }

  #containerEnv(request: SurfaceRequest, hostPort: number): string[] {
    const env = {
      NEKO_MEMBER_PROVIDER: "noauth",
      NEKO_SERVER_BIND: `0.0.0.0:${String(this.#options.containerHttpPort)}`,
      NEKO_SERVER_PATH_PREFIX: "/neko",
      NEKO_SERVER_PROXY: "true",
      NEKO_SESSION_IMPLICIT_HOSTING: "true",
      NEKO_WEBRTC_ICELITE: "1",
      NEKO_WEBRTC_TCPMUX: String(hostPort),
      NEKO_WEBRTC_UDPMUX: String(hostPort),
      PDPP_NEKO_CDP_PROXY_PORT: String(this.#options.containerCdpPort),
      PDPP_NEKO_PROFILE_KEY_HASH: createHash("sha256").update(request.profileKey).digest("hex"),
      PDPP_NEKO_SURFACE_ID: request.surfaceId,
      PDPP_NEKO_WEBRTC_HOST_PORT: String(hostPort),
      ...(this.#options.extraEnv ?? {}),
    };
    return Object.entries(env).map(([key, value]) => `${key}=${value}`);
  }

  #containerHealthcheck(): {
    Interval: number;
    Retries: number;
    StartPeriod: number;
    Test: string[];
    Timeout: number;
  } {
    const healthPath = `/${this.#options.nekoHealthPath.replace(LEADING_SLASH_RE, "")}`;
    const cdpVersionPath = `/${this.#options.cdpVersionPath.replace(LEADING_SLASH_RE, "")}`;
    return {
      Interval: 10_000_000_000,
      Retries: 12,
      StartPeriod: 20_000_000_000,
      Test: [
        "CMD-SHELL",
        [
          `wget -q -O /dev/null http://127.0.0.1:${String(this.#options.containerHttpPort)}${healthPath}`,
          `wget -q -O /dev/null http://127.0.0.1:${String(this.#options.containerCdpPort)}${cdpVersionPath}`,
          "supervisorctl status chromium | grep -q RUNNING",
        ].join(" && "),
      ],
      Timeout: 5_000_000_000,
    };
  }

  #expandTemplate(template: string, surfaceId: string, hostPort: number, containerName: string): string {
    return template
      .replaceAll("{surface_id}", encodeURIComponent(surfaceId))
      .replaceAll("{host_port}", String(hostPort))
      .replaceAll("{container_name}", encodeURIComponent(containerName));
  }
}

export function createNekoSurfaceAllocatorHttpHandler(service: NekoSurfaceAllocatorService) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.url?.startsWith(`${BINDING_CONTROL_PREFIX}/`)) {
        await service.handleBindingControl(req, res);
        return;
      }
      await routeAllocatorRequest(service, req, res);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      sendJson(res, statusForError(error), {
        error: error.message,
        ...(error instanceof NekoSurfaceAllocatorServiceError ? { code: error.code } : {}),
      });
    }
  };
}

async function routeAllocatorRequest(
  service: NekoSurfaceAllocatorService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://allocator.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "readyz" && req.method === "GET") {
    await service.assertProfileStorageReady();
    await service.assertImageReady();
    sendJson(res, 200, { ready: true });
    return;
  }
  if (parts.length === 1 && parts[0] === "surfaces") {
    await routeSurfaceCollection(service, req, res);
    return;
  }
  if (parts.length === 2 && parts[0] === "surfaces" && parts[1] !== undefined) {
    await routeSurfaceMember(service, req, res, decodeURIComponent(parts[1]));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function routeSurfaceCollection(
  service: NekoSurfaceAllocatorService,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method === "POST") {
    const body = parseEnsureBody(await readJsonBody(req));
    sendJson(res, 200, { surface: await service.ensureSurface(body) });
    return;
  }
  if (req.method === "GET") {
    sendJson(res, 200, { surfaces: await service.listSurfaces() });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

async function routeSurfaceMember(
  service: NekoSurfaceAllocatorService,
  req: IncomingMessage,
  res: ServerResponse,
  surfaceId: string
): Promise<void> {
  if (req.method === "GET") {
    await sendSurfaceOrNotFound(res, await service.getSurfaceStatus(surfaceId));
    return;
  }
  if (req.method === "DELETE") {
    const body = await readJsonBody(req);
    await sendSurfaceOrNotFound(res, await service.stopSurface({ reason: parseStopReason(body), surfaceId }));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

function sendSurfaceOrNotFound(res: ServerResponse, surface: BrowserSurface | null): void {
  if (surface === null) {
    sendJson(res, 404, { error: "surface_not_found" });
    return;
  }
  sendJson(res, 200, { surface });
}

export async function startNekoSurfaceAllocatorServer(
  options: NekoSurfaceAllocatorServerOptions
): Promise<{ close: () => Promise<void>; url: string }> {
  const service = new NekoSurfaceAllocatorService(options);
  // Fail before listening: an allocator without profiles or its image must exit
  // (visible to the container restart policy) instead of accepting requests
  // it can only fail.
  await service.assertProfileStorageReady();
  await service.assertImageReady();
  await service.ensureNetworkExists();
  const server = createServer(createNekoSurfaceAllocatorHttpHandler(service));
  const listenHost = options.listenHost ?? "127.0.0.1";
  const listenPort = options.listenPort ?? 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      const urlHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
      resolve({
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)));
          }),
        url: `http://${urlHost}:${String(address.port)}/`,
      });
    });
  });
}

function assertAllocatorOptions(options: NekoSurfaceAllocatorServerOptions): void {
  assertNonEmpty(options.image, "image");
  assertNonEmpty(options.network, "network");
  assertNonEmpty(options.deploymentId, "deploymentId");
  assertNonEmpty(options.profileRoot, "profileRoot");
  assertNonEmpty(options.streamBaseUrlTemplate, "streamBaseUrlTemplate");
  assertNonEmpty(options.cdpBaseUrlTemplate, "cdpBaseUrlTemplate");
  if (
    !(Number.isInteger(options.webrtcHostPortStart) && Number.isInteger(options.webrtcHostPortEnd)) ||
    options.webrtcHostPortStart > options.webrtcHostPortEnd
  ) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", "invalid WebRTC host port range");
  }
  if (!isAbsolute(options.profileRoot)) {
    throw new NekoSurfaceAllocatorServiceError(
      "bad_request",
      "profileRoot must be a host absolute path because Docker bind mounts are resolved by the Docker daemon"
    );
  }
  assertNonNegativeInteger(options.profileOwnerUid, "profileOwnerUid");
  assertNonNegativeInteger(options.profileOwnerGid, "profileOwnerGid");
}

function assertSurfaceRequest(request: SurfaceRequest): void {
  assertNonEmpty(request.surfaceId, "surface_id");
  assertNonEmpty(request.connectorId, "connector_id");
  assertNonEmpty(request.profileKey, "profile_key");
}

function assertNonEmpty(value: string | undefined, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${label} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value: number | undefined, label: string): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${label} must be a non-negative integer`);
  }
}

function parseEnsureBody(value: unknown): SurfaceRequest {
  if (!isRecord(value)) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", "request body must be an object");
  }
  const request: SurfaceRequest = {
    connectorId: requiredBodyString(value, "connector_id"),
    profileKey: requiredBodyString(value, "profile_key"),
    surfaceId: requiredBodyString(value, "surface_id"),
  };
  const accountKey = optionalBodyString(value, "account_key");
  const surfaceSubjectId = optionalBodyString(value, "surface_subject_id");
  return {
    ...request,
    ...(accountKey === undefined ? {} : { accountKey }),
    ...(surfaceSubjectId === undefined ? {} : { surfaceSubjectId }),
  };
}

function parseStopReason(value: unknown): StopBrowserSurfaceRequest["reason"] {
  if (!isRecord(value)) {
    return "operator";
  }
  const reason = optionalBodyString(value, "reason");
  if (reason === "idle_ttl" || reason === "operator" || reason === "reconcile" || reason === "surface_failed") {
    return reason;
  }
  return "operator";
}

function requiredBodyString(value: Record<string, unknown>, key: string): string {
  const parsed = optionalBodyString(value, key);
  if (parsed === undefined) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${key} is required`);
  }
  return parsed;
}

function optionalBodyString(value: Record<string, unknown>, key: string): string | undefined {
  const parsed = value[key];
  if (parsed === undefined) {
    return;
  }
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${key} must be a non-empty string`);
  }
  return parsed;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length === 0) {
    return {};
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: This compatibility path preserves the established error shape and propagation.
    throw new NekoSurfaceAllocatorServiceError("bad_request", "request body must be JSON", { cause });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function statusForError(error: Error): number {
  if (!(error instanceof NekoSurfaceAllocatorServiceError)) {
    return 500;
  }
  if (error.code === "bad_request") {
    return 400;
  }
  if (error.code === "not_found") {
    return 404;
  }
  if (error.code === "foreign_resource" || error.code === "profile_path_invalid") {
    return 409;
  }
  if (
    error.code === "port_capacity_exhausted" ||
    error.code === "profile_storage_unavailable" ||
    error.code === "image_missing"
  ) {
    return 503;
  }
  return 502;
}

function parseContainerSummary(value: unknown): DockerContainerSummary {
  if (!isRecord(value) || typeof value.Id !== "string") {
    throw new NekoSurfaceAllocatorServiceError("docker_malformed_response", "Docker container summary is malformed");
  }
  return value as unknown as DockerContainerSummary;
}

function parseContainerInspect(value: unknown, labelNamespace: string): DockerContainerInspect {
  if (!isRecord(value) || typeof value.Id !== "string") {
    throw new NekoSurfaceAllocatorServiceError("docker_malformed_response", "Docker inspect response is malformed");
  }
  const inspect = value as unknown as DockerContainerInspect;
  if (inspect.Config?.Labels?.[`${labelNamespace}.owner`] !== "pdpp-reference") {
    throw new NekoSurfaceAllocatorServiceError("foreign_resource", "Docker inspect response is not PDPP-owned");
  }
  return inspect;
}

function readCreatedContainerId(value: unknown): string {
  if (!isRecord(value) || typeof value.Id !== "string" || value.Id.length === 0) {
    throw new NekoSurfaceAllocatorServiceError(
      "docker_malformed_response",
      "Docker create response is missing container id"
    );
  }
  return value.Id;
}

function readHostPort(
  inspect: DockerContainerInspect,
  containerPort: number,
  options: { readonly allowLabelFallback?: boolean } = {}
): number {
  const bindings = inspect.NetworkSettings?.Ports?.[`${String(containerPort)}/tcp`];
  const hostPort = bindings?.[0]?.HostPort;
  const parsed = hostPort === undefined ? Number.NaN : Number.parseInt(hostPort, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  if (options.allowLabelFallback === true && Number.isInteger(containerPort) && containerPort > 0) {
    return containerPort;
  }
  throw new NekoSurfaceAllocatorServiceError(
    "docker_malformed_response",
    "managed container is missing host port binding"
  );
}

function isDockerNotFoundError(value: unknown): boolean {
  return (
    value instanceof NekoSurfaceAllocatorServiceError &&
    value.code === "docker_http_error" &&
    DOCKER_HTTP_404_RE.test(value.message)
  );
}

function isDockerPortBindError(value: unknown): boolean {
  return value instanceof NekoSurfaceAllocatorServiceError && DOCKER_PORT_BIND_RE.test(value.message);
}

function isInspectRunning(inspect: DockerContainerInspect): boolean {
  return inspect.State?.Running === true || inspect.State?.Status === "running";
}

function isSummaryReclaimable(container: DockerContainerSummary): boolean {
  return container.State === "exited" || container.State === "dead";
}

function collectHostPortOccupancy(
  containers: readonly DockerContainerSummary[],
  labelNamespace: string
): HostPortOccupancy {
  const used = new Set<number>();
  const reclaimable = new Map<number, Set<string>>();
  for (const container of containers) {
    const ports = summaryHostPorts(container, labelNamespace);
    if (isSummaryReclaimable(container)) {
      for (const port of ports) {
        addReclaimableContainer(reclaimable, port, container.Id);
      }
      continue;
    }
    for (const port of ports) {
      used.add(port);
    }
  }
  return { reclaimable, used };
}

function summaryHostPorts(container: DockerContainerSummary, labelNamespace: string): Set<number> {
  const ports = new Set<number>();
  const labelPort = parsePositiveInteger(container.Labels?.[`${labelNamespace}.webrtc_host_port`]);
  if (labelPort !== null) {
    ports.add(labelPort);
  }
  for (const port of container.Ports ?? []) {
    if (port.PublicPort !== undefined) {
      ports.add(port.PublicPort);
    }
  }
  return ports;
}

function addReclaimableContainer(reclaimable: Map<number, Set<string>>, port: number, containerId: string): void {
  const containers = reclaimable.get(port) ?? new Set<string>();
  containers.add(containerId);
  reclaimable.set(port, containers);
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * A running container that Docker's own healthcheck has marked `unhealthy`.
 * The healthcheck (see #containerHealthcheck) probes neko HTTP, CDP
 * /json/version, and the supervised Chromium process, with a StartPeriod that
 * suppresses failures during legitimate cold-start and Retries that debounce
 * transient blips. By the time `State.Health.Status === "unhealthy"`, the
 * surface has failed those probes past its retry budget: the CDP socket /
 * Chromium is wedged, not merely booting. Such a container is as unrecoverable
 * as an exited one, so ensureSurface replaces rather than reuses it.
 *
 * Containers with no healthcheck (Health undefined) or still inside the
 * StartPeriod (Health.Status === "starting") are NOT treated as unhealthy, so
 * a freshly launched surface is never destroyed mid-boot.
 */
function isInspectUnhealthy(inspect: DockerContainerInspect): boolean {
  return isInspectRunning(inspect) && inspect.State?.Health?.Status === "unhealthy";
}

function advertisesEnsureReplacement(inspect: DockerContainerInspect): boolean {
  return isInspectUnhealthy(inspect) || (inspect.State?.Running !== true && inspect.State?.Status !== "running");
}

function hasNetwork(inspect: DockerContainerInspect, network: string): boolean {
  return inspect.NetworkSettings?.Networks?.[network] !== undefined;
}

async function probeUrl(fetchImpl: FetchLike, url: URL, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetchImpl(url, signal ? { signal } : undefined);
    return response.ok;
  } catch {
    return false;
  }
}

async function probeJson(
  fetchImpl: FetchLike,
  url: URL,
  signal?: AbortSignal
): Promise<{ ok: boolean; value?: unknown }> {
  try {
    const response = await fetchImpl(url, signal ? { signal } : undefined);
    if (!response.ok) {
      return { ok: false };
    }
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

function looksLikeChromiumVersion(value: unknown): boolean {
  return isRecord(value) && (typeof value.Browser === "string" || typeof value.webSocketDebuggerUrl === "string");
}

function joinUrlPath(base: string, path: string): URL {
  const url = new URL(base);
  const basePath = url.pathname.replace(TRAILING_SLASHES_RE, "");
  const suffix = path.replace(LEADING_SLASH_RE, "");
  url.pathname = suffix.length === 0 ? `${basePath}/` : `${basePath}/${suffix}`;
  return url;
}

function sanitizeResourceSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized.length === 0 ? "surface" : sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNekoSurfaceAllocatorOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): NekoSurfaceAllocatorServerOptions {
  const profileRoot = readRequiredEnv(env, "PDPP_NEKO_PROFILE_STORAGE_ROOT");
  const hostPortStart = readIntegerEnv(env, "PDPP_NEKO_WEBRTC_HOST_PORT_START", 59_000);
  const hostPortEnd = readIntegerEnv(env, "PDPP_NEKO_WEBRTC_HOST_PORT_END", 59_010);
  return {
    cdpBaseUrlTemplate: env.PDPP_NEKO_CDP_BASE_URL_TEMPLATE ?? "http://{container_name}:9223/",
    // Required, no default: two independently configured allocator
    // instances on the same Docker host must never be able to collide by
    // omission. Deliberately the same identity as this instance's Compose
    // project (COMPOSE_PROJECT_NAME). See
    // NekoSurfaceAllocatorServerOptions#deploymentId.
    deploymentId: readRequiredEnv(env, "PDPP_NEKO_DEPLOYMENT_ID"),
    extraEnv: compactEnv({
      NEKO_DESKTOP_SCREEN: env.NEKO_DESKTOP_SCREEN,
      NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: env.NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD,
      NEKO_MEMBER_MULTIUSER_USER_PASSWORD: env.NEKO_MEMBER_MULTIUSER_USER_PASSWORD,
      NEKO_MEMBER_PROVIDER: env.NEKO_MEMBER_PROVIDER,
      NEKO_PASSWORD: env.NEKO_PASSWORD,
      NEKO_PASSWORD_ADMIN: env.NEKO_PASSWORD_ADMIN,
      NEKO_USERNAME: env.NEKO_USERNAME,
      NEKO_WEBRTC_ICESERVERS: env.NEKO_WEBRTC_ICESERVERS,
      NEKO_WEBRTC_NAT1TO1: env.NEKO_WEBRTC_NAT1TO1,
    }),
    image: readRequiredEnv(env, "NEKO_IMAGE"),
    // Explicit, not inferred: only ever detach the one legacy network an
    // operator configures (or the exact default this repo's own Compose
    // files used before pdpp_neko_dynamic existed). The allocator must never
    // guess at or detach a network it did not create/was not told about.
    legacyNetwork: readOptionalEnv(env, "PDPP_NEKO_LEGACY_DOCKER_NETWORK") ?? legacyComposeDefaultNetwork(env),
    listenHost: env.PDPP_NEKO_ALLOCATOR_HOST ?? DEFAULT_ALLOCATOR_HOST,
    listenPort: readIntegerEnv(env, "PDPP_NEKO_ALLOCATOR_PORT", DEFAULT_ALLOCATOR_PORT),
    network: readRequiredEnv(env, "PDPP_NEKO_DOCKER_NETWORK"),
    profileOwnerGid: readIntegerEnv(env, "PDPP_NEKO_PROFILE_OWNER_GID", DEFAULT_NEKO_PROFILE_GID),
    profileOwnerUid: readIntegerEnv(env, "PDPP_NEKO_PROFILE_OWNER_UID", DEFAULT_NEKO_PROFILE_UID),
    profileRoot,
    streamBaseUrlTemplate: env.PDPP_NEKO_STREAM_BASE_URL_TEMPLATE ?? "http://{container_name}:8080/neko",
    webrtcHostPortEnd: hostPortEnd,
    webrtcHostPortStart: hostPortStart,
  };
}

export function toProfileDirectoryStat(stats: BigIntStats): ProfileDirectoryStat {
  return {
    dev: stats.dev,
    gid: Number(stats.gid),
    ino: stats.ino,
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    mode: Number(stats.mode),
    nlink: Number(stats.nlink),
    uid: Number(stats.uid),
  };
}

const nodeProfileFilesystem: ProfileFilesystem = {
  async mkdir(path, options) {
    await mkdir(path, { mode: options.mode, recursive: false });
  },
  async openDirectory(path) {
    // biome-ignore lint/suspicious/noBitwiseOperators: open(2) open flags are combined with bitwise OR; there is no other API for it.
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    return {
      chmod: (mode) => handle.chmod(mode),
      chown: (uid, gid) => handle.chown(uid, gid),
      close: () => handle.close(),
      stat: async () => toProfileDirectoryStat(await handle.stat({ bigint: true })),
    };
  },
  rmdir: (path) => rmdir(path),
  async stat(path, options) {
    return toProfileDirectoryStat(
      await (options.follow ? stat(path, { bigint: true }) : lstat(path, { bigint: true }))
    );
  },
  unlink: (path) => unlink(path),
  async writeNewFile(path, data) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

function errnoCode(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unknown";
}

function profileStorageError(message: string, cause?: unknown): NekoSurfaceAllocatorServiceError {
  return new NekoSurfaceAllocatorServiceError(
    "profile_storage_unavailable",
    message,
    cause === undefined ? {} : { cause }
  );
}

function compactEnv(values: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function readRequiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${name} is required`);
  }
  return value;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

// Matches this repo's own pre-durability-fix Compose default (see
// docker-compose.neko.yml history before pdpp_neko_dynamic existed), so an
// operator upgrading from that prior deploy gets automatic in-place
// migration without needing to set PDPP_NEKO_LEGACY_DOCKER_NETWORK by hand.
function legacyComposeDefaultNetwork(env: NodeJS.ProcessEnv): string {
  const projectName = readOptionalEnv(env, "COMPOSE_PROJECT_NAME") ?? "pdpp";
  return `${projectName}_default`;
}

function readIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    throw new NekoSurfaceAllocatorServiceError("bad_request", `${name} must be an integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = readNekoSurfaceAllocatorOptionsFromEnv();
  const binding = await readBrowserBindingRuntimeConfig();
  const server = await startNekoSurfaceAllocatorServer({
    ...options,
    ...(binding ? { bindingControl: {
      authorizer: binding.authorizer,
      credential: binding.allocator.credential,
    } } : {}),
  });
  process.stdout.write(`n.eko surface allocator listening at ${server.url}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`n.eko surface allocator failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import { type Duplex, PassThrough, type Readable, type Writable } from "node:stream";
import {
  encodeWorkerDescriptor,
  validateWorkerDescriptor,
  workerImagePath,
} from "../runtime/connector-worker-entry.ts";
import { type DockerEngineTransport, NekoSurfaceAllocatorServiceError } from "./neko-surface-allocator-server.ts";

const ALLOCATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const COMPONENT = "connector-worker-v1";
const MAX_FRAME = 1024 * 1024;
const LABEL_PREFIX = "dev.pdpp.worker.";
// Docker supplies this baseline when an image has no configured Env. It is not inherited
// from the source image; the connector receives only its sealed descriptor environment.
const DOCKER_DEFAULT_PATH = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface WorkerScope {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly ownerId: string;
  readonly runGeneration: string;
  readonly runId: string;
}

/** Supplied by the trusted image build/deployment, never derived from connector input. */
export interface TrustedWorkerArtifact {
  readonly allowedEnvironmentNames: readonly string[];
  readonly artifactDigest: string;
  readonly bootstrapDigest: string;
  readonly bootstrapPath: string;
  readonly connectorEntry: string;
  readonly executionRoot: string;
  readonly imageId: string;
  readonly nodePath: string;
}

export interface WorkerIntent {
  readonly allocationId: string;
  readonly artifact: TrustedWorkerArtifact;
  readonly configRevision: string;
  readonly daemonId: string;
  readonly deploymentId: string;
  readonly networkId: string;
  readonly schema: 1;
  readonly scope: WorkerScope;
}

export interface WorkerReference extends WorkerIntent {
  readonly containerId: string;
}

export interface WorkerAbsentReceipt {
  readonly kind: "absent";
  readonly reference: WorkerReference;
}

export interface WorkerRun {
  readonly closeRelay: () => void;
  readonly completion: Promise<{ readonly exitCode: number; readonly oomKilled: boolean }>;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly stdout: Readable;
}

export interface WorkerAttachTransport {
  attach: (containerId: string, signal: AbortSignal) => Promise<Duplex>;
}

/** A failure never releases Root's durable hold, including cancellation/lost acknowledgments. */
export class WorkerHeldError extends Error {
  readonly intent: WorkerIntent;
  readonly reference: WorkerReference | undefined;

  constructor(intent: WorkerIntent, options: { reference?: WorkerReference | undefined; cause?: unknown } = {}) {
    // A callback/transport error can contain secrets; retain the causal fact without its body.
    super("Worker operation uncertain or refused; retain cleanup hold", {
      cause: options.cause === undefined ? undefined : new Error("Underlying worker operation failed; detail withheld"),
    });
    this.name = "WorkerHeldError";
    this.intent = immutable(structuredClone(intent));
    this.reference = options.reference ? immutable(structuredClone(options.reference)) : undefined;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Docker worker response");
  }
  return value as Record<string, unknown>;
}

function missingContainer(cause: unknown, path: string): boolean {
  const prefix = `Docker GET ${path} returned HTTP 404`;
  return (
    cause instanceof NekoSurfaceAllocatorServiceError &&
    cause.code === "docker_http_error" &&
    (cause.message === prefix || cause.message.startsWith(`${prefix}:`))
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  if (value === undefined) {
    return "undefined";
  }
  return JSON.stringify(value);
}

function revision(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function same(actual: unknown, expected: unknown): void {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error("Docker worker identity/config mismatch");
  }
}

/** Docker omits empty configured lists/maps from some inspect fields. */
function sameDockerFields(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (
      key === "Env" &&
      canonical(value) === "[]" &&
      canonical(actual[key]) === canonical([DOCKER_DEFAULT_PATH])
    ) {
      continue;
    }
    if (
      (actual[key] === null || actual[key] === undefined) &&
      (canonical(value) === "[]" || canonical(value) === "{}")
    ) {
      continue;
    }
    same(actual[key], value);
  }
}

function labels(intent: Omit<WorkerIntent, "configRevision">): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      allocation: intent.allocationId,
      component: COMPONENT,
      daemon: intent.daemonId,
      deployment: intent.deploymentId,
      ...intent.scope,
      artifact: intent.artifact.artifactDigest,
      bootstrap: intent.artifact.bootstrapDigest,
    }).map(([key, value]) => [`${LABEL_PREFIX}${key}`, value])
  );
}

function containerConfig(intent: Omit<WorkerIntent, "configRevision">): Record<string, unknown> {
  return {
    AttachStderr: true,
    AttachStdin: true,
    AttachStdout: true,
    Cmd: [],
    Entrypoint: [intent.artifact.nodePath, intent.artifact.bootstrapPath],
    Env: [],
    ExposedPorts: {},
    Healthcheck: { Test: ["NONE"] },
    HostConfig: {
      AutoRemove: false,
      Binds: [],
      CapAdd: [],
      CapDrop: ["ALL"],
      CgroupnsMode: "private",
      DeviceCgroupRules: [],
      DeviceRequests: [],
      Devices: [],
      GroupAdd: [],
      Init: false,
      IpcMode: "private",
      LogConfig: { Config: {}, Type: "none" },
      Memory: 512 * 1024 * 1024,
      Mounts: [],
      NanoCpus: 1_000_000_000,
      NetworkMode: intent.networkId,
      PidMode: "",
      PidsLimit: 128,
      PortBindings: {},
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyRootfs: true,
      RestartPolicy: { MaximumRetryCount: 0, Name: "no" },
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=67108864,mode=1777" },
      UsernsMode: "",
      UTSMode: "",
      VolumesFrom: [],
    },
    Image: intent.artifact.imageId,
    Labels: labels(intent),
    NetworkDisabled: false,
    NetworkingConfig: { EndpointsConfig: { [intent.networkId]: {} } },
    OpenStdin: true,
    StdinOnce: true,
    StopSignal: "SIGTERM",
    Tty: false,
    User: "65532:65532",
    Volumes: {},
    WorkingDir: intent.artifact.executionRoot,
  };
}

function validateArtifact(a: TrustedWorkerArtifact): void {
  if (
    !(
      IMAGE_ID.test(a.imageId) &&
      DIGEST.test(a.artifactDigest) &&
      DIGEST.test(a.bootstrapDigest) &&
      [a.nodePath, a.bootstrapPath, a.executionRoot, a.connectorEntry].every(workerImagePath) &&
      a.connectorEntry.startsWith(`${a.executionRoot}/`)
    ) ||
    new Set(a.allowedEnvironmentNames).size !== a.allowedEnvironmentNames.length
  ) {
    throw new Error("Missing verified image artifact mapping");
  }
  // Apply the same sealed-environment constraints to the trusted allowlist.
  validateWorkerDescriptor({
    args: [a.connectorEntry],
    cwd: a.executionRoot,
    env: Object.fromEntries(a.allowedEnvironmentNames.map((key) => [key, ""])),
    version: 1,
  });
}

function validateScope(scope: WorkerScope): void {
  for (const value of Object.values(scope)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value.includes("\0")) {
      throw new Error("Invalid worker scope");
    }
  }
  same(
    Object.keys(scope).sort((a, b) => a.localeCompare(b)),
    ["ownerId", "connectionId", "connectorId", "runId", "runGeneration"].sort((a, b) => a.localeCompare(b))
  );
}

/** Docker's HTTP upgrade is raw full-duplex; only the server-to-client direction is multiplexed. */
export class DockerWorkerAttachClient implements WorkerAttachTransport {
  readonly #socketPath: string;

  constructor(options: { readonly socketPath: string }) {
    if (!workerImagePath(options.socketPath)) {
      throw new Error("An absolute trusted Docker socket is required");
    }
    this.#socketPath = options.socketPath;
  }

  attach(containerId: string, signal: AbortSignal): Promise<Duplex> {
    if (!FULL_ID.test(containerId)) {
      return Promise.reject(new Error("Full Docker worker ID required"));
    }
    return new Promise((resolve, reject) => {
      const req = request({
        headers: { Connection: "Upgrade", "Content-Length": "0", Upgrade: "tcp" },
        maxHeaderSize: 16 * 1024,
        method: "POST",
        path: `/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0`,
        signal,
        socketPath: this.#socketPath,
      });
      req.once("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101 || signal.aborted) {
          socket.destroy();
          reject(new Error("Docker attach upgrade refused"));
          return;
        }
        socket.on("error", () => {
          /* Completion or startup reports a redacted error. */
        });
        socket.pause();
        if (head.length > 0) {
          socket.unshift(head);
        }
        // The request signal is startup-only. Active lifetime belongs to Root.
        const abort = () => {
          socket.destroy(new Error("Docker attach cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        socket.once("close", () => {
          signal.removeEventListener("abort", abort);
        });
        resolve(socket);
      });
      req.once("response", (response) => {
        response.destroy();
        reject(new Error("Docker attach did not upgrade"));
      });
      req.once("error", () => {
        reject(new Error("Docker attach transport failed"));
      });
      req.end();
    });
  }
}

function within<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new Error("Worker operation cancelled or deadline exceeded"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
    }
    operation
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", aborted);
      })
      .catch(() => {
        /* The returned promise carries the error. */
      });
  });
}

async function write(stream: Writable, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off("error", failed);
      stream.off("close", failed);
    };
    const failed = () => {
      cleanup();
      reject(new Error("Worker stream write disconnected"));
    };
    stream.once("error", failed);
    stream.once("close", failed);
    stream.write(bytes, (error) => {
      if (error) {
        failed();
      } else {
        cleanup();
        resolve();
      }
    });
    if (stream.destroyed) {
      failed();
    }
  });
}

function frameHeader(header: Buffer): { channel: 1 | 2; remaining: number } {
  const [channel, reserved1, reserved2, reserved3] = header;
  const remaining = header.readUInt32BE(4);
  if (
    (channel !== 1 && channel !== 2) ||
    reserved1 !== 0 ||
    reserved2 !== 0 ||
    reserved3 !== 0 ||
    remaining > MAX_FRAME
  ) {
    throw new Error("Invalid Docker attach frame");
  }
  return { channel, remaining };
}

async function* frames(socket: Duplex): AsyncGenerator<{ channel: 1 | 2; bytes: Buffer }> {
  let pending: Buffer = Buffer.alloc(0);
  let frame: { channel: 1 | 2; remaining: number } | undefined;
  for await (const chunk of socket) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("Invalid Docker attach bytes");
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length > 0) {
      if (!frame) {
        if (pending.length < 8) {
          break;
        }
        frame = frameHeader(pending);
        pending = pending.subarray(8);
      }
      const length = Math.min(frame.remaining, pending.length);
      yield { bytes: pending.subarray(0, length), channel: frame.channel };
      pending = pending.subarray(length);
      frame.remaining -= length;
      if (frame.remaining === 0) {
        frame = undefined;
      }
    }
  }
  if (frame || pending.length > 0) {
    throw new Error("Truncated Docker attach frame");
  }
}

async function demux(socket: Duplex, stdout: Writable, stderr: Writable): Promise<void> {
  for await (const frame of frames(socket)) {
    await write(frame.channel === 1 ? stdout : stderr, frame.bytes);
  }
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      immutable(item);
    }
    Object.freeze(value);
  }
  return value;
}

export interface WorkerResourceOptions {
  readonly artifact: TrustedWorkerArtifact;
  readonly attach: WorkerAttachTransport;
  readonly deploymentId: string;
  readonly docker: DockerEngineTransport;
  readonly networkId: string;
  readonly startupMs?: number;
}

export class ConnectorWorkerResource {
  readonly #options: WorkerResourceOptions;

  constructor(options: WorkerResourceOptions) {
    validateArtifact(options.artifact);
    if (
      !(FULL_ID.test(options.networkId) && options.deploymentId) ||
      options.deploymentId.length > 256 ||
      !Number.isSafeInteger(options.startupMs ?? 10_000) ||
      (options.startupMs ?? 10_000) <= 0 ||
      (options.startupMs ?? 10_000) > 60_000
    ) {
      throw new Error("Invalid worker deployment");
    }
    this.#options = { ...options, artifact: immutable(structuredClone(options.artifact)) };
  }

  #deadline(signal?: AbortSignal): { signal: AbortSignal; close: () => void } {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    const timer = setTimeout(abort, this.#options.startupMs ?? 10_000);
    return {
      close: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      },
      signal: controller.signal,
    };
  }

  async #daemon(signal: AbortSignal): Promise<string> {
    const info = object(await this.#options.docker.requestJson("/info", { signal }));
    if (typeof info.ID !== "string" || !info.ID || info.ID.length > 256) {
      throw new Error("Missing actual Docker daemon identity");
    }
    return info.ID;
  }

  async #bridgeId(idOrName: string, signal: AbortSignal): Promise<string> {
    const network = object(
      await this.#options.docker.requestJson(`/networks/${encodeURIComponent(idOrName)}`, { signal })
    );
    if (
      typeof network.Id !== "string" ||
      !FULL_ID.test(network.Id) ||
      network.Driver !== "bridge" ||
      network.Scope !== "local" ||
      network.Ingress !== false ||
      network.ConfigOnly !== false
    ) {
      throw new Error("Worker requires an inspected local bridge");
    }
    return network.Id;
  }

  async #placement(signal: AbortSignal): Promise<string> {
    const { docker } = this.#options;
    const daemonId = await this.#daemon(signal);
    same(await this.#bridgeId(this.#options.networkId, signal), this.#options.networkId);
    const image = object(await docker.requestJson(`/images/${this.#options.artifact.imageId}/json`, { signal }));
    same(image.Id, this.#options.artifact.imageId);
    const imageConfig = object(image.Config);
    const imageLabels = object(imageConfig.Labels);
    same(imageLabels[`${LABEL_PREFIX}artifact`], this.#options.artifact.artifactDigest);
    same(imageLabels[`${LABEL_PREFIX}bootstrap`], this.#options.artifact.bootstrapDigest);
    // Docker merges source-image Env/Volumes/ports even when create passes empty values.
    for (const key of ["Env", "Volumes", "ExposedPorts", "OnBuild"]) {
      const value = imageConfig[key];
      if (key === "Env" && canonical(value) === canonical([DOCKER_DEFAULT_PATH])) {
        continue;
      }
      if (value !== undefined && value !== null && canonical(value) !== "[]" && canonical(value) !== "{}") {
        throw new Error("Worker source image has inherited ambient configuration");
      }
    }
    return daemonId;
  }

  #validateReference(ref: WorkerReference): void {
    if (
      ref.schema !== 1 ||
      typeof ref.allocationId !== "string" ||
      !ALLOCATION_ID.test(ref.allocationId) ||
      !FULL_ID.test(ref.containerId) ||
      !ref.daemonId ||
      ref.deploymentId !== this.#options.deploymentId ||
      ref.networkId !== this.#options.networkId
    ) {
      throw new Error("Foreign worker reference");
    }
    validateScope(ref.scope);
    same(ref.artifact, this.#options.artifact);
    same(ref.configRevision, revision(containerConfig(ref)));
  }

  async #inspect(ref: WorkerReference, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.#validateReference(ref);
    same(await this.#daemon(signal), ref.daemonId);
    const actual = object(await this.#options.docker.requestJson(`/containers/${ref.containerId}/json`, { signal }));
    same(actual.Id, ref.containerId);
    same(actual.Image, ref.artifact.imageId);
    const expected = containerConfig(ref);
    const expectedConfig = Object.fromEntries(
      Object.entries(expected).filter(([key]) => key !== "HostConfig" && key !== "NetworkingConfig")
    );
    const actualConfig = object(actual.Config);
    // Docker's container.Config omits NetworkDisabled when its boolean value is false.
    sameDockerFields(
      { ...actualConfig, NetworkDisabled: actualConfig.NetworkDisabled === undefined ? false : actualConfig.NetworkDisabled },
      expectedConfig
    );
    sameDockerFields(object(actual.HostConfig), object(expected.HostConfig));
    if (!Array.isArray(actual.Mounts)) {
      throw new Error("Missing worker mount inspection");
    }
    for (const mount of actual.Mounts) {
      const item = object(mount);
      if (item.Type !== "tmpfs" || item.Destination !== "/tmp" || item.Source || item.Name) {
        throw new Error("Unexpected worker mount");
      }
    }
    const networks = object(object(actual.NetworkSettings).Networks);
    if (Object.keys(networks).length !== 1) {
      throw new Error("Unexpected worker network membership");
    }
    const state = object(actual.State);
    const [networkKey] = Object.keys(networks);
    const endpoint = object(Object.values(networks)[0]);
    if (endpoint.NetworkID === "" && state.Status === "created" && state.Running === false && networkKey) {
      // Engine may defer endpoint allocation until start. HostConfig already binds the full
      // network ID; resolve its single pending endpoint to that same inspected bridge now.
      same(await this.#bridgeId(networkKey, signal), ref.networkId);
    } else {
      same(endpoint.NetworkID, ref.networkId);
    }
    return state;
  }

  async prepare(
    scope: WorkerScope,
    callbacks: {
      readonly recordIntent: (intent: WorkerIntent) => Promise<void>;
      readonly recordAllocated: (reference: WorkerReference) => Promise<void>;
      readonly signal?: AbortSignal;
    }
  ): Promise<WorkerReference> {
    validateScope(scope);
    const deadline = this.#deadline(callbacks.signal);
    let intent: WorkerIntent | undefined;
    let reference: WorkerReference | undefined;
    try {
      const daemonId = await this.#placement(deadline.signal);
      const base = {
        allocationId: randomUUID(),
        artifact: this.#options.artifact,
        daemonId,
        deploymentId: this.#options.deploymentId,
        networkId: this.#options.networkId,
        schema: 1 as const,
        scope: structuredClone(scope),
      };
      intent = { ...base, configRevision: revision(containerConfig(base)) };
      await within(callbacks.recordIntent(structuredClone(intent)), deadline.signal);
      deadline.signal.throwIfAborted();
      const created = object(
        await this.#options.docker.requestJson("/containers/create", {
          body: containerConfig(intent),
          method: "POST",
          okStatuses: [201],
          signal: deadline.signal,
        })
      );
      if (typeof created.Id !== "string" || !FULL_ID.test(created.Id)) {
        throw new Error("Invalid created worker ID");
      }
      reference = { ...intent, containerId: created.Id };
      await within(callbacks.recordAllocated(structuredClone(reference)), deadline.signal);
      const state = await this.#inspect(reference, deadline.signal);
      if (state.Running !== false || state.Status !== "created") {
        throw new Error("Worker was not prepared stopped");
      }
      return immutable(structuredClone(reference));
    } catch (error) {
      if (intent) {
        throw new WorkerHeldError(intent, { cause: error, reference });
      }
      throw error;
    } finally {
      deadline.close();
    }
  }

  async recover(reference: WorkerReference, signal?: AbortSignal): Promise<WorkerReference> {
    const ref = structuredClone(reference);
    const deadline = this.#deadline(signal);
    try {
      await this.#inspect(ref, deadline.signal);
      return immutable(ref);
    } finally {
      deadline.close();
    }
  }

  async activate(
    reference: WorkerReference,
    options: {
      readonly authorizeAndRecord: (reference: WorkerReference, signal: AbortSignal) => Promise<boolean>;
      readonly env: Readonly<Record<string, string>>;
      readonly signal?: AbortSignal;
    }
  ): Promise<WorkerRun> {
    const ref = structuredClone(reference);
    this.#validateReference(ref);
    const descriptor = encodeWorkerDescriptor({
      args: [ref.artifact.connectorEntry],
      cwd: ref.artifact.executionRoot,
      env: { ...options.env },
      version: 1,
    });
    if (Object.keys(options.env).some((key) => !ref.artifact.allowedEnvironmentNames.includes(key))) {
      throw new Error("Unapproved worker environment name");
    }
    const deadline = this.#deadline(options.signal);
    let socket: Duplex | undefined;
    try {
      socket = await within(this.#options.attach.attach(ref.containerId, deadline.signal), deadline.signal);
      // Attach consumes no code/credentials. Validate again immediately before authorization/start.
      const state = await this.#inspect(ref, deadline.signal);
      if (state.Running !== false || state.Status !== "created") {
        throw new Error("Worker already started");
      }
      if ((await within(options.authorizeAndRecord(structuredClone(ref), deadline.signal), deadline.signal)) !== true) {
        throw new Error("Worker authorization denied");
      }
      deadline.signal.throwIfAborted();
      await this.#options.docker.requestJson(`/containers/${ref.containerId}/start`, {
        method: "POST",
        okStatuses: [204],
        signal: deadline.signal,
      });
      deadline.signal.throwIfAborted();
      const started = await this.#inspect(ref, deadline.signal);
      if (started.Running !== true || started.Status !== "running") {
        throw new Error("Worker bootstrap did not remain running");
      }
      await within(write(socket, descriptor), deadline.signal);
      deadline.signal.throwIfAborted();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      // Avoid unhandled stream errors if completion is awaited before outputs are consumed.
      stdout.on("error", () => {
        /* Completion reports this failure. */
      });
      stderr.on("error", () => {
        /* Completion reports this failure. */
      });
      const relay = socket;
      const disconnected = () => {
        stdout.destroy(new Error("Worker relay disconnected"));
        stderr.destroy(new Error("Worker relay disconnected"));
      };
      // A socket error must also release writes blocked on an unread output channel.
      relay.on("error", disconnected);
      const completion = (async () => {
        try {
          await demux(relay, stdout, stderr);
          const exitDeadline = this.#deadline();
          try {
            const ended = await this.#inspect(ref, exitDeadline.signal);
            if (
              ended.Running !== false ||
              ended.Status !== "exited" ||
              !Number.isInteger(ended.ExitCode) ||
              typeof ended.OOMKilled !== "boolean" ||
              ended.Error !== ""
            ) {
              throw new Error("Worker exit not observed");
            }
            stdout.end();
            stderr.end();
            return { exitCode: ended.ExitCode as number, oomKilled: ended.OOMKilled };
          } finally {
            exitDeadline.close();
          }
        } catch (cause) {
          relay.destroy();
          stdout.destroy(new Error("Worker completion unknown"));
          stderr.destroy(new Error("Worker completion unknown"));
          throw new WorkerHeldError(ref, { cause, reference: ref });
        } finally {
          relay.off("error", disconnected);
        }
      })();
      // Root owns observing this promise; prevent process-level unhandled-rejection noise meanwhile.
      completion.catch(() => {
        /* The returned promise carries the error. */
      });
      return {
        closeRelay: () => {
          disconnected();
          relay.destroy(new Error("Worker relay cancelled"));
        },
        completion,
        stderr,
        stdin: relay,
        stdout,
      };
    } catch (cause) {
      socket?.destroy();
      throw new WorkerHeldError(ref, { cause, reference: ref });
    } finally {
      deadline.close();
    }
  }

  async #absent(ref: WorkerReference, signal: AbortSignal): Promise<WorkerAbsentReceipt> {
    // Only HTTP 404, followed by a fresh daemon identity check, releases a hold.
    await this.#options.docker.requestJson(`/containers/${ref.containerId}/json`, { okStatuses: [404], signal });
    same(await this.#daemon(signal), ref.daemonId);
    return { kind: "absent", reference: immutable(ref) };
  }

  async remove(reference: WorkerReference, signal?: AbortSignal): Promise<WorkerAbsentReceipt> {
    const ref = structuredClone(reference);
    this.#validateReference(ref);
    const deadline = this.#deadline(signal);
    try {
      same(await this.#daemon(deadline.signal), ref.daemonId);
      // A reference alone never authorizes deleting an extant foreign/mutated resource.
      try {
        await this.#inspect(ref, deadline.signal);
      } catch (cause) {
        // Only the existing client's typed HTTP-404 contract permits absence probing.
        // Foreign/malformed ownership, 409, and transport errors retain their hold.
        if (!missingContainer(cause, `/containers/${ref.containerId}/json`)) {
          throw cause;
        }
        return await this.#absent(ref, deadline.signal);
      }
      await this.#options.docker.requestJson(`/containers/${ref.containerId}`, {
        method: "DELETE",
        okStatuses: [204, 404],
        query: { force: "true", v: "false" },
        signal: deadline.signal,
      });
      return await this.#absent(ref, deadline.signal);
    } catch (cause) {
      throw new WorkerHeldError(ref, { cause, reference: ref });
    } finally {
      deadline.close();
    }
  }
}

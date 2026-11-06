// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, type Readable } from "node:stream";
import test from "node:test";
import {
  ConnectorWorkerResource,
  DockerWorkerAttachClient,
  type TrustedWorkerArtifact,
  WorkerHeldError,
  type WorkerIntent,
  type WorkerReference,
} from "../server/connector-worker-resource.ts";
import {
  type DockerEngineRequestInit,
  type DockerEngineTransport,
  NekoSurfaceAllocatorServiceError,
} from "../server/neko-surface-allocator-server.ts";
import { closeHttpServer } from "./helpers/close-test-server.ts";

const ID = "c".repeat(64);
const NETWORK = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;
const artifact: TrustedWorkerArtifact = {
  allowedEnvironmentNames: ["RUN_ID", "TOKEN"],
  artifactDigest: "d".repeat(64),
  bootstrapDigest: "e".repeat(64),
  bootstrapPath: "/worker/entry.mjs",
  connectorEntry: "/connector/index.mjs",
  executionRoot: "/connector",
  imageId: IMAGE,
  nodePath: "/usr/bin/node",
};
const scope = {
  connectionId: "connection",
  connectorId: "connector",
  ownerId: "owner",
  runGeneration: "generation-1",
  runId: "run",
};

class AttachedSocket extends Duplex {
  readonly writes: Buffer[] = [];
  writeGate: (() => void) | undefined;
  onDescriptor: (() => void) | undefined;
  override _read(): void {
    /* Tests explicitly push Engine output. */
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    this.onDescriptor?.();
    if (this.writeGate) {
      this.writeGate = () => {
        callback();
      };
    } else {
      callback();
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

class Engine implements DockerEngineTransport {
  readonly events: string[] = [];
  readonly socket = new AttachedSocket();
  config: Record<string, unknown> | undefined;
  readonly containers = new Set<string>();
  get present(): boolean {
    return this.containers.has(ID);
  }
  set present(value: boolean) {
    if (value) {
      this.containers.add(ID);
    } else {
      this.containers.delete(ID);
    }
  }
  daemonId = "actual-daemon";
  image = IMAGE;
  network = NETWORK;
  imageEnv: string[] = [];
  state: Record<string, unknown> = { Running: false, Status: "created" };
  alterInspect: ((value: Record<string, unknown>) => void) | undefined;
  onStart: (() => void) | undefined;
  readonly faults = new Set<"inspect" | "start">();
  deleteStatus = 204;
  startCount = 0;
  deleteCount = 0;

  requestJson(path: string, init: DockerEngineRequestInit = {}): Promise<unknown> {
    return Promise.resolve().then(() => {
      init.signal?.throwIfAborted();
      const respond = (status: number, body: unknown): unknown => {
        if (!(init.okStatuses ?? [200]).includes(status)) {
          throw new NekoSurfaceAllocatorServiceError(
            "docker_http_error",
            `Docker ${init.method ?? "GET"} ${path} returned HTTP ${status}`
          );
        }
        return body;
      };
      if (path === "/info") {
        return respond(200, { ID: this.daemonId });
      }
      if (path.startsWith("/networks/")) {
        return respond(200, { ConfigOnly: false, Driver: "bridge", Id: this.network, Ingress: false, Scope: "local" });
      }
      if (path.startsWith("/images/")) {
        return respond(200, {
          Config: {
            Env: this.imageEnv,
            Labels: {
              "dev.pdpp.worker.artifact": artifact.artifactDigest,
              "dev.pdpp.worker.bootstrap": artifact.bootstrapDigest,
            },
          },
          Id: this.image,
        });
      }
      if (path === "/containers/create") {
        this.events.push("create");
        this.config = structuredClone(record(init.body));
        this.present = true;
        return respond(201, { Id: ID });
      }
      assert.ok(path.startsWith(`/containers/${ID}`), "only the exact full ID is addressed");
      if (path.endsWith("/json")) {
        if (this.faults.has("inspect")) {
          throw new Error("transport unavailable");
        }
        if (!this.present) {
          return respond(404, { message: "missing" });
        }
        assert.ok(this.config);
        const result = {
          Config: structuredClone(this.config),
          HostConfig: structuredClone(this.config.HostConfig),
          Id: ID,
          Image: IMAGE,
          Mounts: [],
          NetworkSettings: { Networks: { bridge: { NetworkID: NETWORK } } },
          State: this.state,
        };
        this.alterInspect?.(result);
        return respond(200, result);
      }
      if (path.endsWith("/start")) {
        this.events.push("start");
        this.startCount += 1;
        if (!this.present) {
          return respond(404, { message: "removed IDs cannot restart" });
        }
        this.state = { Running: true, Status: "running" };
        if (this.faults.has("start")) {
          throw new Error("start ack lost");
        }
        this.onStart?.();
        return respond(204, null);
      }
      if (init.method === "DELETE") {
        this.events.push("delete");
        this.deleteCount += 1;
        assert.deepEqual(init.query, { force: "true", v: "false" });
        if (this.deleteStatus === 204) {
          this.present = false;
        }
        return respond(this.deleteStatus, null);
      }
      throw new Error("Unexpected Engine call");
    });
  }
}

function setup(engine = new Engine()) {
  const resource = new ConnectorWorkerResource({
    artifact,
    attach: {
      attach: (_id, signal) => {
        signal.throwIfAborted();
        engine.events.push("attach");
        return Promise.resolve(engine.socket);
      },
    },
    deploymentId: "deployment",
    docker: engine,
    networkId: NETWORK,
  });
  const prepare = () =>
    resource.prepare(scope, {
      recordAllocated: (ref: WorkerReference) => {
        assert.equal(ref.containerId, ID);
        engine.events.push("allocated");
        return Promise.resolve();
      },
      recordIntent: (intent: WorkerIntent) => {
        assert.equal(intent.daemonId, "actual-daemon");
        engine.events.push("intent");
        return Promise.resolve();
      },
    });
  return { engine, prepare, resource };
}

function frame(channel: number, data: string): Buffer {
  const bytes = Buffer.from(data);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

const authorized = () => Promise.resolve(true);

test("prepare records intent/exact allocation, leaves stopped, and puts no credentials at create", async () => {
  const { engine, prepare } = setup();
  const ref = await prepare();
  assert.deepEqual(engine.events, ["intent", "create", "allocated"]);
  assert.equal(ref.containerId, ID);
  assert.equal(ref.scope.runGeneration, "generation-1");
  assert.equal(ref.configRevision.length, 64);
  assert.deepEqual(engine.config?.Env, []);
  assert.deepEqual(engine.config?.Entrypoint, [artifact.nodePath, artifact.bootstrapPath]);
  assert.deepEqual(engine.config?.Cmd, []);
  assert.equal(engine.startCount, 0);
  assert.equal(JSON.stringify(engine.config).includes("secret"), false);
});

test("accepts only Docker's injected default PATH and rejects inherited image environment", async () => {
  const engine = new Engine();
  engine.imageEnv = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
  const { prepare } = setup(engine);
  await prepare();
  assert.equal(engine.startCount, 0);

  const foreign = new Engine();
  foreign.imageEnv = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TOKEN=ambient"];
  const rejected = setup(foreign);
  await assert.rejects(rejected.prepare(), /inherited ambient configuration/);
  assert.deepEqual(foreign.events, []);
});

test("accepts Docker's omission of an empty HostConfig list and still checks nonempty fields", async () => {
  const engine = new Engine();
  engine.alterInspect = (value) => {
    delete record(value.HostConfig).Mounts;
    record(value.Config).Env = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
  };
  await setup(engine).prepare();

  const altered = new Engine();
  altered.alterInspect = (value) => {
    delete record(value.HostConfig).CapDrop;
  };
  await assert.rejects(setup(altered).prepare(), /Worker operation uncertain or refused/);

  const foreignEnv = new Engine();
  foreignEnv.alterInspect = (value) => {
    record(value.Config).Env = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "TOKEN=ambient"];
  };
  await assert.rejects(setup(foreignEnv).prepare(), /Worker operation uncertain or refused/);
});

test("accepts an omitted NetworkDisabled false without defaulting other inspect booleans", async () => {
  const engine = new Engine();
  engine.alterInspect = (value) => {
    delete record(value.Config).NetworkDisabled;
  };
  await setup(engine).prepare();
  assert.equal(engine.startCount, 0);

  await Promise.all(
    [true, null, "false", 0].map(async (networkDisabled) => {
      const altered = new Engine();
      altered.alterInspect = (value) => {
        record(value.Config).NetworkDisabled = networkDisabled;
      };
      await assert.rejects(setup(altered).prepare(), WorkerHeldError);
      assert.equal(altered.startCount, 0);
    })
  );

  const missingPrivilege = new Engine();
  missingPrivilege.alterInspect = (value) => {
    delete record(value.HostConfig).Privileged;
  };
  await assert.rejects(setup(missingPrivilege).prepare(), WorkerHeldError);
});

test("fault proof: denied authorization dispatches zero starts", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  await resource
    .activate(ref, { authorizeAndRecord: () => Promise.resolve(false), env: { TOKEN: "private" } })
    .catch(() => {
      /* The named assertion checks the forbidden dispatch. */
    });
  assert.equal(engine.startCount, 0, "DENIED_AUTHORIZATION_MUST_DISPATCH_ZERO_STARTS");
  assert.equal(engine.socket.writes.length, 0);
});

test("recording completes before start; attach precedes start; stdout/stderr and inspected exit stay distinct", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  engine.socket.onDescriptor = () => {
    engine.state = { Error: "", ExitCode: 7, OOMKilled: false, Running: false, Status: "exited" };
    const output = Buffer.concat([frame(1, "stdout"), frame(2, "stderr")]);
    engine.socket.push(output.subarray(0, 3));
    engine.socket.push(output.subarray(3, 11));
    engine.socket.push(output.subarray(11));
    engine.socket.push(null);
  };
  const run = await resource.activate(ref, {
    authorizeAndRecord: async () => {
      engine.events.push("authorize");
      await Promise.resolve();
      engine.events.push("recorded");
      return true;
    },
    env: { TOKEN: "private" },
  });
  const outputs = await Promise.all([collect(run.stdout), collect(run.stderr), run.completion]);
  assert.deepEqual(outputs, ["stdout", "stderr", { exitCode: 7, oomKilled: false }]);
  assert.deepEqual(engine.events, ["intent", "create", "allocated", "attach", "authorize", "recorded", "start"]);
  const descriptor = Buffer.concat(engine.socket.writes);
  assert.equal(descriptor.readUInt32BE(0), descriptor.length - 4);
  assert.ok(descriptor.subarray(4).toString().includes("private"));
});

test("callback cancellation before dispatch keeps zero starts", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  const abort = new AbortController();
  await assert.rejects(
    resource.activate(ref, {
      authorizeAndRecord: () => {
        abort.abort();
        return Promise.resolve(true);
      },
      env: {},
      signal: abort.signal,
    }),
    WorkerHeldError
  );
  assert.equal(engine.startCount, 0);
});

test("wrong actual image/network/container ID and malformed artifact refuse preparation", async () => {
  await Promise.all(
    [
      (e: Engine) => {
        e.image = `sha256:${"f".repeat(64)}`;
      },
      (e: Engine) => {
        e.network = "f".repeat(64);
      },
      (e: Engine) => {
        e.alterInspect = (value) => {
          value.Id = "f".repeat(64);
        };
      },
      (e: Engine) => {
        e.alterInspect = (value) => {
          record(record(value.Config).Labels)["dev.pdpp.worker.runGeneration"] = "foreign";
        };
      },
      (e: Engine) => {
        e.alterInspect = (value) => {
          record(value.HostConfig).Privileged = true;
        };
      },
      (e: Engine) => {
        e.alterInspect = (value) => {
          record(record(value.NetworkSettings).Networks).extra = { NetworkID: "f".repeat(64) };
        };
      },
    ].map(async (mutate) => {
      const { engine, prepare } = setup();
      mutate(engine);
      await assert.rejects(prepare());
      assert.equal(engine.startCount, 0);
    })
  );
  assert.throws(
    () =>
      new ConnectorWorkerResource({
        artifact: { ...artifact, connectorEntry: "/host/not-in-image.mjs" },
        attach: { attach: () => Promise.resolve(new AttachedSocket()) },
        deploymentId: "d",
        docker: new Engine(),
        networkId: NETWORK,
      })
  );
});

test("fault proof: foreign inspected generation never authorizes removal", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  engine.alterInspect = (value) => {
    record(record(value.Config).Labels)["dev.pdpp.worker.runGeneration"] = "foreign";
  };
  await resource.remove(ref).catch(() => {
    /* The named assertion checks the forbidden dispatch. */
  });
  assert.equal(engine.deleteCount, 0, "FOREIGN_GENERATION_MUST_NEVER_BE_REMOVED");
  assert.equal(engine.present, true);
});

test("foreign reference/deployment/daemon refuses without removal; recover validates exact reference", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  assert.deepEqual(await resource.recover(ref), ref);
  await Promise.all(
    [
      { ...ref, deploymentId: "foreign" },
      { ...ref, daemonId: "foreign" },
      { ...ref, containerId: "short" },
      { ...ref, configRevision: "wrong" },
    ].map((changed) => assert.rejects(resource.remove(changed)))
  );
  assert.equal(engine.deleteCount, 0);
});

test("lost start ack retains exact hold; removal fences a later exact start and supports restart recovery", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  engine.faults.add("start");
  await assert.rejects(resource.activate(ref, { authorizeAndRecord: authorized, env: {} }), (error: unknown) => {
    assert.ok(error instanceof WorkerHeldError);
    assert.deepEqual(error.reference, ref);
    return true;
  });
  assert.equal(engine.present, true);
  assert.equal(engine.state.Running, true);
  const recovered = setup(engine).resource;
  assert.equal((await recovered.remove(ref)).kind, "absent");
  await assert.rejects(engine.requestJson(`/containers/${ID}/start`, { method: "POST", okStatuses: [204] }));
  assert.equal(engine.present, false);
  assert.equal((await recovered.remove(ref)).kind, "absent");
});

test("absence receipt requires authoritative 404, never 409, transport failure or retained state", async () => {
  await Promise.all(
    [409, 500, 204].map(async (status) => {
      const { engine, resource, prepare } = setup();
      const ref = await prepare();
      engine.deleteStatus = status;
      if (status === 204) {
        const call = engine.requestJson.bind(engine);
        engine.requestJson = async (path, init) => {
          const result = await call(path, init);
          if (init?.method === "DELETE") {
            engine.present = true;
          }
          return result;
        };
      }
      await assert.rejects(resource.remove(ref), WorkerHeldError);
    })
  );
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  engine.faults.add("inspect");
  await assert.rejects(resource.remove(ref), WorkerHeldError);
  assert.equal(engine.deleteCount, 0);
});

test("relay disconnect and malformed/truncated frames cannot report connector exit", async () => {
  await Promise.all(
    [Buffer.alloc(0), Buffer.from([1, 0, 0]), frame(3, "bad"), Buffer.from([1, 0, 0, 0, 0, 16, 0, 1])].map(
      async (output) => {
        const { engine, resource, prepare } = setup();
        const ref = await prepare();
        const run = await resource.activate(ref, { authorizeAndRecord: authorized, env: {} });
        if (output.length) {
          engine.socket.push(output);
        }
        engine.socket.push(null);
        run.stdout.resume();
        run.stderr.resume();
        await assert.rejects(run.completion, WorkerHeldError);
      }
    )
  );
});

test("output backpressure prevents reading the next channel until stdout drains", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  const run = await resource.activate(ref, { authorizeAndRecord: authorized, env: {} });
  engine.state = { Error: "", ExitCode: 0, OOMKilled: false, Running: false, Status: "exited" };
  engine.socket.push(Buffer.concat([frame(1, "x".repeat(128 * 1024)), frame(2, "after-drain")]));
  engine.socket.push(null);
  await once(run.stdout, "readable");
  assert.equal(run.stderr.readableLength, 0);
  const [out, err] = await Promise.all([collect(run.stdout), collect(run.stderr), run.completion]);
  assert.equal(out.length, 128 * 1024);
  assert.equal(err, "after-drain");
});

test("real HTTP upgrade attach preserves private stdin, raw framed output, and abort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "worker-attach-"));
  const path = join(root, "engine.sock");
  const server = createServer();
  t.after(async () => {
    for (const peer of peers) {
      peer.destroy();
    }
    await closeHttpServer(server);
    await rm(root, { recursive: true });
  });
  const peers: Duplex[] = [];
  server.on("upgrade", (req, socket) => {
    peers.push(socket);
    assert.equal(req.method, "POST");
    assert.ok(req.url?.includes(ID));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    socket.on("data", (data) => {
      socket.write(frame(1, data.toString()));
    });
  });
  server.listen(path);
  await once(server, "listening");
  const abort = new AbortController();
  const client = new DockerWorkerAttachClient({ socketPath: path });
  const stream = await client.attach(ID, abort.signal);
  stream.on("error", () => {
    /* Abort is asserted through close. */
  });
  stream.write("private-stdin");
  const receivedPromise = once(stream, "data");
  stream.resume();
  const [received] = await receivedPromise;
  assert.deepEqual(received, frame(1, "private-stdin"));
  const closed = once(stream, "close").catch(() => {
    /* Abort can reject the event wait before close is emitted. */
  });
  abort.abort();
  await closed;
  assert.equal(stream.destroyed, true);
  await assert.rejects(client.attach("short", new AbortController().signal));
});

test("startup deadline cancels a pending authorization, and a late approval never dispatches", async (t) => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let approve: ((allowed: boolean) => void) | undefined;
  let entered: (() => void) | undefined;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = resource.activate(ref, {
    authorizeAndRecord: () => {
      entered?.();
      return new Promise<boolean>((resolve) => {
        approve = resolve;
      });
    },
    env: {},
  });
  const rejected = assert.rejects(pending, WorkerHeldError);
  await enteredPromise;
  t.mock.timers.tick(10_001);
  await rejected;
  approve?.(true);
  await Promise.resolve();
  assert.equal(engine.startCount, 0);
  assert.equal(engine.present, true);
});

test("descriptor stdin honors backpressure; cancellation after start keeps the exact hold", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  const abort = new AbortController();
  let queued: (() => void) | undefined;
  const queuedPromise = new Promise<void>((resolve) => {
    queued = resolve;
  });
  engine.socket.writeGate = () => {
    /* The write callback is deliberately held. */
  };
  const original = engine.socket._write.bind(engine.socket);
  engine.socket._write = (chunk, encoding, callback) => {
    original(chunk, encoding, callback);
    queued?.();
  };
  const pending = resource.activate(ref, { authorizeAndRecord: authorized, env: {}, signal: abort.signal });
  const rejected = assert.rejects(pending, WorkerHeldError);
  await queuedPromise;
  assert.equal(engine.startCount, 1);
  assert.ok(engine.socket.writeGate);
  abort.abort();
  await rejected;
  assert.equal(engine.present, true);
  engine.socket.writeGate();
});

test("startup deadline does not become the active run lifetime", async (t) => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = await resource.activate(ref, { authorizeAndRecord: authorized, env: {} });
  t.mock.timers.tick(60_000);
  assert.equal(engine.socket.destroyed, false);
  engine.state = { Error: "", ExitCode: 0, OOMKilled: false, Running: false, Status: "exited" };
  engine.socket.push(null);
  run.stdout.resume();
  run.stderr.resume();
  assert.deepEqual(await run.completion, { exitCode: 0, oomKilled: false });
});

test("prepared references are deeply immutable and cannot alter the configured artifact", async () => {
  const { resource, prepare } = setup();
  const ref = await prepare();
  assert.ok(Object.isFrozen(ref));
  assert.ok(Object.isFrozen(ref.scope));
  assert.ok(Object.isFrozen(ref.artifact));
  assert.throws(() => {
    Object.assign(ref.scope, { runGeneration: "foreign" });
  });
  assert.deepEqual(await resource.recover(ref), ref);
});

test("a start dispatched before removal cannot revive the exact removed container after a late ack", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  const original = engine.requestJson.bind(engine);
  let release: (() => void) | undefined;
  let dispatched: (() => void) | undefined;
  const dispatch = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  engine.requestJson = async (path, init) => {
    if (path.endsWith("/start")) {
      dispatched?.();
      await gate;
    }
    return await original(path, init);
  };
  const pending = resource.activate(ref, { authorizeAndRecord: authorized, env: {} });
  const rejected = assert.rejects(pending, WorkerHeldError);
  await dispatch;
  assert.equal((await resource.remove(ref)).kind, "absent");
  release?.();
  await rejected;
  assert.equal(engine.present, false);
  assert.deepEqual(engine.events, ["intent", "create", "allocated", "attach", "delete", "start"]);
});

test("a trusted exact absent reference retires even after its old image/network are no longer installed", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  engine.present = false;
  const original = engine.requestJson.bind(engine);
  engine.requestJson = (path, init) => {
    if (path.startsWith("/images/") || path.startsWith("/networks/")) {
      return Promise.reject(new Error("placement retired"));
    }
    return original(path, init);
  };
  assert.equal((await resource.remove(ref)).kind, "absent");
  assert.equal(engine.deleteCount, 0);
});

test("a stopped pending endpoint is resolved to the inspected bridge before start and rechecked before descriptor", async () => {
  const { engine, resource, prepare } = setup();
  engine.alterInspect = (value) => {
    if (engine.state.Status === "created") {
      record(record(record(value.NetworkSettings).Networks).bridge).NetworkID = "";
    }
  };
  const ref = await prepare();
  const run = await resource.activate(ref, { authorizeAndRecord: authorized, env: {} });
  assert.equal(engine.socket.writes.length, 1);
  engine.state = { Error: "", ExitCode: 0, OOMKilled: false, Running: false, Status: "exited" };
  engine.socket.push(null);
  run.stdout.resume();
  run.stderr.resume();
  await run.completion;
});

test("wrong network or early bootstrap exit after start withholds the launch descriptor", async () => {
  await Promise.all(
    ["wrong-network", "early-exit"].map(async (fault) => {
      const { engine, resource, prepare } = setup();
      const ref = await prepare();
      if (fault === "early-exit") {
        engine.onStart = () => {
          engine.state = { Error: "", ExitCode: 0, OOMKilled: false, Running: false, Status: "exited" };
        };
      } else {
        engine.alterInspect = (value) => {
          if (engine.state.Running === true) {
            record(record(record(value.NetworkSettings).Networks).bridge).NetworkID = "f".repeat(64);
          }
        };
      }
      await assert.rejects(resource.activate(ref, { authorizeAndRecord: authorized, env: {} }), WorkerHeldError);
      assert.equal(engine.startCount, 1);
      assert.equal(engine.socket.writes.length, 0);
      assert.equal(engine.present, true);
    })
  );
});

test("foreign generation cannot become an absence receipt if the resource disappears during inspection", async () => {
  const { engine, resource, prepare } = setup();
  const ref = await prepare();
  engine.alterInspect = (value) => {
    record(record(value.Config).Labels)["dev.pdpp.worker.runGeneration"] = "foreign";
    engine.present = false;
  };
  await assert.rejects(resource.remove(ref), WorkerHeldError);
  assert.equal(engine.deleteCount, 0);
});

test("relay cancellation and socket errors release output backpressure without an exit receipt", async () => {
  await Promise.all(
    ["cancel", "socket-error", "closed-then-cancel"].map(async (mode) => {
      const { engine, resource, prepare } = setup();
      const ref = await prepare();
      const run = await resource.activate(ref, { authorizeAndRecord: authorized, env: {} });
      engine.socket.push(frame(1, "x".repeat(128 * 1024)));
      await once(run.stdout, "readable");
      const rejected = assert.rejects(run.completion, WorkerHeldError);
      if (mode === "socket-error") {
        engine.socket.destroy(new Error("transport disconnected"));
      } else {
        if (mode === "closed-then-cancel") {
          engine.socket.destroy();
        }
        run.closeRelay();
      }
      await rejected;
      assert.equal(engine.present, true);
      assert.equal(engine.socket.destroyed, true);
    })
  );
});

// Receipt input tests run offline in the existing accounted worker suite. They
// protect the verified-output boundary before any Docker build can be dispatched.
test("worker image input copies verified bytes and refuses drift, traversal and unresolved imports", async () => {
  const { captureWorkerSnapshot } = await import("../server/worker-image-builder.ts");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("process.stdout.write('synthetic');");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const snapshot = {
    artifactDigest: "a".repeat(64),
    entrypoint: "code/main.mjs",
    files: [{ bytes, path: "code/main.mjs", sha256 }],
  };
  const captured = captureWorkerSnapshot(snapshot);
  bytes.fill(0);
  assert.equal(captured.files[0]?.bytes.toString(), "process.stdout.write('synthetic');");
  assert.throws(() => captureWorkerSnapshot(snapshot), { message: "Snapshot byte mismatch" });
  const [restored] = captured.files;
  assert.ok(restored);
  assert.throws(() => captureWorkerSnapshot({ ...snapshot, files: [{ ...restored, path: "code/../main.mjs" }] }));
  assert.throws(() => captureWorkerSnapshot({ ...snapshot, entrypoint: "code/other.mjs", files: [restored] }));
  const unresolved = Buffer.from('import "pdpp-r112-intentionally-unresolved";');
  assert.throws(() =>
    captureWorkerSnapshot({
      ...snapshot,
      files: [{ ...restored, bytes: unresolved, sha256: createHash("sha256").update(unresolved).digest("hex") }],
    })
  );
});

test("worker image input preserves and closes a static relative module graph", async () => {
  const { captureWorkerSnapshot } = await import("../server/worker-image-builder.ts");
  const { createHash } = await import("node:crypto");
  const makeFile = (path: string, source: string) => {
    const bytes = Buffer.from(source);
    return { bytes, path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const main = makeFile("code/main.mjs", 'import { value } from "./lib/reexport.mjs"; console.log(value);');
  const reexport = makeFile("code/lib/reexport.mjs", 'export { value } from "./value.mjs";');
  const value = makeFile("code/lib/value.mjs", 'export const value = "synthetic";');
  const snapshot = { artifactDigest: "b".repeat(64), entrypoint: main.path, files: [main, reexport, value] };
  const captured = captureWorkerSnapshot(snapshot);
  assert.deepEqual(
    captured.files.map((file) => file.path),
    [main.path, reexport.path, value.path]
  );
  assert.deepEqual(
    captured.files.map((file) => file.bytes),
    [main.bytes, reexport.bytes, value.bytes]
  );
  assert.deepEqual(
    captured.files.map((file) => file.imagePath),
    ["/worker/code/main.mjs", "/worker/code/lib/reexport.mjs", "/worker/code/lib/value.mjs"]
  );

  const rejects = (entry: string, dependencies: typeof snapshot.files = [reexport, value]) =>
    assert.throws(() => captureWorkerSnapshot({ ...snapshot, files: [makeFile(main.path, entry), ...dependencies] }), {
      message: "Unsupported dependency closure",
    });
  rejects('import "./missing.mjs";', []);
  rejects('import "../../outside.mjs";');
  rejects('import "node:fs";');
  rejects('import "./lib/value.mjs"; import("./lib/value.mjs");', [value]);
  rejects('import "./lib/value.mjs"; const target = "./lib/value.mjs"; import(target);', [value]);
  const single = makeFile("code/one.mjs", "export const one = 1;");
  assert.throws(
    () =>
      captureWorkerSnapshot({
        ...snapshot,
        entrypoint: single.path,
        files: [single, makeFile("code/../outside.mjs", "export {};")],
      }),
    { message: "Invalid snapshot path" }
  );
  const tampered = { ...value, bytes: Buffer.from("export const value = 'changed';") };
  assert.throws(() => captureWorkerSnapshot({ ...snapshot, files: [main, tampered] }), {
    message: "Snapshot byte mismatch",
  });

  assert.equal(captureWorkerSnapshot({ ...snapshot, entrypoint: single.path, files: [single] }).files.length, 1);
});

test("worker image builder refuses ambient Docker redirects before subprocess dispatch", async () => {
  const { localWorkerDocker } = await import("../server/worker-image-builder.ts");
  const previous = process.env.DOCKER_HOST;
  try {
    process.env.DOCKER_HOST = "tcp://remote.invalid:2375";
    assert.throws(() => localWorkerDocker(() => assert.fail("must not dispatch")), {
      message: "Ambient Docker redirect refused",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = previous;
    }
  }
});

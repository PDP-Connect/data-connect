// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { isAbsolute, posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

export const WORKER_DESCRIPTOR_LIMIT = 64 * 1024;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const UNSAFE_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV)$/;

export interface WorkerLaunchDescriptor {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly version: 1;
}

export function workerImagePath(value: string): boolean {
  return value.startsWith("/") && posix.normalize(value) === value && !value.includes("\0");
}

export function validateWorkerDescriptor(value: unknown): WorkerLaunchDescriptor {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid worker descriptor");
  }
  const d = value as Partial<WorkerLaunchDescriptor>;
  if (
    d.version !== 1 ||
    typeof d.cwd !== "string" ||
    !workerImagePath(d.cwd) ||
    !Array.isArray(d.args) ||
    d.args.length !== 1 ||
    typeof d.args[0] !== "string" ||
    !workerImagePath(d.args[0]) ||
    !d.args[0].startsWith(`${d.cwd}/`) ||
    typeof d.env !== "object" ||
    d.env === null ||
    Array.isArray(d.env)
  ) {
    throw new Error("Invalid worker execution contract");
  }
  for (const [key, item] of Object.entries(d.env)) {
    if (!ENV_NAME.test(key) || UNSAFE_ENV.test(key) || typeof item !== "string" || item.includes("\0")) {
      throw new Error("Invalid sealed worker environment");
    }
  }
  return { args: [...d.args], cwd: d.cwd, env: { ...d.env }, version: 1 };
}

export function encodeWorkerDescriptor(descriptor: WorkerLaunchDescriptor): Buffer {
  const body = Buffer.from(JSON.stringify(validateWorkerDescriptor(descriptor)));
  if (body.length > WORKER_DESCRIPTOR_LIMIT) {
    throw new Error("Worker descriptor exceeds limit");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Reads only the descriptor; bytes sharing its final chunk remain on input. */
export async function readWorkerDescriptor(input: Readable): Promise<WorkerLaunchDescriptor> {
  const readExactly = (length: number): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let remaining = length;
      const cleanup = () => {
        input.off("readable", readable);
        input.off("end", disconnected);
        input.off("close", disconnected);
        input.off("error", disconnected);
      };
      const disconnected = () => {
        cleanup();
        reject(new Error("Worker descriptor disconnected"));
      };
      const readable = () => {
        while (remaining > 0) {
          const chunk: unknown = input.read(remaining);
          if (!Buffer.isBuffer(chunk)) {
            return;
          }
          chunks.push(chunk);
          remaining -= chunk.length;
        }
        cleanup();
        resolve(Buffer.concat(chunks, length));
      };
      input.on("readable", readable);
      input.once("end", disconnected);
      input.once("close", disconnected);
      input.once("error", disconnected);
      if (input.readableEnded || input.destroyed) {
        disconnected();
      } else {
        readable();
      }
    });
  const size = (await readExactly(4)).readUInt32BE();
  if (size === 0 || size > WORKER_DESCRIPTOR_LIMIT) {
    throw new Error("Worker descriptor exceeds limit");
  }
  return validateWorkerDescriptor(JSON.parse((await readExactly(size)).toString("utf8")) as unknown);
}

export interface WorkerEntryOptions {
  readonly input: Readable;
  readonly nodePath: string;
  readonly signals?: {
    on: (event: "SIGTERM" | "SIGINT", listener: () => void) => unknown;
    off: (event: "SIGTERM" | "SIGINT", listener: () => void) => unknown;
  };
  readonly spawnChild?: typeof spawnWorkerChild;
  readonly stderr: Writable;
  readonly stdout: Writable;
}

function spawnWorkerChild(nodePath: string, descriptor: WorkerLaunchDescriptor): ChildProcessWithoutNullStreams {
  return spawn(nodePath, [...descriptor.args], {
    cwd: descriptor.cwd,
    env: { ...descriptor.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** The image entrypoint is trusted; connector code starts only after a complete descriptor. */
export async function runConnectorWorkerEntry(options: WorkerEntryOptions): Promise<number> {
  const descriptor = await readWorkerDescriptor(options.input);
  const child = (options.spawnChild ?? spawnWorkerChild)(options.nodePath, descriptor);
  const signals = options.signals ?? process;
  const terminate = () => {
    child.kill("SIGTERM");
  };
  const interrupt = () => {
    child.kill("SIGINT");
  };
  signals.on("SIGTERM", terminate);
  signals.on("SIGINT", interrupt);
  const disconnected = () => {
    child.kill("SIGTERM");
  };
  const closed = () => {
    if (!options.input.readableEnded) {
      disconnected();
    }
  };
  options.input.on("error", disconnected);
  options.input.on("close", closed);
  child.stdin.on("error", () => {
    options.input.unpipe(child.stdin);
  });
  child.stdout.pipe(options.stdout, { end: false });
  child.stderr.pipe(options.stderr, { end: false });
  options.input.pipe(child.stdin);
  try {
    const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    return code ?? (signal ? 128 + constants.signals[signal] : 125);
  } finally {
    signals.off("SIGTERM", terminate);
    signals.off("SIGINT", interrupt);
    options.input.off("error", disconnected);
    options.input.off("close", closed);
    options.input.unpipe(child.stdin);
  }
}

if (process.argv[1] && isAbsolute(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never print a descriptor, environment, or child error body.
  runConnectorWorkerEntry({
    input: process.stdin,
    nodePath: process.execPath,
    stderr: process.stderr,
    stdout: process.stdout,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 125;
      process.stdin.destroy();
    });
}

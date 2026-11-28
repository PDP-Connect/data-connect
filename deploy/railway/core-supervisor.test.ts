// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// The supervisor starts on import. These fakes stand in for the processes it
// spawns, so a test can make one child fail and watch what happens to the rest.
type FakeChild = EventEmitter & {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

const spawned: { name: string; child: FakeChild }[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1000 + spawned.length,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as FakeChild;
    const name = args.some((arg) => arg.includes("reference-implementation")) ? "reference" : "console";
    spawned.push({ name, child });
    return child;
  }),
}));

// Keep the reference readiness probe off the network: every probe fails.
vi.mock("node:net", () => ({
  default: {
    createConnection: () => {
      const socket = Object.assign(new EventEmitter(), { destroy: () => undefined });
      setImmediate(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket;
    },
  },
}));

vi.mock("./core-first-boot.ts", () => ({ prepareFirstBoot: () => ({ env: {} }) }));

let exitSpy: ReturnType<typeof vi.spyOn>;
let signalListeners: Record<"SIGTERM" | "SIGINT", ReturnType<typeof process.listeners>>;

beforeEach(() => {
  spawned.length = 0;
  vi.resetModules();
  vi.stubEnv("PDPP_BROWSER_HEADLESS", "1");
  vi.stubEnv("PDPP_CORE_RUNTIME_ORACLE", "");
  vi.stubEnv(
    "PDPP_REFERENCE_READY_FILE",
    path.join(mkdtempSync(path.join(tmpdir(), "core-supervisor-")), "ready")
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  signalListeners = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
});

afterEach(() => {
  // Stop the readiness probe and drop the signal handlers the import added.
  for (const { child } of spawned) {
    child.exitCode = 1;
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners[signal].includes(listener)) {
        process.removeListener(signal, listener as NodeJS.SignalsListener);
      }
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function startSupervisor(): Promise<{ reference: FakeChild; console: FakeChild }> {
  await import("./core-supervisor.ts");
  await vi.waitFor(() => expect(spawned).toHaveLength(2));
  const find = (name: string) => spawned.find((entry) => entry.name === name)!.child;
  return { reference: find("reference"), console: find("console") };
}

function failToSpawn(child: FakeChild): void {
  child.pid = undefined;
  child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
}

test("a child that fails to spawn stops its siblings and the supervisor exits non-zero", async () => {
  const { reference, console: consoleChild } = await startSupervisor();

  failToSpawn(reference);

  expect(consoleChild.kill).toHaveBeenCalledWith("SIGTERM");
  expect(exitSpy).not.toHaveBeenCalled();

  consoleChild.emit("exit", null, "SIGTERM");

  expect(exitSpy).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(1);
});

test("a spawn error followed by an exit event ends the child once", async () => {
  const { reference, console: consoleChild } = await startSupervisor();

  failToSpawn(reference);
  reference.emit("exit", 1, null);

  expect(consoleChild.kill).toHaveBeenCalledTimes(1);
  expect(exitSpy).not.toHaveBeenCalled();

  consoleChild.emit("exit", null, "SIGTERM");

  expect(exitSpy).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(1);
});

test("an error on a running child does not end it; its exit does", async () => {
  const { reference, console: consoleChild } = await startSupervisor();

  consoleChild.emit("error", new Error("kill EPERM"));

  expect(reference.kill).not.toHaveBeenCalled();
  expect(exitSpy).not.toHaveBeenCalled();

  consoleChild.emit("exit", 2, null);
  expect(reference.kill).toHaveBeenCalledWith("SIGTERM");
  reference.emit("exit", null, "SIGTERM");

  expect(exitSpy).toHaveBeenCalledTimes(1);
});

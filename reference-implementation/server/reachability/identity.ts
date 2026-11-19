// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostIdentity } from "@tnunamak/gozar";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// instanceId names this installation and must survive restarts: the library
// uses it to tell its own routes from foreign ones. Without a stable id every
// restart orphans the previous boot's routes. bootId names this process and is
// fresh each start: without it the library cannot tell which attached routes
// belong to a dead process and must be closed.
export function loadHostIdentity(dir: string): HostIdentity {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const path = join(dir, "instance-id");
  let instanceId = readInstanceId(path);
  if (!instanceId) {
    instanceId = randomUUID();
    try {
      writeFileSync(path, `${instanceId}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
      instanceId = readInstanceId(path);
    }
  }
  if (!instanceId) {
    throw new Error("instance_id_unreadable");
  }
  return { bootId: randomUUID(), instanceId };
}

function readInstanceId(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return UUID.test(value) ? value : null;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

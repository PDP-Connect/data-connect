// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test, { mock } from "node:test";

const revoked: string[] = [];

mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
mock.module("../lib/load-local-collector-support.ts", { namedExports: { loadLocalCollectorTemplates: async () => null } });
mock.module("../lib/local-collector-support.ts", { namedExports: { resolveLocalCollectorEnrollmentKey: () => null } });
mock.module("../lib/ref-client.ts", {
  namedExports: {
    createDeviceEnrollmentCode: async () => {
      throw new Error("not used");
    },
    revokeDeviceExporter: async (deviceId: string) => {
      revoked.push(deviceId);
    },
  },
});

async function revoke(entries: readonly (readonly [string, string])[]): Promise<string[]> {
  revoked.length = 0;
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  const { revokeDeviceExporterAction } = await import("./actions.ts");
  await revokeDeviceExporterAction(data);
  return [...revoked];
}

test("RAISE-RULES 5: a device is revoked only from the confirmation step", async () => {
  assert.deepEqual(await revoke([["device_id", "dev_1"]]), []);
  assert.deepEqual(await revoke([["device_id", "dev_1"], ["confirm_revoke", "no"]]), []);
  assert.deepEqual(await revoke([["device_id", "dev_1"], ["confirm_revoke", "yes"]]), ["dev_1"]);
});

test("a missing device id revokes nothing, as before", async () => {
  assert.deepEqual(await revoke([["confirm_revoke", "yes"]]), []);
});

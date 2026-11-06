// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Authenticated cleanup locator, never a bearer grant. No mutable names or URLs. */
export interface BindingResourceReference {
  readonly version: 1;
  readonly allocatorId: string;
  readonly deploymentId: string;
  readonly bindingScopeIdentity: string;
  readonly profileIdentity: string;
  readonly connectionId: string;
  readonly ownerId: string;
  readonly connectorId: string;
  readonly instanceKey: string;
  readonly runId: string;
  readonly runGeneration: number;
  readonly reservationId: string;
  readonly containerId: string;
  readonly generation: string;
  readonly configurationRevision: string;
}
const KEYS = [
  "allocatorId",
  "deploymentId",
  "bindingScopeIdentity",
  "profileIdentity",
  "connectionId",
  "ownerId",
  "connectorId",
  "instanceKey",
  "runId",
  "reservationId",
  "containerId",
  "generation",
  "configurationRevision",
] as const;
function dataObject(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  ) {
    throw new Error("Invalid binding resource value");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((item) => !item.enumerable || !Object.hasOwn(item, "value"))) {
    throw new Error("Invalid binding resource value");
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
export function bindingResourceReference(value: unknown): BindingResourceReference {
  const input = dataObject(value);
  if (
    input.version !== 1 ||
    Object.keys(input).length !== KEYS.length + 2 ||
    !Number.isSafeInteger(input.runGeneration) ||
    (input.runGeneration as number) < 1 ||
    typeof input.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.containerId) ||
    !KEYS.every((key) => typeof input[key] === "string" && /^[\x21-\x7e]{1,256}$/.test(input[key] as string))
  ) {
    throw new Error("Invalid binding resource reference");
  }
  // Copy known scalar fields only; the original object can be mutated after this call.
  return Object.freeze(
    Object.fromEntries([
      ["version", 1],
      ["runGeneration", input.runGeneration],
      ...KEYS.map((key) => [key, input[key]]),
    ])
  ) as unknown as BindingResourceReference;
}
export interface BindingResourceCleanupReceipt {
  readonly version: 1;
  readonly reference: BindingResourceReference;
  readonly disposition: "removed";
}
export function bindingResourceCleanupReceipt(
  value: unknown,
  expected: BindingResourceReference
): BindingResourceCleanupReceipt {
  const receipt = dataObject(value);
  const reference = bindingResourceReference(receipt.reference);
  const wanted = bindingResourceReference(expected);
  if (
    Object.keys(receipt).length !== 3 ||
    receipt.version !== 1 ||
    receipt.disposition !== "removed" ||
    reference.runGeneration !== wanted.runGeneration ||
    KEYS.some((key) => reference[key] !== wanted[key])
  )
    throw new Error("Invalid binding cleanup receipt");
  return Object.freeze({ version: 1, reference, disposition: "removed" });
}

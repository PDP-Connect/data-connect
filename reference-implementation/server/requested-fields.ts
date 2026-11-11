// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// What a client read does with requested `fields` that its grant does not
// include. Core has not settled this, so the choice lives in one place:
//
//   "drop"           the field is left out of the projection and the read goes
//                    on (silent).
//   "forbid_named"   403 field_not_granted naming the fields. This is today's
//                    behavior; the list of names tells the caller the field
//                    exists, which an unknown field would not.
//   "forbid_uniform" 403 field_not_granted with one message that does not
//                    depend on which fields were asked for, so a caller learns
//                    nothing about fields outside its grant.
export type UngrantedFieldPolicy = "drop" | "forbid_named" | "forbid_uniform";

// The one-line switch.
export const UNGRANTED_FIELD_POLICY: UngrantedFieldPolicy = "forbid_named";

function fieldNotGranted(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "field_not_granted" });
}

/**
 * The subset of `requested` that the grant allows, or a field_not_granted
 * error, as `policy` decides. A grant without a field list allows everything.
 */
export function resolveRequestedFields(
  requested: readonly string[],
  granted: readonly string[] | null | undefined,
  policy: UngrantedFieldPolicy = UNGRANTED_FIELD_POLICY
): string[] {
  if (!granted) {
    return [...requested];
  }
  const allowed = requested.filter((field) => granted.includes(field));
  if (allowed.length === requested.length || policy === "drop") {
    return allowed;
  }
  if (policy === "forbid_uniform") {
    throw fieldNotGranted("A requested field is not available under this grant");
  }
  const refused = requested.filter((field) => !granted.includes(field));
  throw fieldNotGranted(`Fields not in grant: ${refused.join(", ")}`);
}

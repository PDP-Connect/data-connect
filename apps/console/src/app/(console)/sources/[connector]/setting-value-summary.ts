// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function summarizeSettingList(key: string, values: readonly unknown[]): string {
  if (values.length === 0) return "None selected";
  const noun = /channels?/iu.test(key) ? "channels" : "items";
  const named = values.every((value) => typeof value === "string" && /^[a-z][a-z -]{1,39}$/iu.test(value));
  if (!named) return `${values.length} ${noun}`;
  const names = values as readonly string[];
  return names.length > 5 ? `${names.length} ${noun}: ${names.slice(0, 3).join(", ")} and more` : names.join(", ");
}

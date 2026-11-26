// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The cost a runtime-observation fixture reports for each observed kind. The
// registry definition declares the same value for the initial observation.

export function cost(kind, amount = 0) {
  if (kind !== "free" && kind !== "paid" && kind !== "unknown") {
    throw new TypeError("Invalid fixture cost kind");
  }
  if (!Number.isFinite(amount) || amount < 0 || (kind !== "paid" && amount !== 0)) {
    throw new TypeError("Invalid fixture paid amount");
  }
  return kind === "paid"
    ? { kind, summary: "Fixture paid rate", amount, currency: "USD", period: "month" }
    : { kind, summary: kind === "free" ? "Fixture free rate" : "Fixture rate unknown" };
}

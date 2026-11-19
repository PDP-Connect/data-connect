// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The cost a runtime-observation fixture reports for each observed kind. The
// registry definition declares the same value for the initial observation.

export const cost = (kind) => kind === "paid"
  ? { kind, summary: "Fixture paid rate", amount: 0, currency: "USD", period: "month" }
  : { kind, summary: kind === "free" ? "Fixture free rate" : "Fixture rate unknown" };

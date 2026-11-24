// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { __test, buildLogger } from "../server/transport.ts";

test("production logging does not resolve the optional pretty transport", () => {
  let resolutionAttempts = 0;
  const options = __test.makeLoggerOptions({
    nodeEnv: "production",
    prettyTransportAvailable: () => {
      resolutionAttempts += 1;
      return true;
    },
  });

  assert.equal(resolutionAttempts, 0);
  assert.equal(options.transport, undefined);
});

test("development logging falls back to JSON when pino-pretty is unavailable", () => {
  const options = __test.makeLoggerOptions({
    nodeEnv: "development",
    prettyTransportAvailable: () => false,
  });

  assert.equal(options.transport, undefined);

  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const logger = buildLogger({ prettyTransportAvailable: () => false });
    assert.equal(logger.level, "info");
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});

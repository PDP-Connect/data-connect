// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Trusted fixture adapter decorator: changing an observation changes a typed
// consent disclosure without changing the registered code or configuration.

import { readFile } from "node:fs/promises";
import provider from "./index.mjs";
import { cost } from "./runtime-cost.mjs";

const observation = async () =>
  JSON.parse(await readFile(new URL("../../../runtime-observations.json", import.meta.url), "utf8"));
export default {
  ...provider,
  async detect(context) {
    const result = await provider.detect(context);
    return { ...result, facts: { ...result.facts, fixtureCostKind: (await observation()).costKind } };
  },
  properties(facts) {
    const properties = provider.properties(facts);
    return { ...properties, cost: cost(facts.fixtureCostKind) };
  },
  async runtimeFacts(...args) {
    const result = await provider.runtimeFacts(...args);
    return {
      ...result,
      properties: { ...result.properties, cost: cost((await observation()).costKind) },
    };
  },
};

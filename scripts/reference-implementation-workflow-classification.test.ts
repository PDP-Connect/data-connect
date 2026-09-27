// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(process.cwd(), ".github/workflows/reference-implementation.yml"), "utf8");

describe("reference implementation workflow change classification", () => {
  it("does not run console tests for a workflow-only change", () => {
    const pathCases = [...workflow.matchAll(/case "\$path" in([\s\S]*?)esac/g)];
    const consoleCase = pathCases.at(-1)?.[1];

    expect(consoleCase).toContain("apps/console/*");
    expect(consoleCase).not.toContain(".github/workflows/reference-implementation.yml");
  });
});

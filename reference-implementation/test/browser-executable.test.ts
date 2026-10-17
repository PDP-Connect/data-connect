// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The image owns its Chromium location (/opt/patchright-browsers). These tests
 * pin what happens when the deployment environment names a different path:
 *
 *  - a configured path that lacks the bundled revision falls back to the image
 *    path, with one warning naming both paths;
 *  - a configured path that has the executable is kept (deliberate custom browser);
 *  - when neither has it, the configured value is kept and the boot check is loud.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrowserCheckLogger,
  type BrowserPathWarning,
  bundledChromiumRevision,
  checkBrowserExecutableAtBoot,
  chromiumExecutablePath,
  IMAGE_BROWSERS_PATH,
  resolveBrowsersPath,
} from "../runtime/browser-executable.ts";
import { composeConnectorChildEnvironment } from "../runtime/connector-child-environment.ts";

const REVISION = "1243";
const STALE = "/stale/browsers";
const CUSTOM = "/opt/custom-chromium";
const HOME = "/home/node";
const IMAGE_EXECUTABLE = `${IMAGE_BROWSERS_PATH}/chromium-${REVISION}/chrome-linux64/chrome`;

function existsOnly(...paths: string[]): (executablePath: string) => boolean {
  const present = new Set(paths);
  return (executablePath) => present.has(executablePath);
}

const deps = (...present: string[]) => ({
  arch: "x64",
  executableExists: existsOnly(...present),
  homeDir: HOME,
  platform: "linux" as const,
  revision: REVISION,
});

function compose(sourceEnv: NodeJS.ProcessEnv, present: string[], extra: { explicit?: Record<string, string> } = {}) {
  const warnings: { message: string; warning: BrowserPathWarning }[] = [];
  const env = composeConnectorChildEnvironment({
    browserPath: {
      ...deps(...present),
      onFallback: (warning, message) => warnings.push({ message, warning }),
      warned: new Set<string>(),
    },
    connectorId: "test-connector",
    explicitRunEnv: extra.explicit ?? {},
    manifest: {},
    platform: "linux",
    sourceEnv,
  });
  return { env, warnings };
}

test("chromiumExecutablePath follows Patchright's Linux layout per architecture", () => {
  assert.equal(chromiumExecutablePath("/b", "1243", "linux", "x64"), "/b/chromium-1243/chrome-linux64/chrome");
  assert.equal(chromiumExecutablePath("/b", "1243", "linux", "arm64"), "/b/chromium-1243/chrome-linux-arm64/chrome");
  assert.equal(chromiumExecutablePath("/b", "1243", "win32", "x64"), null);
});

test("the bundled revision is read from the installed patchright-core", () => {
  assert.match(bundledChromiumRevision() ?? "", /^\d+$/);
});

test("child environment: a stale PLAYWRIGHT_BROWSERS_PATH falls back to the image path and warns once", () => {
  const { env, warnings } = compose({ PLAYWRIGHT_BROWSERS_PATH: STALE }, [IMAGE_EXECUTABLE]);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.warning.configuredPath, STALE);
  assert.equal(warnings[0]?.warning.fallbackPath, IMAGE_BROWSERS_PATH);
  assert.equal(warnings[0]?.warning.revision, REVISION);
  assert.match(warnings[0]?.message ?? "", /\/stale\/browsers.*\/opt\/patchright-browsers/);
});

test("child environment: both variables are corrected, with one warning", () => {
  const { env, warnings } = compose({ PATCHRIGHT_BROWSERS_PATH: STALE, PLAYWRIGHT_BROWSERS_PATH: STALE }, [
    IMAGE_EXECUTABLE,
  ]);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
  assert.equal(env.PATCHRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
  assert.equal(warnings.length, 1);
});

test("child environment: only PATCHRIGHT_BROWSERS_PATH wrong still sets the variable Patchright reads", () => {
  const { env, warnings } = compose({ PATCHRIGHT_BROWSERS_PATH: STALE }, [IMAGE_EXECUTABLE]);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
  assert.equal(env.PATCHRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
  assert.equal(warnings.length, 1);
});

test("child environment: a good PATCHRIGHT_BROWSERS_PATH does not stand in for an unset PLAYWRIGHT_BROWSERS_PATH", () => {
  const customExecutable = `${CUSTOM}/chromium-${REVISION}/chrome-linux64/chrome`;
  const { env } = compose({ PATCHRIGHT_BROWSERS_PATH: CUSTOM }, [customExecutable, IMAGE_EXECUTABLE]);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
  assert.equal(env.PATCHRIGHT_BROWSERS_PATH, CUSTOM);
});

test("child environment: the same stale path warns once across runs", () => {
  const warnings: string[] = [];
  const warned = new Set<string>();
  for (let run = 0; run < 3; run += 1) {
    composeConnectorChildEnvironment({
      browserPath: { ...deps(IMAGE_EXECUTABLE), onFallback: (_w, message) => warnings.push(message), warned },
      explicitRunEnv: {},
      manifest: {},
      platform: "linux",
      sourceEnv: { PLAYWRIGHT_BROWSERS_PATH: STALE },
    });
  }
  assert.equal(warnings.length, 1);
});

test("child environment: a configured path that has the executable is kept", () => {
  const customExecutable = `${CUSTOM}/chromium-${REVISION}/chrome-linux64/chrome`;
  const { env, warnings } = compose({ PLAYWRIGHT_BROWSERS_PATH: CUSTOM }, [customExecutable, IMAGE_EXECUTABLE]);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, CUSTOM);
  assert.deepEqual(warnings, []);
});

test("child environment: when neither path has the executable the configured value is kept", () => {
  const { env, warnings } = compose({ PLAYWRIGHT_BROWSERS_PATH: STALE }, []);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, STALE);
  assert.deepEqual(warnings, []);
});

test("child environment: an unset variable whose default directory lacks Chromium gets the image path", () => {
  const { env } = compose({}, [IMAGE_EXECUTABLE]);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
});

test("child environment: a path set by the run layer is judged like any other", () => {
  const { env } = compose({}, [IMAGE_EXECUTABLE], { explicit: { PLAYWRIGHT_BROWSERS_PATH: STALE } });
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, IMAGE_BROWSERS_PATH);
});

test("resolveBrowsersPath does not judge platforms without a known layout, or the package-local 0 setting", () => {
  assert.equal(
    resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: STALE }, { ...deps(), platform: "win32" }).kind,
    "unchecked",
  );
  assert.equal(resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "0" }, deps(IMAGE_EXECUTABLE)).kind, "unchecked");
  assert.equal(resolveBrowsersPath({}, { ...deps(), revision: null }).kind, "unchecked");
});

function capturingLogger() {
  const entries: { level: "error" | "info" | "warn"; msg: string; obj: Record<string, unknown> }[] = [];
  const logger: BrowserCheckLogger = {
    error: (obj, msg) => entries.push({ level: "error", msg, obj }),
    info: (obj, msg) => entries.push({ level: "info", msg, obj }),
    warn: (obj, msg) => entries.push({ level: "warn", msg, obj }),
  };
  return { entries, logger };
}

test("boot check: logs one error naming the path and revision when Chromium is missing", () => {
  const { entries, logger } = capturingLogger();
  const result = checkBrowserExecutableAtBoot(
    logger,
    { PDPP_RUNTIME_BROWSER: "1", PLAYWRIGHT_BROWSERS_PATH: STALE },
    deps(),
  );
  assert.equal(result?.kind, "missing");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.level, "error");
  assert.match(
    entries[0]?.msg ?? "",
    /revision 1243 is missing at \/stale\/browsers\/chromium-1243\/chrome-linux64\/chrome/,
  );
  assert.equal(entries[0]?.obj.chromium_revision, REVISION);
  assert.equal(entries[0]?.obj.browsers_path, STALE);
});

test("boot check: warns when the connectors will use the fallback, and reports success otherwise", () => {
  const fallback = capturingLogger();
  checkBrowserExecutableAtBoot(
    fallback.logger,
    { PDPP_RUNTIME_BROWSER: "1", PLAYWRIGHT_BROWSERS_PATH: STALE },
    deps(IMAGE_EXECUTABLE),
  );
  assert.deepEqual(
    fallback.entries.map((entry) => entry.level),
    ["warn"],
  );
  assert.match(fallback.entries[0]?.msg ?? "", /\/opt\/patchright-browsers/);

  const ok = capturingLogger();
  checkBrowserExecutableAtBoot(
    ok.logger,
    { PDPP_RUNTIME_BROWSER: "1", PLAYWRIGHT_BROWSERS_PATH: IMAGE_BROWSERS_PATH },
    deps(IMAGE_EXECUTABLE),
  );
  assert.deepEqual(
    ok.entries.map((entry) => entry.level),
    ["info"],
  );
});

test("boot check: stays silent outside browser images and never throws", () => {
  const silent = capturingLogger();
  assert.equal(checkBrowserExecutableAtBoot(silent.logger, { PLAYWRIGHT_BROWSERS_PATH: STALE }, deps()), null);
  assert.deepEqual(silent.entries, []);

  const throwing = capturingLogger();
  const result = checkBrowserExecutableAtBoot(
    throwing.logger,
    { PDPP_RUNTIME_BROWSER: "1" },
    {
      ...deps(),
      executableExists: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(result, null);
  assert.deepEqual(
    throwing.entries.map((entry) => entry.level),
    ["warn"],
  );
});

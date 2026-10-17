// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the bundled Patchright expects its Chromium, and what to do when the
 * environment points somewhere else.
 *
 * Patchright reads `PLAYWRIGHT_BROWSERS_PATH` once, at module load, and looks
 * for `<path>/chromium-<revision>/<platform dir>/chrome`. The revision is fixed
 * by the pinned Patchright version (patchright-core/browsers.json). A deploy
 * environment that carries a stale `PLAYWRIGHT_BROWSERS_PATH` therefore makes
 * every browser connector fail at launch with "Executable doesn't exist".
 *
 * The Docker image installs Chromium into {@link IMAGE_BROWSERS_PATH} and sets
 * the variable itself. Two guards cover an environment that overrides it:
 *
 *  - {@link reconcileConnectorBrowsersPath} runs when a connector child
 *    environment is built. If the configured path lacks the executable and the
 *    image path has it, the child gets the image path. A configured path that
 *    has the executable is never replaced, so a deliberate custom browser wins.
 *  - {@link checkBrowserExecutableAtBoot} reports the outcome once at startup,
 *    and is the loud signal when neither path has the executable.
 *
 * Scope: this inspects the Patchright pinned by this package. A connector that
 * bundles a different Patchright revision is not covered.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

/** Where the Core Docker image installs Chromium (see the `browsers` stage of the Dockerfiles). */
export const IMAGE_BROWSERS_PATH = "/opt/patchright-browsers";

/**
 * Variables that can name a browsers directory. Patchright itself reads only
 * the first; the second is passed through to connectors and is reconciled the
 * same way so the two never disagree.
 */
export const BROWSERS_PATH_ENV_KEYS = ["PLAYWRIGHT_BROWSERS_PATH", "PATCHRIGHT_BROWSERS_PATH"] as const;

/** The only variable patchright-core 1.63.0 reads for the browsers directory. */
const PATCHRIGHT_READS_KEY = "PLAYWRIGHT_BROWSERS_PATH";

const LINUX_EXECUTABLE_DIRS: Readonly<Record<string, string>> = {
  arm64: "chrome-linux-arm64",
  x64: "chrome-linux64",
};

export interface BrowserExecutableDeps {
  readonly arch?: string;
  readonly executableExists?: (executablePath: string) => boolean;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  /** Chromium revision Patchright expects. `null` means it could not be determined. */
  readonly revision?: string | null;
}

let cachedBundledRevision: string | null | undefined;

/** Chromium revision of the Patchright pinned by this package, or `null` if it cannot be read. */
export function bundledChromiumRevision(): string | null {
  if (cachedBundledRevision !== undefined) {
    return cachedBundledRevision;
  }
  try {
    const corePackage = createRequire(import.meta.url).resolve("patchright-core/package.json");
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(corePackage), "browsers.json"), "utf8")) as {
      browsers?: { name?: string; revision?: string }[];
    };
    cachedBundledRevision = manifest.browsers?.find((browser) => browser.name === "chromium")?.revision ?? null;
  } catch {
    cachedBundledRevision = null;
  }
  return cachedBundledRevision;
}

/** Full path of the Chromium executable under `browsersPath`, or `null` on platforms this check does not cover. */
export function chromiumExecutablePath(
  browsersPath: string,
  revision: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const executableDir = platform === "linux" ? LINUX_EXECUTABLE_DIRS[arch] : undefined;
  return executableDir ? path.join(path.resolve(browsersPath), `chromium-${revision}`, executableDir, "chrome") : null;
}

/** Directory Patchright uses when `PLAYWRIGHT_BROWSERS_PATH` is unset on Linux. */
function defaultBrowsersPath(homeDir: string): string {
  return path.join(homeDir, ".cache", "ms-playwright");
}

export type BrowserPathResolution =
  | { readonly kind: "unchecked"; readonly reason: string }
  | {
      readonly kind: "present";
      readonly browsersPath: string;
      readonly executable: string;
      readonly revision: string;
    }
  | {
      readonly kind: "fell_back";
      readonly configuredPath: string;
      readonly executable: string;
      readonly fallbackPath: string;
      readonly revision: string;
      /** Replacement values: the variable Patchright reads, plus any other that was set and lacked the executable. */
      readonly replacements: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "missing";
      readonly browsersPath: string;
      readonly executable: string;
      readonly revision: string;
    };

/**
 * Decide which browsers directory a connector should get, without changing
 * anything. `env` is the environment the connector would otherwise receive.
 */
export function resolveBrowsersPath(
  env: Readonly<Record<string, string | undefined>>,
  deps: BrowserExecutableDeps = {},
): BrowserPathResolution {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const revision = deps.revision === undefined ? bundledChromiumRevision() : deps.revision;
  if (revision === null) {
    return { kind: "unchecked", reason: "could not read the Chromium revision from patchright-core/browsers.json" };
  }
  if (chromiumExecutablePath(IMAGE_BROWSERS_PATH, revision, platform, arch) === null) {
    return { kind: "unchecked", reason: `no Chromium layout is known for ${platform}-${arch}` };
  }
  const executableExists = deps.executableExists ?? existsSync;
  const executableUnder = (browsersPath: string) =>
    chromiumExecutablePath(browsersPath, revision, platform, arch) as string;

  const configured = BROWSERS_PATH_ENV_KEYS.flatMap((key) => {
    const value = env[key]?.trim();
    return value ? [{ key, value }] : [];
  });
  // "0" tells Patchright to use its package-local install; it is not a directory. Only the
  // variable Patchright reads has that meaning; "0" in the other one is not a path to judge.
  if (configured.some(({ key, value }) => key === PATCHRIGHT_READS_KEY && value === "0")) {
    return { kind: "unchecked", reason: "browsers path is 0 (Patchright package-local browsers)" };
  }

  // Patchright reads only PLAYWRIGHT_BROWSERS_PATH (patchright-core registryDirectory), and uses its
  // default directory when that is unset, so that variable is always in play. PATCHRIGHT_BROWSERS_PATH
  // is judged too, when set, so the two never disagree.
  const playwrightValue = configured.find(({ key }) => key === PATCHRIGHT_READS_KEY)?.value;
  const inEffect = [
    { key: PATCHRIGHT_READS_KEY, value: playwrightValue ?? defaultBrowsersPath(deps.homeDir ?? homedir()) },
    ...configured.filter(({ key, value }) => key !== PATCHRIGHT_READS_KEY && value !== "0"),
  ];
  const lacking = inEffect.filter(({ value }) => !executableExists(executableUnder(value)));
  const [first] = inEffect;
  if (lacking.length === 0 || first === undefined) {
    const browsersPath = path.resolve(first?.value ?? IMAGE_BROWSERS_PATH);
    return { browsersPath, executable: executableUnder(browsersPath), kind: "present", revision };
  }
  if (executableExists(executableUnder(IMAGE_BROWSERS_PATH))) {
    return {
      configuredPath: path.resolve(lacking[0]?.value ?? first.value),
      executable: executableUnder(IMAGE_BROWSERS_PATH),
      fallbackPath: IMAGE_BROWSERS_PATH,
      kind: "fell_back",
      // Only the variables whose path lacks the executable. The variable Patchright reads is always
      // judged (via its default when unset), so a stale or empty default is replaced, while a valid
      // custom path stays as configured.
      replacements: Object.fromEntries(lacking.map(({ key }) => [key, IMAGE_BROWSERS_PATH])),
      revision,
    };
  }
  const browsersPath = path.resolve(lacking[0]?.value ?? first.value);
  return { browsersPath, executable: executableUnder(browsersPath), kind: "missing", revision };
}

export interface BrowserPathWarning {
  readonly configuredPath: string;
  readonly expectedExecutable: string;
  readonly fallbackPath: string;
  readonly revision: string;
}

export interface ReconcileOptions extends BrowserExecutableDeps {
  /** Receives the one warning per distinct (configured, fallback) pair. Defaults to stderr. */
  readonly onFallback?: (warning: BrowserPathWarning, message: string) => void;
  /** Pairs already warned about. Defaults to a process-wide set. */
  readonly warned?: Set<string>;
}

const processWarned = new Set<string>();

export function describeFallback(warning: BrowserPathWarning): string {
  return (
    `browser path fallback: the browsers path in effect, ${warning.configuredPath}, has no Chromium ` +
    `revision ${warning.revision} (expected ${warning.expectedExecutable}); ` +
    `connectors use ${warning.fallbackPath}, which does. Remove the stale PLAYWRIGHT_BROWSERS_PATH ` +
    "(or PATCHRIGHT_BROWSERS_PATH) setting from the deployment environment."
  );
}

/**
 * Correct `env` in place when its browsers path lacks Chromium and the image
 * path has it. Does nothing when the configured path has the executable, when
 * neither path has it (the boot check reports that), or when no path is set.
 */
export function reconcileConnectorBrowsersPath(env: Record<string, string>, options: ReconcileOptions = {}): void {
  const resolution = resolveBrowsersPath(env, options);
  if (resolution.kind !== "fell_back") {
    return;
  }
  Object.assign(env, resolution.replacements);
  const warning: BrowserPathWarning = {
    configuredPath: resolution.configuredPath,
    expectedExecutable: chromiumExecutablePath(
      resolution.configuredPath,
      resolution.revision,
      options.platform,
      options.arch,
    ) as string,
    fallbackPath: resolution.fallbackPath,
    revision: resolution.revision,
  };
  const warned = options.warned ?? processWarned;
  const dedupeKey = `${warning.configuredPath}\0${warning.fallbackPath}`;
  if (warned.has(dedupeKey)) {
    return;
  }
  warned.add(dedupeKey);
  const message = describeFallback(warning);
  (options.onFallback ?? ((_warning, line) => process.stderr.write(`[browser-path] ${line}\n`)))(warning, message);
}

/** Minimal logger shape — matches the server's pino logger. */
export interface BrowserCheckLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Startup preflight. Only runs in an image that advertises browser connectors
 * (`PDPP_RUNTIME_BROWSER=1`). Reports one line and never throws or blocks
 * startup: a missing browser fails browser connectors, not the whole server.
 */
export function checkBrowserExecutableAtBoot(
  logger: BrowserCheckLogger,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: BrowserExecutableDeps = {},
): BrowserPathResolution | null {
  if (env.PDPP_RUNTIME_BROWSER !== "1") {
    return null;
  }
  let resolution: BrowserPathResolution;
  try {
    resolution = resolveBrowsersPath(env, deps);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "browser preflight could not run");
    return null;
  }
  switch (resolution.kind) {
    case "present":
      logger.info(
        { browsers_path: resolution.browsersPath, chromium_revision: resolution.revision },
        "browser preflight: Chromium executable found for the bundled Patchright",
      );
      break;
    case "fell_back":
      logger.warn(
        {
          chromium_revision: resolution.revision,
          configured_browsers_path: resolution.configuredPath,
          fallback_browsers_path: resolution.fallbackPath,
        },
        `browser preflight: the browsers path in effect has no Chromium revision ${resolution.revision}; connectors fall back to ${resolution.fallbackPath}. Remove the stale PLAYWRIGHT_BROWSERS_PATH from the deployment environment`,
      );
      break;
    case "missing":
      logger.error(
        {
          browsers_path: resolution.browsersPath,
          chromium_revision: resolution.revision,
          expected_executable: resolution.executable,
        },
        `browser preflight: Chromium revision ${resolution.revision} is missing at ${resolution.executable}; browser connectors will fail to launch. Fix PLAYWRIGHT_BROWSERS_PATH or reinstall the image's browsers`,
      );
      break;
    case "unchecked":
      logger.warn({ reason: resolution.reason }, "browser preflight skipped");
      break;
    default:
      break;
  }
  return resolution;
}

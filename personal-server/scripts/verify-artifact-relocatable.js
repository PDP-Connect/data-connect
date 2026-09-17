#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The host-runtime contract for the personal-server sidecar, checked by booting
 * the real artifact somewhere it has never been.
 *
 * WHAT THE HOST MUST PROVIDE
 *
 *   1. A directory holding an unmodified copy of `personal-server/dist` -- the
 *      executable and the `node_modules` tree beside it, together, with their
 *      relative layout and the executable bit intact.
 *   2. A writable `HOME`, or `CONFIG_DIR` naming a writable directory.
 *   3. A free TCP port, via `PORT`.
 *
 * That is the entire list. Not the repository, not `personal-server/node_modules`,
 * not a package manager, not a Node.js installation -- `pkg` embeds the runtime
 * in the executable. Anything else the artifact needs is a defect in the
 * artifact, which is what this script exists to catch.
 *
 * WHAT REMAINS EXTERNAL, AND WHY
 *
 *   - The C library and other base-OS shared libraries the native addons link.
 *     A `.node` addon is a real ELF/Mach-O/PE and cannot be inlined into the
 *     `pkg` snapshot. `pruneUnsatisfiableAddons` in `build.js` already drops the
 *     addons whose libc this build cannot satisfy, so what ships matches the
 *     platform that built it.
 *   - Network reachability of the configured gateway. `/health` answers without
 *     it, which is exactly why `/health` is the probe here.
 *
 * WHY BOOTING IN PLACE IS NOT ENOUGH
 *
 * Running the executable inside its own build tree lets it reach
 * `personal-server/node_modules` by accident. That is how a build shipped
 * `../../../../../node_modules/@opendatalabs/vana-sdk/dist/index.browser.js`,
 * passed its in-place smoke test and four green platform builds, and still died
 * with `Cannot find module` the first time the dist was copied anywhere else.
 * Copying to an unrelated directory first is what makes the check discriminate:
 * it removes the build machine's dependency tree from reach, so any dependence
 * on it becomes a boot failure rather than an invisible pass.
 *
 * Usage: node scripts/verify-artifact-relocatable.js [--dist <path>] [--timeout <seconds>]
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../../scripts/is-main-module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = join(__dirname, '..', 'dist');

function log(message) {
  console.log(`[verify-relocatable] ${message}`);
}

export function parseArgs(argv) {
  const args = { dist: DEFAULT_DIST, timeoutSeconds: 90 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dist') {
      args.dist = argv[++index] ?? '';
    } else if (token === '--timeout') {
      args.timeoutSeconds = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!args.dist) throw new Error('--dist requires a path');
  if (!Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0) {
    throw new Error('--timeout requires a positive number of seconds');
  }
  return args;
}

function executableName() {
  return process.platform === 'win32' ? 'personal-server.exe' : 'personal-server';
}

/**
 * A relocation target with no path relationship to the build tree. The system
 * temporary directory is deliberately not a parent of the repository, so a
 * `../` chain out of the copy cannot climb back into `personal-server/node_modules`
 * -- which is the whole property under test.
 */
function stageRelocatedCopy(dist) {
  const stage = mkdtempSync(join(tmpdir(), 'personal-server-relocated-'));
  cpSync(dist, join(stage, 'artifact'), { recursive: true, verbatimSymlinks: false });
  return stage;
}

async function fetchHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.text();
  return { status: response.status, body };
}

export async function verifyRelocatedArtifact({ dist, timeoutSeconds }) {
  const distPath = resolve(dist);
  const executable = join(distPath, executableName());
  if (!existsSync(executable)) {
    throw new Error(`No built executable at ${executable}. Run the build first.`);
  }

  const stage = stageRelocatedCopy(distPath);
  const artifact = join(stage, 'artifact');
  const configDir = join(stage, 'config');
  // Port 0 is not usable here: the server chooses its own port and this probe
  // has to know it in advance to address /health. A high port picked per run
  // keeps concurrent platform jobs from colliding.
  const port = 20000 + Math.floor(Math.random() * 20000);

  log(`Relocated artifact to ${artifact}`);
  log(`Booting with an isolated HOME and CONFIG_DIR on port ${port}`);

  // A cleared environment is part of the contract: the artifact is given the
  // three inputs the contract names and nothing else, so anything it silently
  // depended on in the build shell shows up as a failure here.
  const child = spawn(join(artifact, executableName()), [], {
    cwd: artifact,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: configDir,
      USERPROFILE: configDir,
      CONFIG_DIR: join(configDir, 'vana'),
      PORT: String(port),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));

  const exited = new Promise(resolveExit => {
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
  });

  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const { code, signal } = await exited;
        throw new Error(
          [
            `The relocated artifact exited (code ${code}, signal ${signal}) before answering /health.`,
            'It depends on something outside its own directory. Output follows:',
            output.trim() || '(no output)',
          ].join('\n')
        );
      }

      try {
        const { status, body } = await fetchHealth(port);
        if (status === 200) {
          log(`HTTP 200 /health from the relocated artifact: ${body.slice(0, 200)}`);
          return { status, body };
        }
        throw new Error(`/health answered HTTP ${status}: ${body.slice(0, 400)}`);
      } catch (error) {
        // Connection refused while the server is still starting is expected;
        // a non-200 answer is a real failure and is rethrown above.
        if (Date.now() > deadline) {
          throw new Error(
            [
              `The relocated artifact did not answer /health within ${timeoutSeconds}s (${error.message}).`,
              output.trim() || '(no output)',
            ].join('\n')
          );
        }
        await new Promise(sleep => setTimeout(sleep, 500));
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(sleep => setTimeout(sleep, 5000))]);
      child.kill('SIGKILL');
    }
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await verifyRelocatedArtifact(args);
  log('The built artifact runs outside its build tree.');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await main().catch(error => {
    console.error(`[verify-relocatable] ${error.message}`);
    process.exit(1);
  });
}

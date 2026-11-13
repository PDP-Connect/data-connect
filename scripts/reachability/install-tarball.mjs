// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const path = process.env.GOZAR_TARBALL;
const expected = process.env.GOZAR_TARBALL_SHA256;
if (!path || !/^[a-f0-9]{64}$/.test(expected ?? '')) {
  throw new Error('Set GOZAR_TARBALL and GOZAR_TARBALL_SHA256; registry installation is not supported by this gate');
}
const absolute = resolve(path);
const actual = createHash('sha256').update(await readFile(absolute)).digest('hex');
if (actual !== expected) throw new Error('Tarball checksum mismatch; nothing installed');
const disk = await statfs(process.cwd());
// Reserve two GB for installation in addition to the mandatory free-space floor.
if (disk.bavail * disk.bsize < 102_000_000_000) throw new Error('Insufficient disk space above the 100 GB floor');
const result = spawnSync('npm', [
  'install', '--allow-git=root', '--no-save', '--package-lock=false',
  '--ignore-scripts', '--omit=optional', absolute,
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

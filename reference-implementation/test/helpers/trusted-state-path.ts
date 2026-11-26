// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { lstatSync } from "node:fs"
import { dirname } from "node:path"

// The reachability library refuses a state directory unless every directory from
// the filesystem root down is owned by the invoking user or root and is not
// group- or world-writable (a root-owned sticky directory may be). This applies
// the same rule, so a test that needs the real library can say why it cannot run.
// The repo's test sandbox maps root-owned directories to an unmapped user, so
// the library refuses every path there, whatever temp directory a test makes.
export function untrustedStatePathReason(path: string): string | null {
  const self = process.getuid?.() ?? 0
  for (let dir = path; ; dir = dirname(dir)) {
    const stat = lstatSync(dir)
    const rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0
    if (!stat.isDirectory()) {
      return `${dir} is not a real directory`
    }
    if ((stat.uid !== 0 && stat.uid !== self) || ((stat.mode & 0o022) !== 0 && !rootSticky)) {
      return `${dir} is owned by uid ${stat.uid} with mode ${(stat.mode & 0o7777).toString(8)}; the library requires the invoking user or root`
    }
    if (dirname(dir) === dir) {
      return null
    }
  }
}

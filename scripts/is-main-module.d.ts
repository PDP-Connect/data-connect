// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Types for is-main-module.js, which stays plain JavaScript so connector
// acceptance installs can copy it alone.

/**
 * Whether `moduleUrl` (a module's `import.meta.url`) is the script Node was
 * started with (`process.argv[1]`), comparing real paths.
 */
export function isMainModule(
  moduleUrl: string,
  argvPath: string | undefined,
  platform?: NodeJS.Platform,
  realpath?: (path: string) => string
): boolean

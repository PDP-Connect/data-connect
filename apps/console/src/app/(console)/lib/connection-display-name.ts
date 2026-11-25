// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the name shown for a connection when the saved value may be its connector key.
 * The rule lives in `@pdpp/display` so the console and the vendored Explore assembler share it.
 */
export { formatConnectionDisplayName as connectionDisplayName } from "@pdpp/display";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { register } from "node:module"

// Node 22/23 loads this module with --import before the connector entrypoint.
// Registering the narrow resolver here is the supported replacement for the
// deprecated --experimental-loader command-line hook.
register(new URL("./connector-loader.mjs", import.meta.url), import.meta.url)

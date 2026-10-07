// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { register } from "node:module"

register(
  new URL("./connector-dependency-loader.mjs", import.meta.url),
  import.meta.url
)

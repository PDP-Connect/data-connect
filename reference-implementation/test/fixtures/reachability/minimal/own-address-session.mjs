// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { run } from "./public-journey.mjs"
await run({ providerId: "own-address", usage: "session" })
process.exit(process.exitCode ?? 0)

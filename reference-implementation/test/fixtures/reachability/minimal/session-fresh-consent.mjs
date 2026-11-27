// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { runConsent } from "./consent-journey.mjs"
await runConsent("session")
process.exit(process.exitCode ?? 0)

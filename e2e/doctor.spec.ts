// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { test } from "@playwright/test"
import { doctor } from "./capture-support.ts"

test("doctor: the disposable owner console and reference services are usable", async ({
  page,
}) => {
  await doctor(page)
})

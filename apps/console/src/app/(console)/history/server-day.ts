// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { cookies } from "next/headers";
import { DAY_COOKIE, personOffset } from "./day-cut.ts";
export async function readPersonOffset(): Promise<number> {
  return personOffset((await cookies()).get(DAY_COOKIE)?.value);
}

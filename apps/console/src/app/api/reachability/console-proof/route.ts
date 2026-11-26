// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { respondToConsoleProof } from "pdpp-reference-implementation/reachability-console-proof";

export function GET(request: Request): Response {
  return respondToConsoleProof(request);
}

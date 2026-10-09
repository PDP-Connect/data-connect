// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Audit seams for mounting the run-control route adapters (run cancel, run
// interaction answer) outside a real server. Every emitted audit event is
// pushed onto `events` so a test can inspect it.

import type { RunControlAuditContext } from "../../server/routes/_run-control.ts";

export function runControlAuditStub(
  events: Record<string, unknown>[] = []
): Omit<RunControlAuditContext<unknown>, "ownerSubjectId"> {
  return {
    createTraceContext: () => ({ request_id: "req_stub", scenario_id: "scn_stub", trace_id: "trc_stub" }),
    emitSpineEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    ensureRequestId: () => "req_stub",
    setReferenceTraceId: () => {
      /* no response headers in adapter tests */
    },
  };
}

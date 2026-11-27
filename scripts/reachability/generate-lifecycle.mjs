// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { writeFile } from "node:fs/promises";
import {
	events,
	initialLifecycle,
	phases,
	reduceLifecycle,
} from "../../reference-implementation/server/reachability/lifecycle.ts";

const destination = process.argv[2];
if (!destination) throw new Error("Pass a diagram output path");
const edges = new Set();
for (const phase of phases)
	for (const type of events)
		for (const stopTombstone of [false, true])
			for (const observed of ["present", "absent", "failed"]) {
				const state = {
					...initialLifecycle(),
					phase,
					stopTombstone,
					handle: { id: "route-one", kind: "attached", generation: 1 },
					operationId: "operation-one",
					approvalIdentity: "review-one",
				};
				const result = reduceLifecycle(state, {
					type,
					observed,
					handle: state.handle,
					operationId: state.operationId,
					approvalIdentity: state.approvalIdentity,
					approvalExpiresAt: 100,
					now: 1,
					epoch: state.epoch,
					confinement: { known: true, value: true },
				});
				if (result.accepted)
					edges.add(
						`  ${phase.replaceAll("-", "_")} --> ${result.state.phase.replaceAll("-", "_")}: ${type}`,
					);
			}
await writeFile(
	destination,
	`stateDiagram-v2\n${[...edges].sort().join("\n")}\n`,
);

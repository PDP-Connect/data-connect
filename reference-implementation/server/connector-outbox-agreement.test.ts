// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {projectLocalDeviceProgress,type HeartbeatRow} from "./connector-outbox-axis.ts";
test("the summary carries the trusted computer name for every source surface",()=>{
 const row={connectorId:"northwind",connectorInstanceId:"practice-source",deviceId:"practice-device",deviceName:"Practice computer",deviceRevokedAt:null,deviceStatus:"active",lastHeartbeatAt:null,lastHeartbeatStatus:null,lastIngestAt:null,manifestGeneration:null,outboxDiagnostics:null,recordsPending:1,sourceInstanceId:"practice-instance",sourceStatus:"active",updatedAt:null} as HeartbeatRow & {deviceName:string};
 assert.equal(projectLocalDeviceProgress([row])?.device_name,"Practice computer");
 assert.equal(projectLocalDeviceProgress([row])?.source_instance_id,"practice-instance");
 assert.equal(projectLocalDeviceProgress([row,{...row,deviceId:"other",deviceName:"Other computer"}])?.device_name,null);
 assert.equal(projectLocalDeviceProgress([row,{...row,sourceInstanceId:"other-instance"}])?.source_instance_id,null);
});

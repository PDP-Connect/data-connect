// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {buildAppPractice} from "../grants/app-practice.ts";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ActivityView,changeSentence, accessChangeHref} from "./activity-view.tsx";
Object.assign(globalThis,{React});
test("an event-only identity never links to a missing app page",()=>{
 const app={...buildAppPractice("one").apps.at(0) as NonNullable<ReturnType<typeof buildAppPractice>["apps"][number]>,grantIds:[]};
 assert.equal(accessChangeHref(app),null);
});
test("access changes resolve service aliases through the shared source name",()=>{
 const app=buildAppPractice("one").apps.at(0) as NonNullable<ReturnType<typeof buildAppPractice>["apps"][number]>;
 const sentence=changeSentence({id:"event",trace_id:"trace",day:"2026-11-25",at:"2026-11-25T12:00:00Z",client_id:"client",change:"allowed",source_id:"whatsapp_web",source_kind:"connector",connection_id:null},app,[{id:"wa",connector:"whatsapp-web",name:"WhatsApp (web)",serviceName:"WhatsApp (web)"}]);
 assert.equal(sentence,`You allowed ${app.name} to read WhatsApp (web).`);
});

test("picker includes current apps plus period readers and excludes other stopped identities",()=>{
 const base=buildAppPractice("one").apps.at(0) as NonNullable<ReturnType<typeof buildAppPractice>["apps"][number]>;
 const apps=[base,{...base,name:"Former reader",hrefId:"former",clientIds:["former"],state:"stopped" as const},{...base,name:"Stopped without reads",hrefId:"stopped",clientIds:["stopped"],state:"stopped" as const}];
 const rows=[{app:apps[1] as NonNullable<typeof apps[number]>,client_id:"former",day:"2026-11-25",reads:1,across_sources:1,sources:[],last_at:"2026-11-25T12:00:00Z",permission_refusals:0}];
 const html=renderToStaticMarkup(React.createElement(ActivityView,{apps,rows,changes:[],sources:[],offset:0}));
 assert.ok(html.includes('<option value="practice-access">ChatGPT'));
 assert.ok(html.includes('<option value="former">Former reader'));
 assert.ok(!html.includes('<option value="stopped">'));
});

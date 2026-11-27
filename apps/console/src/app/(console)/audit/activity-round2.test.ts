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

test("a multi-source permission event separates the past grant from the app's complete current inventory",()=>{
 const [base]=buildAppPractice("one").apps;assert.ok(base);
 const [access]=base.sourceAccess;assert.ok(access);
 const sourceAccess=Array.from({length:5},(_,index)=>({...access,in_force:true,name:`Mail ${index+1}`,source:{...access.source,id:"mail",connector_id:"mail",connection_id:`practice-mail-${index}`}}));
 const app={...base,sourceAccess};
 const sources=sourceAccess.map(row=>({id:row.source.connection_id,connector:"mail",name:row.name}));
 const sentence=changeSentence({id:"event",trace_id:"trace",day:"2026-11-25",at:"2026-11-25T12:00:00Z",client_id:"client",change:"allowed",source_id:null,source_kind:null,connection_id:null,sources:[{source_id:"mail",source_kind:"connector",connection_id:null},{source_id:"old-service",source_kind:"connector",connection_id:null}]},app,sources);
 assert.ok(sentence.endsWith("Now it can read Mail 1, Mail 2, Mail 3 and 2 more."));
});

test("DataConnect's own sync is named as itself, never as 'connector runtime'", () => {
  const base = buildAppPractice("one").apps.at(0) as NonNullable<ReturnType<typeof buildAppPractice>["apps"][number]>;
  const runtime = { ...base, name: "DataConnect connector runtime", clientIds: ["dataconnect-connector-runtime"] };
  const sentence = changeSentence({ id: "e", trace_id: "t", day: "2026-11-25", at: "2026-11-25T12:00:00Z", client_id: "dataconnect-connector-runtime", change: "allowed", source_id: "steam", source_kind: "connector", connection_id: null }, runtime, [{ id: "s", connector: "steam", name: "Steam", serviceName: "Steam" }]);
  assert.doesNotMatch(sentence, /connector runtime/i);
  assert.match(sentence, /DataConnect/);
});

test("the activity page's words use no internal names", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["./activity-view.tsx", "./loading.tsx", "./error.tsx"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /audit events|not what it asked\./, file);
  }
});

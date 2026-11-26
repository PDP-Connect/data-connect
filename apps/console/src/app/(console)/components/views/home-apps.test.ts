// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {StandingOverview} from "./standing-overview.tsx";
import {buildHomeViewModel} from "./standing-view-model.ts";
import {buildDemoInputs} from "./standing-demo-data.ts";
Object.assign(globalThis,{React});
test("Home shows three app names and reading times, then links to the remaining apps",()=>{
 const hrefs={addSource:"/sources/add",connect:"/connect",deployment:"/deployment",deploymentTokens:"/deployment/tokens",grant:(id:string)=>`/grants/${id}`,grants:"/grants",source:(id:string)=>`/sources/${id}`,sources:"/sources"};
 const data=buildHomeViewModel(buildDemoInputs("calm",hrefs));
 data.apps=Array.from({length:8},(_,index)=>({id:`app-${index}`,clientId:`app-${index}`,href:`/grants/app-${index}`,name:`Practice app ${index}`,reads:"Private source name",lastRead:index===0?null:`${index} hours ago`}));
 const html=renderToStaticMarkup(React.createElement(StandingOverview,{data}));
 assert.match(html,/Practice app 0/);assert.match(html,/Practice app 2/);assert.doesNotMatch(html,/Practice app 3|Private source name/);assert.match(html,/and 5 more/);assert.match(html,/Has not read anything yet/);assert.match(html,/8 apps can read your data/);
});

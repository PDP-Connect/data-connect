// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mock,test } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
let refreshes = 0;
mock.module("next/navigation",{exports:{useRouter:()=>({refresh:()=>{refreshes+=1;}})}});
(globalThis as typeof globalThis & { React: typeof React; IS_REACT_ACT_ENVIRONMENT: boolean }).React = React;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
for (const [cookie,expected] of [["",1],["dc-day-offset=120",0],["dc-day-offset=bad",1]] as const) test(`browser day cut handles ${cookie || "no cookie"}`,async()=>{
  const dom = new JSDOM('<div id="root"></div>',{url:"https://console.example"});
  const oldDocument = globalThis.document; const oldWindow = globalThis.window;
  const originalOffset = Date.prototype.getTimezoneOffset;
  Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  Date.prototype.getTimezoneOffset=()=>-120;
  if (cookie) document.cookie=cookie;
  refreshes=0;
  const root=createRoot(document.getElementById("root")!);
  try {
    const {DayCut}=await import("./day-cut-client.tsx");
    await act(async()=>{root.render(<DayCut />);});
    assert.equal(refreshes,expected); assert.match(document.cookie,/dc-day-offset=120/);
  } finally {
    await act(async()=>root.unmount()); Date.prototype.getTimezoneOffset=originalOffset;
    Object.assign(globalThis,{document:oldDocument,window:oldWindow});dom.window.close();
  }
});

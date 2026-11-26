// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
	buildSettingsPractice,
	settingsPracticeNames,
} from "./settings-practice.ts";

mock.module(
	new URL("./owner-password-first-setup-actions.ts", import.meta.url).href,
	{
		namedExports: {
			canOpenOwnerPasswordWindowAction: async () => true,
			requestOwnerPasswordWindowAction: async () => ({ ok: true }),
		},
	},
);
mock.module(new URL("./reachability-client.ts", import.meta.url).href, {
	namedExports: {
		requestReachability: async () => {
			throw Error("Live request in practice");
		},
	},
});
for (const name of settingsPracticeNames) {
	test(`practice ${name} renders the real remote access component from host inputs`, async () => {
		const practice = buildSettingsPractice(name)!;
		const dom = new JSDOM('<div id="root"></div>', {
			url: "http://localhost/settings",
		});
		Object.assign(globalThis, {
			React,
			window: dom.window,
			document: dom.window.document,
			IS_REACT_ACT_ENVIRONMENT: true,
			Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement,
			HTMLButtonElement: dom.window.HTMLButtonElement,
		});
		const { RemoteAccessSetting } = await import("./remote-access-setting.tsx");
		const root = createRoot(dom.window.document.querySelector("#root")!);
		try {
			await act(async () =>
				root.render(
					createElement(RemoteAccessSetting, { request: practice.request }),
				),
			);
			await act(async () => {});
			assert.match(dom.window.document.body.textContent ?? "", practice.expect);
		} finally {
			await act(async () => root.unmount());
			dom.window.close();
		}
	});
}
test("production and unknown addresses cannot select practice data", () => {
	assert.equal(buildSettingsPractice("off", "production"), null);
	assert.equal(buildSettingsPractice("unknown"), null);
});

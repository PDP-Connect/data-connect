// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mountOwnerPasswordDialog } from "../../public/passphrase/dialog.js";

// The markup is the real native window's, so a renamed id or a lost attribute fails here.
const html = readFileSync(resolve(process.cwd(), "public/owner-password.html"), "utf8");
const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script"));

function open(invoke = vi.fn(async () => undefined)) {
  document.body.innerHTML = body;
  mountOwnerPasswordDialog(document, { invoke, clipboard: { writeText: async () => undefined }, generate: () => "alpha-bravo-charlie-delta" });
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  return {
    invoke,
    input: $<HTMLInputElement>("password-input"),
    error: $("error"),
    hint: $("field-hint"),
    own: $<HTMLButtonElement>("own-button"),
    suggested: $<HTMLButtonElement>("suggested-button"),
    copy: $<HTMLButtonElement>("copy-button"),
    submit: async () => {
      $<HTMLFormElement>("password-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await Promise.resolve();
    },
  };
}

describe("the owner password window", () => {
  it("does not leave the length check to the browser's own bubble", () => {
    document.body.innerHTML = body;
    expect(document.getElementById("password-form")?.hasAttribute("novalidate")).toBe(true);
  });

  it("refuses a password that is too short in the error box, stating the minimum, and saves nothing", async () => {
    const dialog = open();
    dialog.own.click();
    dialog.input.value = "abc12345";
    await dialog.submit();
    expect(dialog.error.textContent).toBe("At least 15 characters.");
    expect(dialog.error.classList.contains("visible")).toBe(true);
    expect(dialog.invoke).not.toHaveBeenCalled();
  });

  it("saves a password that is long enough", async () => {
    const dialog = open();
    dialog.own.click();
    dialog.input.value = "a-long-enough-password";
    await dialog.submit();
    expect(dialog.invoke).toHaveBeenCalledWith("set_desktop_owner_password", { password: "a-long-enough-password" });
  });

  it("starts on the suggested password, with no way back offered yet", () => {
    const dialog = open();
    expect(dialog.input.value).toBe("alpha-bravo-charlie-delta");
    expect(dialog.input.readOnly).toBe(true);
    expect(dialog.suggested.hidden).toBe(true);
  });

  it("after Use my own, Use the suggested password brings back the same suggestion", async () => {
    const dialog = open();
    dialog.own.click();
    expect(dialog.input.value).toBe("");
    expect(dialog.input.readOnly).toBe(false);
    expect(dialog.suggested.hidden).toBe(false);
    expect(dialog.suggested.textContent).toBe("Use the suggested password");
    dialog.input.value = "abc";
    await dialog.submit();
    expect(dialog.error.textContent).toBe("At least 15 characters.");
    dialog.suggested.click();
    expect(dialog.input.value).toBe("alpha-bravo-charlie-delta");
    expect(dialog.input.readOnly).toBe(true);
    expect(dialog.suggested.hidden).toBe(true);
    expect(dialog.own.hidden).toBe(false);
    expect(dialog.copy.hidden).toBe(false);
    expect(dialog.error.classList.contains("visible")).toBe(false);
    expect(dialog.hint.textContent).toMatch(/We made a strong one for you/);
    await dialog.submit();
    expect(dialog.invoke).toHaveBeenCalledWith("set_desktop_owner_password", { password: "alpha-bravo-charlie-delta" });
  });
});

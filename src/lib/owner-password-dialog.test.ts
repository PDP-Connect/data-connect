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
    confirm: $<HTMLInputElement>("confirm-input"),
    username: $<HTMLInputElement>("username-input"),
    error: $("error"),
    hint: $("field-hint"),
    toggle: $<HTMLButtonElement>("toggle-button"),
    suggest: $<HTMLButtonElement>("suggest-button"),
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

  it("opens with masked fields, new-password autocomplete, and a username field for password managers", () => {
    const dialog = open();
    expect(dialog.input.type).toBe("password");
    expect(dialog.input.value).toBe("");
    expect(dialog.input.getAttribute("autocomplete")).toBe("new-password");
    expect(dialog.confirm.type).toBe("password");
    expect(dialog.confirm.value).toBe("");
    expect(dialog.confirm.getAttribute("autocomplete")).toBe("new-password");
    expect(dialog.username.getAttribute("autocomplete")).toBe("username");
    expect(dialog.username.value).toBe("owner");
    expect(dialog.toggle.getAttribute("aria-pressed")).toBe("false");
    expect(dialog.toggle.getAttribute("aria-controls")).toContain("password-input");
  });

  it("refuses a password that is too short in the error box, stating the minimum, and saves nothing", async () => {
    const dialog = open();
    dialog.input.value = "abc12345";
    dialog.confirm.value = "abc12345";
    await dialog.submit();
    expect(dialog.error.textContent).toBe("At least 15 characters.");
    expect(dialog.error.classList.contains("visible")).toBe(true);
    expect(dialog.invoke).not.toHaveBeenCalled();
  });

  it("refuses mismatched passwords in the error box and saves nothing", async () => {
    const dialog = open();
    dialog.input.value = "a-long-enough-password";
    dialog.confirm.value = "different-password-123";
    await dialog.submit();
    expect(dialog.error.textContent).toBe("The passwords do not match.");
    expect(dialog.error.classList.contains("visible")).toBe(true);
    expect(dialog.invoke).not.toHaveBeenCalled();
  });

  it("saves a password that is long enough and matches confirmation", async () => {
    const dialog = open();
    dialog.input.value = "a-long-enough-password";
    dialog.confirm.value = "a-long-enough-password";
    await dialog.submit();
    expect(dialog.invoke).toHaveBeenCalledWith("set_desktop_owner_password", { password: "a-long-enough-password" });
  });

  it("Suggest a password fills both fields and reveals them, and toggle button masks again", async () => {
    const dialog = open();
    expect(dialog.input.value).toBe("");
    expect(dialog.confirm.value).toBe("");
    dialog.suggest.click();
    expect(dialog.input.value).toBe("alpha-bravo-charlie-delta");
    expect(dialog.confirm.value).toBe("alpha-bravo-charlie-delta");
    expect(dialog.input.type).toBe("text");
    expect(dialog.confirm.type).toBe("text");
    expect(dialog.toggle.textContent).toBe("Hide");
    expect(dialog.toggle.getAttribute("aria-pressed")).toBe("true");

    dialog.toggle.click();
    expect(dialog.input.type).toBe("password");
    expect(dialog.confirm.type).toBe("password");
    expect(dialog.toggle.textContent).toBe("Show");
    expect(dialog.toggle.getAttribute("aria-pressed")).toBe("false");

    await dialog.submit();
    expect(dialog.invoke).toHaveBeenCalledWith("set_desktop_owner_password", { password: "alpha-bravo-charlie-delta" });
  });
});

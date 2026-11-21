// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { generatePassphrase, ownPasswordProblem } from "./generate.js";

const SAVE_LABEL = "Save password and continue";
const SUGGESTED_HINT =
  "We made a strong one for you. Put it in your password manager; you will need it to sign in on your phone.";

/**
 * The behavior of the native "Set owner password" window (`public/owner-password.html`).
 * The suggested passphrase is the default. "Use my own" swaps it for an empty field,
 * and "Use the suggested password" brings the same suggestion back. A password that is
 * too short is refused in the error box, the same place the shell's other refusals show.
 */
export function mountOwnerPasswordDialog(document, { invoke, clipboard, generate = generatePassphrase }) {
  const form = document.getElementById("password-form");
  const passwordInput = document.getElementById("password-input");
  const fieldLabel = document.getElementById("field-label");
  const fieldHint = document.getElementById("field-hint");
  const toggleButton = document.getElementById("toggle-button");
  const copyButton = document.getElementById("copy-button");
  const ownButton = document.getElementById("own-button");
  const suggestedButton = document.getElementById("suggested-button");
  const button = document.getElementById("submit-button");
  const errorBox = document.getElementById("error");

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add("visible");
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.classList.remove("visible");
  }

  // Copy is the confirmation of the suggestion, so there is no second field for it.
  const suggested = generate();
  function showSuggested() {
    clearError();
    passwordInput.readOnly = true;
    passwordInput.value = suggested;
    passwordInput.type = "text";
    toggleButton.textContent = "Hide";
    fieldLabel.textContent = "Your new password";
    fieldHint.textContent = SUGGESTED_HINT;
    copyButton.textContent = "Copy";
    copyButton.hidden = false;
    ownButton.hidden = false;
    suggestedButton.hidden = true;
  }
  showSuggested();

  toggleButton.addEventListener("click", () => {
    const hidden = passwordInput.type === "password";
    passwordInput.type = hidden ? "text" : "password";
    toggleButton.textContent = hidden ? "Hide" : "Show";
  });

  copyButton.addEventListener("click", async () => {
    try {
      await clipboard.writeText(passwordInput.value);
      copyButton.textContent = "Copied";
    } catch {
      passwordInput.select();
      showError("Copy did not work. Select the password and copy it yourself.");
    }
  });

  ownButton.addEventListener("click", () => {
    clearError();
    passwordInput.readOnly = false;
    passwordInput.value = "";
    passwordInput.focus();
    fieldLabel.textContent = "Your own password";
    fieldHint.textContent = "At least 15 characters. Longer is safer.";
    ownButton.hidden = true;
    copyButton.hidden = true;
    suggestedButton.hidden = false;
  });

  suggestedButton.addEventListener("click", showSuggested);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPassword();
  });

  async function submitPassword() {
    const password = passwordInput.value;
    clearError();
    const problem = ownPasswordProblem(password);
    if (problem) {
      showError(problem);
      return;
    }
    if (typeof invoke !== "function") {
      showError("This window cannot reach DataConnect. Restart the app and try again.");
      return;
    }
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      await invoke("set_desktop_owner_password", { password });
    } catch (error) {
      showError(typeof error === "string" ? error : "Could not set the owner password.");
      button.disabled = false;
      button.textContent = SAVE_LABEL;
    }
  }
}

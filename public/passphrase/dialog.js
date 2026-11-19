// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { generatePassphrase, ownPasswordProblem } from "./generate.js";

const SAVE_LABEL = "Save password and continue";

/**
 * The behavior of the native "Set owner password" window (`public/owner-password.html`).
 * Fields are masked by default. "Suggest a password" fills both the new password and
 * confirm fields and reveals them. Show/Hide toggles masking with aria-pressed.
 */
export function mountOwnerPasswordDialog(document, { invoke, clipboard, generate = generatePassphrase }) {
  const form = document.getElementById("password-form");
  const passwordInput = document.getElementById("password-input");
  const confirmInput = document.getElementById("confirm-input") || document.getElementById("confirmation-input");
  const toggleButton = document.getElementById("toggle-button");
  const copyButton = document.getElementById("copy-button");
  const suggestButton = document.getElementById("suggest-button") || document.getElementById("suggested-button");
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

  // Masked by default, suggestion is no longer pre-filled.
  passwordInput.value = "";
  passwordInput.readOnly = false;
  passwordInput.type = "password";
  if (confirmInput) {
    confirmInput.value = "";
    confirmInput.readOnly = false;
    confirmInput.type = "password";
  }
  if (toggleButton) {
    toggleButton.textContent = "Show";
    toggleButton.setAttribute("aria-pressed", "false");
    toggleButton.setAttribute("aria-controls", "password-input confirm-input");
  }

  toggleButton?.addEventListener("click", () => {
    const isMasked = passwordInput.type === "password";
    const nextType = isMasked ? "text" : "password";
    passwordInput.type = nextType;
    if (confirmInput) confirmInput.type = nextType;
    toggleButton.textContent = isMasked ? "Hide" : "Show";
    toggleButton.setAttribute("aria-pressed", isMasked ? "true" : "false");
  });

  copyButton?.addEventListener("click", async () => {
    try {
      await clipboard.writeText(passwordInput.value);
      copyButton.textContent = "Copied";
    } catch {
      passwordInput.select();
      showError("Copy did not work. Select the password and copy it yourself.");
    }
  });

  suggestButton?.addEventListener("click", () => {
    clearError();
    const suggestion = generate();
    passwordInput.value = suggestion;
    if (confirmInput) confirmInput.value = suggestion;
    passwordInput.type = "text";
    if (confirmInput) confirmInput.type = "text";
    if (toggleButton) {
      toggleButton.textContent = "Hide";
      toggleButton.setAttribute("aria-pressed", "true");
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPassword();
  });

  async function submitPassword() {
    const password = passwordInput.value;
    const confirmation = confirmInput ? confirmInput.value : password;
    clearError();
    const problem = ownPasswordProblem(password);
    if (problem) {
      showError(problem);
      return;
    }
    if (password !== confirmation) {
      showError("The passwords do not match.");
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

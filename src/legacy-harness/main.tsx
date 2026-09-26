// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react"
import ReactDOM from "react-dom/client"
import { LegacyHarnessApp } from "./App"
import "@/styles/index.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LegacyHarnessApp />
  </React.StrictMode>
)

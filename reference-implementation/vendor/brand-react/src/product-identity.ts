// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ProductIdentity {
  build: string
  description: string
  name: string
  protocolName: "PDPP"
  version: string
}

export const DATACONNECT_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
  build: "operator console",
  description: "The DataConnect desktop console for your personal data.",
  name: "DataConnect",
  protocolName: "PDPP",
  version: "0.7.54",
})

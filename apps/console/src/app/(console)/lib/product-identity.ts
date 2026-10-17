// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  DATACONNECT_PRODUCT_IDENTITY,
  type ProductIdentity,
} from "@pdpp/brand-react/product-identity"

/**
 * Server-safe access to the one product identity used by the console. PDPP is
 * the protocol attribution, not an alternate product name for this surface.
 */
export function getProductIdentity(): ProductIdentity {
  return DATACONNECT_PRODUCT_IDENTITY
}

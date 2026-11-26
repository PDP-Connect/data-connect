// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/pin-collection-profiles.ts from the signed connector catalog. Each
// entry was fetched and Sigstore-verified when it was pinned. Regenerate with
// `npm run pin:collection-profiles`; the reference server's copy under
// reference-implementation/server/local-collector-profiles/ changes with it.

import type { CollectionProfilePin } from "../managed/collection-profiles.ts";

/** The Collection Profile releases this collector installs, in definition order. */
export const COLLECTION_PROFILE_PINS: readonly CollectionProfilePin[] = Object.freeze([
  {
    "connectorId": "claude_code",
    "connectorKey": "claude-code",
    "version": "0.3.4",
    "digest": "sha256:08a82d8da8ed4eb70551007141383d3afaa9dd9878afb4fa76543ecfd53ee447",
    "profileSha256": "sha256:1d9f5132894c8c14e5aa296b55f90c60414ef772b0fa6f6b3c0d9b55525b1381",
    "entrypointSha256": "sha256:bbc13637cd863ec774d92c4f43dd926ff5cec39d1abe25d2b881023353f05072"
  },
  {
    "connectorId": "codex",
    "connectorKey": "codex",
    "version": "0.3.3",
    "digest": "sha256:8cbea0c5b56578ab94cc830bd5c69dce77aa5927106f8401d44a84fd3e39fdab",
    "profileSha256": "sha256:f8d1773bb2b856c278748f512aba16fbc993b9a833fbfa9d50c357b7a232776f",
    "entrypointSha256": "sha256:20e26674be1ec1ea64ec13bfa6b62717c85a6e474502e70a9f0e8e225000b6e3"
  },
  {
    "connectorId": "google_takeout",
    "connectorKey": "google-takeout",
    "version": "0.1.3",
    "digest": "sha256:9d1f4934c42cddd73a00b2792ee7edcc389058c566e462a00cd8210fcb014653",
    "profileSha256": "sha256:d645fffba61b0a47a077dc4fe4d04a803481844b3281d333818ab4532d9f01cd",
    "entrypointSha256": "sha256:8eafae144013735b8dc44b6ff40d873feed95cbc934d50c08ad68937306f7d99"
  },
  {
    "connectorId": "imessage",
    "connectorKey": "imessage",
    "version": "0.1.25",
    "digest": "sha256:920246f08102aea9c7958d6b3a0bf89eb07e3b776a921333f6d7ae93f99394b0",
    "profileSha256": "sha256:399958b7d89e1263b5f61e6b09de4c7f5d6a81c1084ff887e75a504278820ef4",
    "entrypointSha256": "sha256:2875a87d04b77e52b9b880a651814112db1b38cd97bd94dab7948a72666670a1"
  },
  {
    "connectorId": "apple_photos",
    "connectorKey": "apple-photos",
    "version": "0.1.3",
    "digest": "sha256:3e58cf196d7fc119fa7f462432d069a257f5e62036a7c70c6b542bb7b779f07f",
    "profileSha256": "sha256:d290a1d201b9b38955225e4b5cae6054a84097723dac8d600e06c5db4676036a",
    "entrypointSha256": "sha256:8a2f1b66106b3574d1b675db9ee754904ac52f00921dfb174ab4ca7ededbaff2"
  },
]);

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
    "version": "0.3.0",
    "digest": "sha256:5b8866392bb11f24cbc3827e37e96faae9b30c8863d7d82bf9cd21aa2e636c82",
    "profileSha256": "sha256:b6398b12d41043706ac4701db92f577ed9964d86b6e4776d471eca65587ae79f",
    "entrypointSha256": "sha256:2a76a5b518c474a2a342bd2511ad825aec289c1310b2575801a419813bb9bea3"
  },
  {
    "connectorId": "codex",
    "connectorKey": "codex",
    "version": "0.3.0",
    "digest": "sha256:bb75129071d1afcf60bf5e20097b84e1262d3cb2ce3ca5b3c228d23f00495d28",
    "profileSha256": "sha256:3287a16b01517439443e8641e97c7f1bfcb358d01641d3b3490331b2ddc107ab",
    "entrypointSha256": "sha256:0ae6336d89b88d50ae6a13d11e62d4b844a623d76cfeb7f83dcd29c889764b3b"
  },
  {
    "connectorId": "google_takeout",
    "connectorKey": "google-takeout",
    "version": "0.1.0",
    "digest": "sha256:38d4bd1312073b167b668cad1701ebc78fea8cf9c19a0edb37a98d11fd660562",
    "profileSha256": "sha256:708f149f0efedae0b41cc3f67a065c541ec6ab5305edb322b9f983a9d0913353",
    "entrypointSha256": "sha256:710d01455fa0cc146665de92612682b749810b54f8f72d5e235a5538c4f43fda"
  },
  {
    "connectorId": "imessage",
    "connectorKey": "imessage",
    "version": "0.1.0",
    "digest": "sha256:ace3798a8e222e73fa1555a39ba52b245e2566d31d84bb60fdec61c9ae1a9ca6",
    "profileSha256": "sha256:654eb8abb9625554c19edcf7e1ef6416fca556929456454ba29277751cde8efb",
    "entrypointSha256": "sha256:aee91cec10278cca82acc000d504420f2135eac2e44838d3b4693d08db5f3d84"
  },
  {
    "connectorId": "apple_photos",
    "connectorKey": "apple-photos",
    "version": "0.1.0",
    "digest": "sha256:0952cef101b05b5416d0ea0620ee12c857f493bae547ce71119a243131741415",
    "profileSha256": "sha256:1d941bd3fc02831618fcd29b899b091ed2ce51f25535f35f58c5a2aaa37ce596",
    "entrypointSha256": "sha256:eccd685d0d5d9b9c675365b0b3073c46028067aac5bceb2719770e5069bf8ca2"
  },
]);

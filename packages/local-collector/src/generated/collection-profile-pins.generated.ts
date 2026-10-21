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
    "version": "0.3.24",
    "digest": "sha256:543fed4139399accba142cc924ff206f2c2795891e3b7f78770fbdf0929b1253",
    "profileSha256": "sha256:b943ac8428442c3d0efc568ed2d7140c9cc1b5916e31c7ce564fd89503988884",
    "entrypointSha256": "sha256:ceba77668a6086877c13bc67f7dce08bd022793ddd3d7682a5294aab95a8e6fd"
  },
  {
    "connectorId": "codex",
    "connectorKey": "codex",
    "version": "0.3.15",
    "digest": "sha256:6df59e78fcfd79cef46c0b3ef512a7bc3c921cf9536cabb647893e7ca131437e",
    "profileSha256": "sha256:d16789f5621bbaab27130c18de00ce4fb46a40f05956af88d5605a14c7e04e13",
    "entrypointSha256": "sha256:0c375ee05d5d59ffd9073f8444a54b9d6feb807329ea5c16e8d28eb1b3772aaf"
  },
  {
    "connectorId": "google_takeout",
    "connectorKey": "google-takeout",
    "version": "0.1.22",
    "digest": "sha256:e023b918a155b469969c262f130496bcab43f16b5ac885959f7cc61094417c23",
    "profileSha256": "sha256:8225a01d3c074eecfe18c05991bdcc27aa6ad21f26935025bc391a66150ce275",
    "entrypointSha256": "sha256:9bd42b0a86f26acff869e96a966b06a584191349017c2f64ab50bc796ddb1f19"
  },
  {
    "connectorId": "imessage",
    "connectorKey": "imessage",
    "version": "0.1.21",
    "digest": "sha256:5e012bda95f6fc921878da8964cb1ffc30941af3ef3e6f1c641acc0f0570fa9e",
    "profileSha256": "sha256:91be3bf41b5203c87b2cb58af82b831a6cb94180905f05649882441bcdaad733",
    "entrypointSha256": "sha256:b126181ed4ca4b7de6693646be305d662a912a4b1c6e72a7f0b258e58a41bde8"
  },
  {
    "connectorId": "apple_photos",
    "connectorKey": "apple-photos",
    "version": "0.1.22",
    "digest": "sha256:bea3370c4a97078c6af499e1712d100a739f81ac5b027352697c4bf8aa22ce93",
    "profileSha256": "sha256:863c066c759496544b70d74e20f7dd46b98b329f1dd6d7b3366820c48dae165b",
    "entrypointSha256": "sha256:a78a90a9040bfcc5b3518c486d8729f2a4b524192a630ea53d45a5ff1a101656"
  },
]);

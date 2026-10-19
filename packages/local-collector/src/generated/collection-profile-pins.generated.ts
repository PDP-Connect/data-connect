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
    "version": "0.3.23",
    "digest": "sha256:30a1fb96c235ed230697aaf2ba37dbfe085f0e2af7c0d58628e6751779516440",
    "profileSha256": "sha256:fe6cab49e033d383024a7d214b722e6f274df2f4bcf027acdd6e120033f75f26",
    "entrypointSha256": "sha256:ae7b66daa0b1bbeeed1c7541ccc8989bd905ddba2fafc9e83fdd2cf63fee3d20"
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
    "version": "0.1.21",
    "digest": "sha256:1130173e6328340ddc9e682c70f7a98f740c1e04e8d17ba2f1600837e46ba8ff",
    "profileSha256": "sha256:85709d3abe622b2e8fa462d04d58f5836f80ac54d6576d3c5c44846ed7a32b1e",
    "entrypointSha256": "sha256:f313e034142164e41cd55d2dbbe8218d29561cf11c23b49ec1023ea0ab010a7b"
  },
  {
    "connectorId": "imessage",
    "connectorKey": "imessage",
    "version": "0.1.20",
    "digest": "sha256:f51ade76da993bab3eed2fb761092bb1dbf3e93f769c5e6886e93dbb4733d821",
    "profileSha256": "sha256:82d80ef4e41aa39ec5df5f333e8a3a72f45a8132bfedb950180b6a0466f3c407",
    "entrypointSha256": "sha256:3696e7fc7137b0bc4d2cf07e8289c542a0b505dfc76cae1d9666ee4857a8cc36"
  },
  {
    "connectorId": "apple_photos",
    "connectorKey": "apple-photos",
    "version": "0.1.21",
    "digest": "sha256:3bd47bd1b7d4ba8f7dd6a182801e9e72d12a9e6555f086a042f6fe7e57552bc1",
    "profileSha256": "sha256:3096fb37a87226c9cb6601c12a1de52a3bed78c5971af574534a608dffbe34b7",
    "entrypointSha256": "sha256:269788dae2745111df882e0b4278b515bdbad64e961028134303771aeaa406c8"
  },
]);
